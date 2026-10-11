import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import test from 'tape';
import { loadSource } from './helpers';

const cancelledCode = 'ERR_DB_CREATE_CANCELLED';
const databaseActions = {
  create: 'db-create',
  connect: 'db-connect',
  delete: 'delete-file',
} as const;

function getHandlers(directory?: string, databaseManager?: object) {
  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  const calls = {
    unlink: [] as string[],
    create: [] as unknown[][],
    connect: [] as unknown[][],
    dbCalls: [] as unknown[][],
    language: [] as string[],
    dialogs: [] as any[],
    selections: [] as any[],
    directories: [] as string[],
    pdf: 0,
  };
  let response = 0;
  let selectionCancelled = false;
  let selectedPath = '';
  let unlinkError: Error | undefined;
  let onDialog: () => Promise<void> | void = () => {};
  const frame = {};
  const sender = { isDestroyed: () => false, mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: sender };
  const main = { mainWindow: window };
  const event = { sender, senderFrame: frame };
  const messages = loadSource<any>('utils/messages.ts');
  const helpers = loadSource<any>('main/helpers.ts');
  function bounded(value: string) {
    if (!directory)
      throw new Error('Filesystem operation has no test fixture.');
    const relative = path.relative(directory, value);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
      throw new Error('Filesystem operation escaped the test fixture.');
    }
  }
  const files = loadSource<any>('backend/database/files.ts', {
    'fs/promises': {
      ...fs,
      mkdir: async (value: string) => {
        bounded(value);
        calls.directories.push(value);
        await fs.mkdir(value);
      },
    },
    path,
    'better-sqlite3': class {
      pragma() {
        return [{ quick_check: 'ok' }];
      }
      close() {}
    },
  });
  const authority = loadSource<any>('main/databasePathAuthority.ts', {
    '../backend/database/files': files,
  });
  const listener = loadSource<any>('main/registerIpcMainActionListeners.ts', {
    electron: {
      app: { getPath: () => directory ?? 'documents' },
      ipcMain: {
        handle: (name: string, handler: any) => {
          handlers[name] = handler;
        },
      },
      dialog: {
        showMessageBox: async (parent: unknown, options: unknown) => {
          calls.dialogs.push({ parent, options });
          await onDialog();
          return { response };
        },
        showOpenDialog: async (parent: unknown, options: unknown) => {
          calls.selections.push({ parent, options });
          await onDialog();
          return {
            canceled: selectionCancelled,
            filePaths: selectedPath ? [selectedPath] : [],
          };
        },
        showSaveDialog: async (parent: unknown, options: unknown) => {
          calls.selections.push({ parent, options });
          await onDialog();
          return {
            canceled: selectionCancelled,
            filePath: selectedPath || undefined,
          };
        },
      },
    },
    'fs-extra': {
      pathExists: async (value: string) =>
        fs
          .access(value)
          .then(() => true)
          .catch(() => false),
      unlink: async (value: string) => {
        bounded(value);
        calls.unlink.push(value);
        if (unlinkError) throw unlinkError;
        await fs.unlink(value);
      },
    },
    path,
    '../utils/messages': messages,
    './helpers': helpers,
    './saveHtmlAsPdf': {
      saveHtmlAsPdf: async () => {
        calls.pdf++;
        return Buffer.from('pdf fixture');
      },
    },
    './databasePathAuthority': authority,
    './exportPathAuthority': loadSource<any>('main/exportPathAuthority.ts', {
      'fs/promises': fs,
      path,
      crypto: { randomUUID },
      '../backend/database/files': files,
      './helpers': helpers,
      electron: {
        dialog: {
          showSaveDialog: async (parent: unknown, options: unknown) => {
            calls.selections.push({ parent, options });
            await onDialog();
            return {
              canceled: selectionCancelled,
              filePath: selectedPath || undefined,
            };
          },
          showMessageBox: async (parent: unknown, options: unknown) => {
            calls.dialogs.push({ parent, options });
            await onDialog();
            return { response };
          },
        },
      },
    }),
    '../utils/config': { get: () => [] },
    '../backend/database/files': files,
    '../backend/database/manager': databaseManager ?? {
      getProtectedDatabasePaths: () => [],
      createNewDatabase: async (...args: any[]) => {
        calls.create.push(args);
        args[3]?.();
        if (args[0] !== ':memory:') {
          bounded(args[0]);
          await fs.writeFile(args[0], 'synthetic database');
        }
        return args[1];
      },
      connectToDatabase: async (...args: any[]) => {
        calls.connect.push(args);
        args[2]?.();
        return args[1] ?? 'au';
      },
      call: async (...args: unknown[]) => {
        calls.dbCalls.push(args);
        return 'synthetic result';
      },
      callBespoke: async (...args: unknown[]) => {
        calls.dbCalls.push(args);
        return 'synthetic result';
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
    event,
    invoke: (
      operation: keyof typeof databaseActions,
      target: string,
      country = 'au'
    ) => handlers[databaseActions[operation]](event, target, country),
    approve: () => {
      response = 1;
    },
    rejectWith: (value: number) => {
      response = value;
    },
    failUnlink: (error: Error) => {
      unlinkError = error;
    },
    duringDialog: (callback: () => Promise<void> | void) => {
      onDialog = callback;
    },
    select: (value: string, cancelled = false) => {
      selectedPath = value;
      selectionCancelled = cancelled;
    },
    grant: async (
      operation: 'create' | 'connect' | 'delete',
      value: string
    ) => {
      selectedPath = value;
      selectionCancelled = false;
      if (operation === 'create')
        return handlers['save-database-dialog'](event);
      return handlers['open-database-dialog'](event, operation);
    },
  };
}

async function withFixture(run: (directory: string) => Promise<void>) {
  const temporaryRoot = await fs.realpath(tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'books-ipc-'));
  try {
    await run(directory);
  } finally {
    const resolved = await fs.realpath(directory);
    if (
      resolved !== path.resolve(directory) ||
      path.dirname(resolved) !== temporaryRoot ||
      !path.basename(directory).startsWith('books-ipc-')
    ) {
      throw new Error('Unexpected fixture cleanup path.');
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('recovery IPC reads only cached paths for the active main frame', async (t) => {
  let filesystemLookups = 0;
  const { DatabaseManager } = loadSource<any>('backend/database/manager.ts', {
    path,
    fs: {
      realpathSync: () => {
        filesystemLookups++;
        throw new Error('Recovery IPC must not resolve filesystem paths.');
      },
    },
    'utils/db/types': { DatabaseDemuxBase: class {} },
    './files': { backupDatabase: async () => 'retained original fixture' },
  });
  const manager = new DatabaseManager();
  const selectedPath = path.resolve('/synthetic/company.db');
  await manager.retainRecovery(selectedPath);
  const fixture = getHandlers(undefined, manager);
  const lookup = fixture.handlers['get-db-recovery-path'];
  t.equal(lookup(fixture.event, selectedPath), 'retained original fixture');
  t.equal(lookup(fixture.event, '/unregistered/database.db'), undefined);
  t.equal(
    lookup(fixture.event, String.raw`\\fixture.invalid\share\database.db`),
    undefined,
    'UNC-shaped input is tested without contacting a share'
  );
  for (const invalid of ['', 'invalid\0path']) {
    t.throws(() => lookup(fixture.event, invalid), /Invalid database path/);
  }
  t.throws(
    () => lookup({ ...fixture.event, senderFrame: {} }, selectedPath),
    /active main window sender/
  );
  t.equal(filesystemLookups, 0, 'no lookup reaches the filesystem');
  t.end();
});

test('default database selection writes only after creation approval', async (t) => {
  await withFixture(async (directory) => {
    const fixture = getHandlers(directory);
    const target = await fixture.handlers['get-db-default-path'](
      fixture.event,
      'Synthetic Company'
    );
    t.equal(
      target,
      path.join(directory, 'Frappe Books', 'Synthetic Company.books.db')
    );
    t.deepEqual(
      await fs.readdir(directory),
      [],
      'path discovery creates no directories'
    );
    const cancelled = await fixture.handlers['db-create'](
      fixture.event,
      target,
      'au'
    );
    t.equal(cancelled.error?.code, cancelledCode);
    t.deepEqual(
      await fs.readdir(directory),
      [],
      'Cancel leaves the filesystem empty'
    );
    t.equal(
      fixture.calls.create.length,
      0,
      'Cancel does not create a database'
    );
    await fixture.handlers['get-db-default-path'](
      fixture.event,
      'Synthetic Company'
    );
    fixture.approve();
    const approved = await fixture.handlers['db-create'](
      fixture.event,
      target,
      'au'
    );
    t.notOk(approved.error);
    t.equal(approved.data, 'au', 'country-code success data is preserved');
    t.deepEqual(await fs.readdir(directory), ['Frappe Books']);
    t.deepEqual(await fs.readdir(path.dirname(target)), [
      path.basename(target),
    ]);
    t.equal(
      fixture.calls.create.length,
      1,
      'approval reaches database creation'
    );
    t.deepEqual(fixture.calls.directories, [path.dirname(target)]);
    t.ok(
      (await fixture.handlers['db-create'](fixture.event, target, 'au')).error,
      'creation grant cannot be replayed'
    );
  });
  t.end();
});

test('database authority rejects invalid paths, senders and operation mismatches', async (t) => {
  await withFixture(async (directory) => {
    const target = path.join(directory, 'external arbitrary name');
    await fs.writeFile(target, 'synthetic database');
    for (const action of ['delete-file', 'db-create', 'db-connect']) {
      for (const invalid of [undefined, null, {}, [], 1, '', 'db\0target']) {
        const fixture = getHandlers(directory);
        t.ok(
          (await fixture.handlers[action](fixture.event, invalid, 'au')).error,
          `${action} rejects ${JSON.stringify(invalid)}`
        );
        t.equal(
          fixture.calls.dialogs.length,
          0,
          'invalid input has no confirmation'
        );
        t.equal(
          fixture.calls.unlink.length +
            fixture.calls.create.length +
            fixture.calls.connect.length,
          0,
          'invalid input has no effect'
        );
      }
      for (const invalidEvent of [
        null,
        {},
        { sender: {} },
        { sender: {}, senderFrame: {} },
      ]) {
        const fixture = getHandlers(directory);
        await fixture.grant(
          action === 'db-create'
            ? 'create'
            : action === 'db-connect'
            ? 'connect'
            : 'delete',
          target
        );
        t.ok(
          (await fixture.handlers[action](invalidEvent, target, 'au')).error,
          `${action} rejects mismatched sender`
        );
        t.equal(fixture.calls.dialogs.length, 0);
      }
      const fixture = getHandlers(directory);
      fixture.approve();
      t.ok(
        (await fixture.handlers[action](fixture.event, target, 'au')).error,
        'raw paths have no authority'
      );
      await fixture.grant(
        action === 'db-create' ? 'connect' : 'create',
        target
      );
      t.ok(
        (await fixture.handlers[action](fixture.event, target, 'au')).error,
        'operation mismatch has no authority'
      );
      t.equal(
        fixture.calls.unlink.length +
          fixture.calls.create.length +
          fixture.calls.connect.length,
        0
      );
    }
    t.equal(await fs.readFile(target, 'utf8'), 'synthetic database');
  });
  t.end();
});

test('export IPC refuses missing grants before rendering and permits only one PDF redemption', async (t) => {
  await withFixture(async (directory) => {
    const f = getHandlers(directory);
    const target = path.join(directory, 'report.pdf');
    for (const action of ['save-data', 'save-html-as-pdf']) {
      try {
        await f.handlers[action](f.event, 'content', target, 20, 30);
        t.fail('unselected writer must reject');
      } catch {
        t.pass('unselected writer rejected');
      }
    }
    t.equal(f.calls.pdf, 0, 'no print resources acquired for unselected PDF');
    t.deepEqual(await fs.readdir(directory), []);
    f.select(target);
    f.approve();
    const selection = await f.handlers['save-dialog'](f.event, 'report', 'pdf');
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        f.handlers['save-html-as-pdf'](
          f.event,
          'content',
          selection.filePath,
          20,
          30,
          selection.grantId
        )
      )
    );
    t.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1
    );
    t.equal(results.filter((result) => result.status === 'rejected').length, 1);
    t.equal(f.calls.pdf, 1);
    t.equal(await fs.readFile(target, 'utf8'), 'pdf fixture');
  });
  t.end();
});

test('generic selectors grant no database authority; native database selection permits external paths', async (t) => {
  await withFixture(async (directory) => {
    const target = path.join(directory, 'external arbitrary name');
    await fs.writeFile(target, 'synthetic database');
    const fixture = getHandlers(directory);
    fixture.select(target);
    await fixture.handlers['open-dialog'](fixture.event, {});
    await fixture.handlers['save-dialog'](
      fixture.event,
      'external arbitrary name',
      'csv'
    );
    for (const action of ['db-connect', 'db-create', 'delete-file']) {
      t.ok(
        (await fixture.handlers[action](fixture.event, target, 'au')).error,
        `${action} rejects generic selection`
      );
    }
    const selected = await fixture.handlers['open-database-dialog'](
      fixture.event,
      'connect',
      target
    );
    t.equal(
      selected.filePaths[0],
      target,
      'unknown remembered path requires native re-selection'
    );
    t.equal(fixture.calls.selections.length, 3);
    t.equal(fixture.calls.selections[2].parent, fixture.window);
    const connected = await fixture.handlers['db-connect'](
      fixture.event,
      selected.filePaths[0],
      'au'
    );
    t.notOk(connected.error);
    t.equal(connected.data, 'au');
    t.equal(fixture.calls.connect[0][0], target);
    const substitute = path.join(directory, 'substitute');
    await fs.writeFile(substitute, 'unrelated sentinel');
    t.ok(
      (await fixture.handlers['db-connect'](fixture.event, substitute)).error,
      'path substitution is rejected'
    );
    t.equal(await fs.readFile(substitute, 'utf8'), 'unrelated sentinel');
  });
  t.end();
});

test('parent-alias database selections grant only the returned canonical pathname', async (t) => {
  await withFixture(async (directory) => {
    const parent = path.join(directory, 'real-parent');
    const alias = path.join(directory, 'parent-alias');
    await fs.mkdir(parent);
    try {
      await fs.symlink(parent, alias, 'dir');
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      ) {
        throw error;
      }
      t.skip('parent symlink requires Windows privilege');
      return;
    }
    await fs.writeFile(path.join(directory, 'sentinel'), 'unrelated');
    for (const operation of ['create', 'connect', 'delete'] as const) {
      const lexical = path.join(alias, operation + '.db');
      const canonical = path.join(parent, operation + '.db');
      if (operation !== 'create')
        await fs.writeFile(canonical, 'synthetic database');
      const fixture = getHandlers(directory);
      const selection = await fixture.grant(operation, lexical);
      const selectedPath =
        operation === 'create' ? selection.filePath : selection.filePaths[0];
      t.equal(
        selectedPath,
        canonical,
        'selector returns the canonical grant key'
      );
      const refused = await fixture.invoke(operation, lexical);
      t.ok(
        refused.error?.message.includes('no authority'),
        'original lexical alias fails exact lookup'
      );
      t.equal(
        fixture.calls.dialogs.length,
        0,
        'ungranted alias gets no confirmation'
      );
      t.equal(
        fixture.calls.create.length +
          fixture.calls.connect.length +
          fixture.calls.unlink.length,
        0
      );
      fixture.approve();
      t.notOk(
        (await fixture.invoke(operation, selectedPath)).error,
        'canonical grant succeeds'
      );
      if (operation === 'create') {
        t.equal(fixture.calls.create[0][0], canonical);
        t.equal(await fs.readFile(canonical, 'utf8'), 'synthetic database');
      } else if (operation === 'connect') {
        t.equal(fixture.calls.connect[0][0], canonical);
        t.equal(await fs.readFile(canonical, 'utf8'), 'synthetic database');
      } else {
        t.deepEqual(fixture.calls.unlink, [canonical]);
        t.notOk((await fs.readdir(parent)).includes('delete.db'));
      }
    }
    t.equal(
      await fs.readFile(path.join(directory, 'sentinel'), 'utf8'),
      'unrelated'
    );
  });
  t.end();
});

