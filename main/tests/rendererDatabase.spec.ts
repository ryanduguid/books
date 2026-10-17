import test from 'tape';
import { cancelledCode } from './databaseIpcFixture';
import { loadSource } from './helpers';

test('database setup and selector failures show the complete local recovery path', async (t) => {
  const recoveryPath = '/synthetic/' + 'long-name/'.repeat(25) + 'database.db';
  const notifications: unknown[][] = [];
  const error = Object.assign(new Error('primary fixture'), {
    code: 'PRIMARY_FIXTURE',
  });
  let failSetup = true;
  const translate = (strings: TemplateStringsArray) => strings.join('');
  const db = loadSource<any>(
    'src/utils/db.ts',
    { fyo: { t: translate } },
    {
      ipc: {
        getDbRecoveryPath: async () => recoveryPath,
        showError: async (...args: unknown[]) => notifications.push(args),
      },
    }
  );
  const app = loadSource<any>(
    'src/App.vue',
    {
      vue: { defineComponent: (value: unknown) => value },
      './utils/db': db,
      './setup/setupInstance': async () => {
        if (failSetup) throw error;
      },
      'fyo/utils/errors': loadSource<any>('fyo/utils/errors.ts'),
      './initFyo': {
        fyo: { telemetry: { log: () => {} }, config: { set: () => {} } },
      },
      'fyo/telemetry/types': { Verb: { Completed: 'Completed' } },
      'models/types': { ModelNameEnum: { SetupWizard: 'SetupWizard' } },
      'utils/messages': loadSource<any>('utils/messages.ts'),
    },
    {
      ipc: {
        getDbDefaultPath: async () => '/synthetic/company.db',
        getOpenDatabaseFilePath: async () => {
          throw error;
        },
      },
    }
  );
  let fallback = 0;
  let deskCalls = 0;
  const context = {
    showDbSelector: async () => {
      fallback++;
    },
    setDesk: async () => {
      deskCalls++;
      throw error;
    },
  };
  await app.default.methods.setupComplete.call(context, {
    companyName: 'Synthetic',
  });
  await app.default.methods.fileSelected.call(context, '/synthetic/company.db');
  failSetup = false;
  await app.default.methods.setupComplete.call(context, {
    companyName: 'Synthetic',
  });
  t.equal(deskCalls, 1, 'the completion transition is exercised');
  t.equal(fallback, 3, 'all failures return to the selector');
  t.equal(notifications.length, 3);
  for (const [, detail] of notifications) {
    t.ok(String(detail).includes('primary fixture'));
    t.ok(
      String(detail).includes(recoveryPath),
      'the recovery path is not truncated'
    );
  }
  t.equal(error.code, 'PRIMARY_FIXTURE');
  t.end();
});

