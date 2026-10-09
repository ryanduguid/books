import {
  existsSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'tape';
import ts from 'typescript';
import { runInNewContext } from 'vm';

const root = path.resolve(__dirname, '../..');
const cancelledCode = 'ERR_DB_CREATE_CANCELLED';

function loadSource(
  file: string,
  mocks: Record<string, unknown> = {},
  globals = {}
) {
  let source = readFileSync(path.join(root, file), 'utf8');
  if (file.endsWith('.vue')) {
    source = source.split('<script lang="ts">')[1].split('</script>')[0];
  }
  const exports = {};
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  });
  runInNewContext(outputText, {
    exports,
    require: (name: string) => mocks[name] ?? {},
    ...globals,
  });
  return exports as any;
}

function getHandlers(unlinkFile?: (filePath: string) => Promise<void>) {
  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  const calls: {
    unlink: string[];
    create: unknown[][];
    language: string[];
    dialogs: any[];
  } = {
    unlink: [],
    create: [],
    language: [],
    dialogs: [],
  };
  let response = 0;
  let unlinkError: Error | undefined;
  let onDialog = () => {};
  const window = { isDestroyed: () => false };
  const main = { mainWindow: window };
  const messages = loadSource('utils/messages.ts');
  const helpers = loadSource('main/helpers.ts');
  const listener = loadSource('main/registerIpcMainActionListeners.ts', {
    electron: {
      ipcMain: {
        handle: (name: string, handler: any) => {
          handlers[name] = handler;
        },
      },
      dialog: {
        showMessageBox: async (parent: unknown, options: unknown) => {
          calls.dialogs.push({ parent, options });
          onDialog();
          return { response };
        },
      },
    },
    'fs-extra': {
      unlink: async (value: string) => {
        calls.unlink.push(value);
        if (unlinkError) throw unlinkError;
        await unlinkFile?.(value);
      },
    },
    path,
    '../utils/messages': messages,
    './helpers': helpers,
    '../backend/database/manager': {
      createNewDatabase: async (...args: unknown[]) => {
        calls.create.push(args);
        return args[1];
      },
    },
    './getLanguageMap': {
      getLanguageMap: async (code: string) => {
        calls.language.push(code);
        return { hello: code };
      },
    },
  });
  listener.default(main);
  return {
    handlers,
    calls,
    main,
    window,
    approve: () => {
      response = 1;
    },
    rejectWith: (value: number) => {
      response = value;
    },
    failUnlink: (error: Error) => {
      unlinkError = error;
    },
    duringDialog: (callback: () => void) => {
      onDialog = callback;
    },
  };
}

test('filesystem IPC requires native consent for the captured target', async (t) => {
  for (const action of ['delete-file', 'db-create']) {
    for (const invalid of [undefined, null, {}, [], 1, '', 'db\0target']) {
      const fixture = getHandlers();
      const response = await fixture.handlers[action](null, invalid, 'au');
      t.ok(
        response.error?.name,
        `${action} rejects ${JSON.stringify(invalid)}`
      );
      t.equal(fixture.calls.dialogs.length, 0, 'invalid input has no dialog');
      t.equal(
        fixture.calls.unlink.length + fixture.calls.create.length,
        0,
        'invalid input has no operation'
      );
    }
    for (const choice of [0, -1, 2]) {
      const fixture = getHandlers();
      fixture.rejectWith(choice);
      const response = await fixture.handlers[action](
        null,
        '../outside/target',
        'au'
      );
      t.equal(
        fixture.calls.unlink.length + fixture.calls.create.length,
        0,
        'cancel has no operation'
      );
      t.equal(
        response.error?.code,
        action === 'db-create' ? cancelledCode : undefined,
        'cancellation retains the response contract'
      );
      const { options, parent } = fixture.calls.dialogs[0];
      t.equal(
        parent,
        fixture.window,
        'confirmation is parented to the main window'
      );
      t.deepEqual(Array.from(options.buttons), [
        'Cancel',
        action === 'db-create' ? 'Create' : 'Delete',
      ]);
      t.equal(options.defaultId, 0, 'Cancel is the default');
      t.equal(options.cancelId, 0, 'Escape cancels');
    }
    for (const input of [
      '../outside/arbitrary.txt',
      'dbs/Frappe Books/company',
      '   ',
      './:memory:',
      'db\n\u202e\u0085target',
    ]) {
      const fixture = getHandlers();
      fixture.approve();
      const response = await fixture.handlers[action](null, input, 'au');
      t.notOk(response.error, 'approved operation succeeds');
      const used =
        action === 'delete-file'
          ? fixture.calls.unlink[0]
          : fixture.calls.create[0][0];
      t.equal(
        used,
        path.resolve(input),
        'the captured absolute path reaches the sink'
      );
      const detail = fixture.calls.dialogs[0].options.detail;
      t.equal(
        JSON.parse(detail.slice('Filesystem path: '.length)),
        used,
        'the displayed path identifies the sink target'
      );
      t.notOk(
        /[\n\r\u202e\u0085]/.test(detail),
        'control and direction characters are escaped'
      );
      if (action === 'db-create')
        t.equal(response.data, 'au', 'country-code success data is preserved');
    }
    for (const destroy of [true, false]) {
      const fixture = getHandlers();
      fixture.approve();
      fixture.duringDialog(() => {
        if (destroy) fixture.window.isDestroyed = () => true;
        else fixture.main.mainWindow = { isDestroyed: () => false };
      });
      await fixture.handlers[action](null, 'target', 'au');
      t.equal(
        fixture.calls.unlink.length + fixture.calls.create.length,
        0,
        'window lifecycle changes revoke consent'
      );
    }
  }
  for (const code of ['ENOENT', 'EBUSY', 'EPERM', 'OTHER']) {
    const fixture = getHandlers();
    fixture.approve();
    fixture.failUnlink(Object.assign(new Error(code), { code }));
    const response = await fixture.handlers['delete-file'](null, 'target');
    t.equal(response.error.code, code, 'unlink errors preserve their code');
    t.equal(
      response.error.message,
      code,
      'unlink errors preserve their message'
    );
  }
  t.end();
});