test('connected database writes remain bound to the originating window, sender and entry', async (t) => {
  await withFixture(async (directory) => {
    const target = path.join(directory, 'database');
    await fs.writeFile(target, 'synthetic database');
    const fixture = getHandlers(directory);
    t.notOk(
      (await fixture.handlers['db-call'](fixture.event, 'close')).error,
      'closing before demo or setup is a safe no-op'
    );
    fixture.calls.dbCalls.length = 0;
    await fixture.grant('connect', target);
    await fixture.invoke('connect', target);
    for (const action of ['db-call', 'db-bespoke']) {
      t.ok((await fixture.handlers[action](null, 'update')).error);
      t.ok(
        (
          await fixture.handlers[action](
            { sender: {}, senderFrame: {} },
            'update'
          )
        ).error
      );
      t.equal(
        (await fixture.handlers[action](fixture.event, 'update')).data,
        'synthetic result'
      );
    }
    t.equal(fixture.calls.dbCalls.length, 2);
    await fs.rename(target, target + '.retained');
    await fs.writeFile(target, 'replacement sentinel');
    t.ok(
      (await fixture.handlers['db-call'](fixture.event, 'update')).error,
      'entry replacement prevents subsequent writes'
    );
    t.equal(fixture.calls.dbCalls.length, 2);
    t.equal(await fs.readFile(target, 'utf8'), 'replacement sentinel');
    t.notOk(
      (await fixture.handlers['db-call'](fixture.event, 'close')).error,
      'owned handle cleanup remains available after entry replacement'
    );
    await fixture.grant('connect', target);
    await fixture.invoke('connect', target);
    fixture.main.mainWindow = { ...fixture.window };
    t.ok(
      (await fixture.handlers['db-call'](fixture.event, 'update')).error,
      'window replacement revokes connection use'
    );
  });
  t.end();
});