test('creation cancellation propagates without success side effects', async (t) => {
  const errors = loadSource<any>('fyo/utils/errors.ts');
  const cancellation = Object.assign(new errors.DatabaseError('cancelled'), {
    code: cancelledCode,
  });
  const demux = loadSource<any>(
    'fyo/demux/db.ts',
    {
      'fyo/utils/errors': errors,
      'utils/db/types': { DatabaseDemuxBase: class {} },
    },
    {
      ipc: {
        db: {
          create: async () => ({
            error: {
              name: 'Error',
              message: 'cancelled',
              code: cancelledCode,
              stack: 'backend stack',
            },
          }),
        },
      },
    }
  );
  try {
    await new demux.DatabaseDemux(true).createNewDatabase('target', 'au');
    t.fail('creation cancellation must throw');
  } catch (error) {
    t.ok(error instanceof errors.DatabaseError);
    t.equal((error as any).code, cancelledCode);
    t.equal((error as Error).stack, 'backend stack');
  }
  const events: unknown[] = [];
  const fyo = {
    config: { set: () => events.push('config') },
    store: { skipTelemetryLogging: false },
    telemetry: { log: (...args: unknown[]) => events.push(args) },
    purgeCache: async () => events.push('purge'),
  };
  const mocks = {
    'fyo/utils/errors': errors,
    'utils/messages': loadSource<any>('utils/messages.ts'),
    vue: { defineComponent: (value: unknown) => value },
    'models/types': { ModelNameEnum: { SetupWizard: 'SetupWizard' } },
    'fyo/telemetry/types': {
      Verb: { Completed: 'Completed', Created: 'Created' },
    },
    './initFyo': { fyo },
    'src/initFyo': { fyo },
    './setup/setupInstance': async () => {
      throw cancellation;
    },
    dummy: {
      setupDummyInstance: async () => {
        throw cancellation;
      },
    },
    'src/utils/ui': {
      getSaveDatabasePath: async () => ({
        filePath: 'target',
        canceled: false,
      }),
    },
    'src/utils/db': { addDatabaseRecoveryToError: async () => {} },
    'src/utils/misc': { updateConfigFiles: () => events.push('config') },
  };
  const app = loadSource<any>('src/App.vue', mocks, {
    ipc: { getDbDefaultPath: async () => 'target' },
  });
  await app.default.methods.setupComplete.call(
    {
      showDbSelector: () => events.push('selector'),
      setDesk: () => events.push('desk'),
    },
    { companyName: 'Example' }
  );
  t.deepEqual(
    events,
    ['selector'],
    'setup cancellation returns to the selector without success effects'
  );
  events.length = 0;
  const selector = loadSource<any>('src/pages/DatabaseSelector.vue', mocks);
  const state = {
    creatingDemo: false,
    fyo,
    setFiles: () => events.push('list'),
    $emit: () => events.push('emit'),
  };
  await selector.default.methods.startDummyInstanceSetup.call(state);
  t.equal(state.creatingDemo, false, 'demo cancellation clears loading');
  t.deepEqual(events, [], 'demo cancellation has no success effects');
  const setup = loadSource<any>('src/setup/setupInstance.ts', {
    'src/utils/initialization': {
      initializeInstance: async () => {
        throw cancellation;
      },
    },
    'utils/misc': { getCountryCodeFromCountry: () => 'au' },
  });
  try {
    await setup.default(
      'target',
      { companyName: 'Example', country: 'Australia' },
      fyo
    );
    t.fail('setup must propagate cancellation');
  } catch (error) {
    t.equal(error, cancellation);
  }
  t.equal(
    fyo.store.skipTelemetryLogging,
    false,
    'setup restores telemetry suppression'
  );
  for (const file of ['src/App.vue', 'src/pages/DatabaseSelector.vue']) {
    const failure = new Error('ordinary failure');
    const notices: unknown[] = [];
    const failureSubject = loadSource<any>(
      file,
      {
        ...mocks,
        './setup/setupInstance': async () => {
          throw failure;
        },
        dummy: {
          setupDummyInstance: async () => {
            throw failure;
          },
        },
        'src/utils/db': {
          showDatabaseError: async (error: unknown) => notices.push(error),
        },
        './utils/db': {
          showDatabaseError: async (error: unknown) => notices.push(error),
        },
      },
      { ipc: { getDbDefaultPath: async () => 'target' } }
    );
    if (file.endsWith('App.vue')) {
      await failureSubject.default.methods.setupComplete.call(
        { showDbSelector: () => {} },
        { companyName: 'Example' }
      );
    } else {
      await failureSubject.default.methods.startDummyInstanceSetup.call(state);
      t.equal(state.creatingDemo, false);
    }
    t.equal(
      notices.length,
      1,
      'ordinary failures reach the local error handler'
    );
    t.equal(notices[0], failure, 'the primary error is preserved');
  }
  const successful = {
    ...mocks,
    './setup/setupInstance': async () => {
      events.push('setup');
    },
    dummy: {
      setupDummyInstance: async () => {
        events.push('demo');
      },
    },
  };
  events.length = 0;
  const completedApp = loadSource<any>('src/App.vue', successful, {
    ipc: { getDbDefaultPath: async () => 'target' },
  });
  await completedApp.default.methods.setupComplete.call(
    { setDesk: () => events.push('desk') },
    { companyName: 'Example' }
  );
  t.deepEqual(
    events,
    ['setup', ['Completed', 'SetupWizard'], 'config', 'desk'],
    'successful setup retains its success transitions'
  );
  events.length = 0;
  const completedDemo = loadSource<any>(
    'src/pages/DatabaseSelector.vue',
    successful
  );
  state.$emit = () => events.push(['emit', state.creatingDemo]);
  await completedDemo.default.methods.startDummyInstanceSetup.call(state);
  t.deepEqual(
    events,
    [
      'demo',
      'config',
      'purge',
      'list',
      ['Created', 'dummy-instance'],
      ['emit', false],
    ],
    'successful demo clears loading before emitting selection'
  );
  events.length = 0;
  const wizard = loadSource<any>(
    'src/pages/SetupWizard/SetupWizard.vue',
    mocks
  );
  await wizard.default.methods.submit.call({
    hasDoc: true,
    areAllValuesFilled: true,
    doc: { getValidDict: () => ({ companyName: 'Example' }) },
    loading: false,
    fyo,
    $emit: (name: string) => events.push(name),
  });
  t.deepEqual(
    events,
    ['setup-complete'],
    'submission does not record completion before creation succeeds'
  );
  t.end();
});

