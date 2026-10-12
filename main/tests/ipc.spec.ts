import { promises as fs } from 'fs';
import path from 'path';
import test from 'tape';
import { getHandlers, withFixture } from './databaseIpcFixture';
import { loadSource } from './helpers';

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

test('export IPC refuses missing grants before rendering and permits only one PDF redemption', async (t) => {
  await withFixture(async (directory) => {
    const f = getHandlers(directory);
    const target = path.join(directory, 'report.pdf');
    for (const action of ['save-data', 'save-html-as-pdf'] as const) {
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
    for (const action of ['db-call', 'db-bespoke'] as const) {
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
      t.equal(result.error!.code, code);
      t.equal(result.error!.message, code);
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