test('default database names cannot escape their root', async (t) => {
  await withFixture(async (directory) => {
    const fixture = getHandlers(directory);
    for (const name of [
      '../outside',
      '..\\outside',
      '/outside',
      'C:\\outside',
      '.',
      '..',
      '',
      ' ',
      'CON',
      'name\0suffix',
      'name\n',
    ]) {
      try {
        await fixture.handlers['get-db-default-path'](fixture.event, name);
        t.fail(`accepted invalid name ${JSON.stringify(name)}`);
      } catch {
        t.pass(`rejects ${JSON.stringify(name)}`);
      }
    }
    t.deepEqual(
      await fs.readdir(directory),
      [],
      'invalid discovery is write-free'
    );
    t.equal(fixture.calls.dialogs.length, 0);
  });
  t.end();
});

test('native Cancel is write-free and approval uses the displayed captured database', async (t) => {
  await withFixture(async (directory) => {
    for (const operation of ['create', 'delete'] as const) {
      for (const choice of [0, -1, 2]) {
        const target = path.join(directory, `${operation}-${choice}`);
        if (operation === 'delete') await fs.writeFile(target, 'fixture');
        const fixture = getHandlers(directory);
        await fixture.grant(operation, target);
        fixture.rejectWith(choice);
        const result = await fixture.invoke(operation, target);
        t.equal(
          result.error?.code,
          operation === 'create' ? cancelledCode : undefined
        );
        t.equal(fixture.calls.create.length + fixture.calls.unlink.length, 0);
        t.equal(
          await fs
            .access(target)
            .then(() => true)
            .catch(() => false),
          operation === 'delete',
          'Cancel preserves actual filesystem state'
        );
        const { options, parent } = fixture.calls.dialogs[0];
        t.equal(parent, fixture.window);
        t.deepEqual(Array.from(options.buttons), [
          'Cancel',
          operation === 'create' ? 'Create' : 'Delete',
        ]);
        t.equal(options.defaultId, 0);
        t.equal(options.cancelId, 0);
      }
      const target = path.join(directory, `${operation}\n\u202e\u0085target`);
      if (operation === 'delete') await fs.writeFile(target, 'fixture');
      const fixture = getHandlers(directory);
      await fixture.grant(operation, target);
      fixture.approve();
      const result = await fixture.invoke(operation, target);
      t.notOk(result.error);
      const detail = fixture.calls.dialogs[0].options.detail;
      t.equal(JSON.parse(detail.slice('Filesystem path: '.length)), target);
      t.notOk(
        /[\n\r\u202e\u0085]/.test(detail),
        'control and direction characters are escaped'
      );
      if (operation === 'create') t.equal(result.data, 'au');
      else
        t.ok(
          (await fixture.handlers['delete-file'](fixture.event, target)).error,
          'deletion grant cannot be replayed'
        );
    }
  });
  t.end();
});