test('database picker failures show a local error without success effects', async (t) => {
  const notices: unknown[][] = [];
  const events: unknown[] = [];
  const failure = Object.assign(new Error('selection rejected fixture'), {
    code: 'SELECTION_FIXTURE',
  });
  let cancelled = false;
  const db = loadSource<any>(
    'src/utils/db.ts',
    { fyo: { t: (strings: TemplateStringsArray) => strings.join('') } },
    {
      ipc: {
        getDbRecoveryPath: async () => {
          t.fail('an unselected path has no recovery lookup');
        },
        showError: async (...args: unknown[]) => notices.push(args),
      },
    }
  );
  const selector = loadSource<any>('src/pages/DatabaseSelector.vue', {
    vue: { defineComponent: (value: unknown) => value },
    'src/utils/db': db,
    'fyo/utils/errors': loadSource<any>('fyo/utils/errors.ts'),
    'utils/messages': loadSource<any>('utils/messages.ts'),
    'src/utils/ui': {
      getSaveDatabasePath: async () => {
        if (!cancelled) throw failure;
        return { canceled: true };
      },
      getSelectedFilePath: async () => {
        if (!cancelled) throw failure;
        return { canceled: true, filePaths: [] };
      },
    },
    dummy: { setupDummyInstance: async () => events.push('setup') },
  });
  const state = {
    creatingDemo: false,
    setFiles: async () => events.push('list'),
    $emit: (...args: unknown[]) => events.push(args),
    emitFileSelected: (filePath?: string) => {
      if (filePath) events.push(['file-selected', filePath]);
    },
  };
  for (const method of ['existingDatabase', 'startDummyInstanceSetup']) {
    await selector.default.methods[method].call(state);
    t.equal(state.creatingDemo, false);
  }
  t.equal(notices.length, 2, 'both rejected selections show a native error');
  for (const [, detail] of notices) t.equal(detail, failure.message);
  t.equal(failure.code, 'SELECTION_FIXTURE');
  t.deepEqual(events, [], 'rejected selections produce no success effects');
  cancelled = true;
  for (const method of ['existingDatabase', 'startDummyInstanceSetup'])
    await selector.default.methods[method].call(state);
  t.equal(notices.length, 2, 'cancellation shows no error');
  t.deepEqual(events, [], 'cancellation produces no success effects');
  t.equal(state.creatingDemo, false);
  t.end();
});