test('a disposable file survives cancellation and is deleted only after approval', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'books-ipc-'));
  const target = path.join(directory, 'sentinel.txt');
  writeFileSync(target, 'fixture');
  try {
    const fixture = getHandlers(fs.unlink);
    const cancelled = await fixture.handlers['delete-file'](null, target);
    t.notOk(cancelled.error);
    t.ok(existsSync(target), 'cancellation preserves the actual file');
    fixture.approve();
    const approved = await fixture.handlers['delete-file'](null, target);
    t.notOk(approved.error);
    t.notOk(existsSync(target), 'approval unlinks the actual captured target');
  } finally {
    if (existsSync(target)) unlinkSync(target);
    rmdirSync(directory);
  }
  t.end();
});

test('in-memory creation never reaches the filesystem deletion helper', async (t) => {
  const fixture = getHandlers();
  const response = await fixture.handlers['db-create'](null, ':memory:', 'au');
  t.equal(fixture.calls.dialogs.length, 0);
  t.deepEqual(fixture.calls.create, [[':memory:', 'au']]);
  t.equal(response.data, 'au');
  const unlinked: string[] = [];
  const { DatabaseManager } = loadSource('backend/database/manager.ts', {
    'utils/db/types': { DatabaseDemuxBase: class {} },
    '../helpers': {
      unlinkIfExists: async (value: string) => {
        unlinked.push(value);
      },
    },
  });
  const manager = new DatabaseManager();
  manager._connect = async (_: string, mode: string, country: string) => {
    t.equal(mode, 'create', 'approved creation uses the creation open mode');
    return country;
  };
  t.equal(await manager.createNewDatabase(':memory:', 'au'), 'au');
  t.deepEqual(unlinked, [], 'the backend also excludes the in-memory filename');
  await manager.createNewDatabase('./:memory:', 'au');
  t.deepEqual(
    unlinked,
    ['./:memory:'],
    'a similar disk filename retains ordinary creation semantics'
  );
  t.end();
});

test('language IPC rejects alternate traversal forms and preserves shipped codes', async (t) => {
  const fixture = getHandlers();
  for (const code of ['en', 'np', 'ca-ES', 'zh-CN', 'zh-Hant']) {
    t.deepEqual(
      JSON.parse(
        JSON.stringify(await fixture.handlers['get-language-map'](null, code))
      ),
      {
        languageMap: { hello: code },
        success: true,
        message: '',
      }
    );
  }
  const invalid = [
    '../en',
    '..\\en',
    '/en',
    '%2e%2e%2fen',
    'en?x',
    'en#x',
    'en.csv',
    'en\n',
    'en\r',
    'en\u2028',
    'en\0',
    '',
    {},
    [],
    1,
    null,
  ];
  for (const code of invalid) {
    const response = await fixture.handlers['get-language-map'](null, code);
    t.deepEqual(JSON.parse(JSON.stringify(response)), {
      languageMap: {},
      success: false,
      message: 'Invalid language code.',
    });
  }
  t.deepEqual(
    fixture.calls.language,
    ['en', 'np', 'ca-ES', 'zh-CN', 'zh-Hant'],
    'invalid inputs never reach the path helper'
  );
  t.end();
});

test('creation cancellation propagates without success side effects', async (t) => {
  const errors = loadSource('fyo/utils/errors.ts');
  const cancellation = Object.assign(new errors.DatabaseError('cancelled'), {
    code: cancelledCode,
  });
  const demux = loadSource(
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
    'utils/messages': loadSource('utils/messages.ts'),
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
      getSavePath: async () => ({ filePath: 'target', canceled: false }),
    },
    'src/utils/misc': { updateConfigFiles: () => events.push('config') },
  };
  const app = loadSource('src/App.vue', mocks, {
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
  const selector = loadSource('src/pages/DatabaseSelector.vue', mocks);
  const state = {
    creatingDemo: false,
    fyo,
    setFiles: () => events.push('list'),
    $emit: () => events.push('emit'),
  };
  await selector.default.methods.startDummyInstanceSetup.call(state);
  t.equal(state.creatingDemo, false, 'demo cancellation clears loading');
  t.deepEqual(events, [], 'demo cancellation has no success effects');
  const setup = loadSource('src/setup/setupInstance.ts', {
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
    const subject = loadSource(
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
      },
      { ipc: { getDbDefaultPath: async () => 'target' } }
    );
    try {
      if (file.endsWith('App.vue'))
        await subject.default.methods.setupComplete.call(
          {},
          { companyName: 'Example' }
        );
      else await subject.default.methods.startDummyInstanceSetup.call(state);
      t.fail('ordinary failures must propagate');
    } catch (error) {
      t.equal(error, failure);
    }
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
  const completedApp = loadSource('src/App.vue', successful, {
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
  const completedDemo = loadSource(
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
  const wizard = loadSource('src/pages/SetupWizard/SetupWizard.vue', mocks);
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