test('database entry and parent replacement revoke captured authority', async (t) => {
  await withFixture(async (directory) => {
    for (const operation of ['create', 'connect', 'delete'] as const) {
      const target = path.join(directory, operation);
      await fs.writeFile(target, 'original');
      const fixture = getHandlers(directory);
      await fixture.grant(operation, target);
      await fs.rename(target, target + '.retained');
      await fs.writeFile(target, 'replacement sentinel');
      fixture.approve();
      t.ok((await fixture.invoke(operation, target)).error);
      t.equal(await fs.readFile(target, 'utf8'), 'replacement sentinel');
      t.equal(await fs.readFile(target + '.retained', 'utf8'), 'original');
    }
    const parent = path.join(directory, 'parent');
    await fs.mkdir(parent);
    const target = path.join(parent, 'absent');
    const fixture = getHandlers(directory);
    await fixture.grant('create', target);
    await fs.rename(parent, parent + '.retained');
    await fs.mkdir(parent);
    fixture.approve();
    t.ok(
      (await fixture.handlers['db-create'](fixture.event, target, 'au')).error
    );
    t.deepEqual(await fs.readdir(parent), []);
    t.deepEqual(await fs.readdir(parent + '.retained'), []);
  });
  t.end();
});

test('post-confirmation entry and window changes prevent effects', async (t) => {
  await withFixture(async (directory) => {
    for (const operation of ['create', 'delete'] as const) {
      for (const change of ['entry', 'destroy', 'window', 'frame']) {
        const target = path.join(directory, `${operation}-${change}`);
        await fs.writeFile(target, 'original');
        const fixture = getHandlers(directory);
        await fixture.grant(operation, target);
        fixture.approve();
        fixture.duringDialog(async () => {
          if (change === 'entry') {
            await fs.rename(target, target + '.retained');
            await fs.writeFile(target, 'replacement');
          } else if (change === 'destroy')
            fixture.window.isDestroyed = () => true;
          else if (change === 'frame')
            fixture.window.webContents.mainFrame = {};
          else fixture.main.mainWindow = { ...fixture.window };
        });
        await fixture.invoke(operation, target);
        t.equal(
          fixture.calls.create.length + fixture.calls.unlink.length,
          0,
          `${change} revokes consent`
        );
        t.equal(
          await fs.readFile(target, 'utf8'),
          change === 'entry' ? 'replacement' : 'original'
        );
      }
    }
    for (const code of ['ENOENT', 'EBUSY', 'EPERM', 'OTHER']) {
      const target = path.join(directory, code);
      await fs.writeFile(target, 'sentinel');
      const fixture = getHandlers(directory);
      await fixture.grant('delete', target);
      fixture.approve();
      fixture.failUnlink(Object.assign(new Error(code), { code }));
      const result = await fixture.handlers['delete-file'](
        fixture.event,
        target
      );
      t.equal(result.error.code, code);
      t.equal(result.error.message, code);
      t.equal(await fs.readFile(target, 'utf8'), 'sentinel');
    }
  });
  t.end();
});

test('symbolic links, hard links and directories cannot be database destruction targets', async (t) => {
  await withFixture(async (directory) => {
    const sentinel = path.join(directory, 'sentinel');
    const alias = path.join(directory, 'alias');
    await fs.writeFile(sentinel, 'unrelated');
    await fs.symlink(sentinel, alias);
    const folder = path.join(directory, 'folder');
    await fs.mkdir(folder);
    const fixture = getHandlers(directory);
    for (const target of [alias, folder]) {
      for (const operation of ['create', 'connect', 'delete'] as const) {
        try {
          await fixture.grant(operation, target);
          t.fail('alias or directory accepted');
        } catch {
          t.pass('alias or directory rejected');
        }
      }
    }
    await fs.unlink(alias);
    await fs.link(sentinel, alias);
    try {
      await fixture.grant('delete', alias);
      t.fail('hard link accepted');
    } catch {
      t.pass('hard link rejected');
    }
    t.equal(await fs.readFile(sentinel, 'utf8'), 'unrelated');
    t.deepEqual(await fs.readdir(folder), []);
  });
  t.end();
});

test('only exact memory creation bypasses database path authority', async (t) => {
  await withFixture(async (directory) => {
    const fixture = getHandlers(directory);
    const response = await fixture.handlers['db-create'](
      fixture.event,
      ':memory:',
      'au'
    );
    t.equal(fixture.calls.dialogs.length, 0);
    t.deepEqual(fixture.calls.create[0].slice(0, 2), [':memory:', 'au']);
    t.equal(response.data, 'au');
    t.ok(
      (await fixture.handlers['db-create'](null, ':memory:', 'au')).error,
      'memory still requires the active sender'
    );
    const diskPath = path.join(
      directory,
      process.platform === 'win32' ? 'memory.db' : ':memory:'
    );
    t.ok(
      (await fixture.handlers['db-create'](fixture.event, diskPath, 'au'))
        .error,
      'similar disk path needs authority'
    );
    await fixture.grant('create', diskPath);
    fixture.approve();
    t.equal(
      (await fixture.handlers['db-create'](fixture.event, diskPath, 'au')).data,
      'au'
    );
    t.equal(await fs.readFile(diskPath, 'utf8'), 'synthetic database');
  });
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

test('stale database authority opens a native reselection dialog', async (t) => {
  await withFixture(async (directory) => {
    const target = path.join(directory, 'company.db');
    await fs.writeFile(target, 'original');
    const fixture = getHandlers(directory);
    await fixture.grant('connect', target);
    await fs.rename(target, target + '.original');
    await fs.writeFile(target, 'replacement sentinel');
    const result = await fixture.handlers['open-database-dialog'](
      fixture.event,
      'connect',
      target
    );
    t.equal(
      fixture.calls.selections.length,
      2,
      'a stale grant cannot suppress the picker'
    );
    t.equal(result.filePaths[0], target);
    t.notOk(
      (await fixture.invoke('connect', target)).error,
      'the newly selected identity is authorised'
    );
    t.equal(await fs.readFile(target + '.original', 'utf8'), 'original');
  });
  t.end();
});

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
