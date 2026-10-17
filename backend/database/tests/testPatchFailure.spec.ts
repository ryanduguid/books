import test from 'tape';
import { loadSource } from '../../../main/tests/helpers';
import { DatabaseManager } from '../manager';
import { getDefaultMetaFieldValueMap } from '../../helpers';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import BetterSQLite3 from 'better-sqlite3';

test('patch execution stops with the primary error even when failure recording cannot use a closed database', async (t) => {
  const primary = Object.assign(new Error('reconnect fixture'), {
    code: 'RECONNECT_FIXTURE',
  });
  const calls: unknown[] = [];
  const runner = loadSource<any>('backend/database/runPatch.ts', {
    '../helpers': {
      emitMainProcessError: (error: unknown) => calls.push(error),
      getDefaultMetaFieldValueMap: () => ({}),
    },
  });
  try {
    await runner.runPatches(
      [
        {
          name: 'updateSchemas',
          patch: {
            execute: async () => {
              throw primary;
            },
          },
        },
        {
          name: 'later-patch',
          patch: {
            execute: async () => {
              calls.push('later');
            },
          },
        },
      ],
      { db: undefined },
      '0.4.3-beta.0'
    );
    t.fail('migration failure must propagate');
  } catch (error) {
    t.equal(error, primary);
    t.equal((error as any).code, 'RECONNECT_FIXTURE');
    t.equal((error as any).cleanupErrors?.length, 1);
  }
  t.deepEqual(
    calls,
    [primary],
    'later transformations do not run after a failed migration'
  );
  t.end();
});

for (const { failed, parentAlias } of [
  { failed: false, parentAlias: false },
  { failed: true, parentAlias: false },
  { failed: false, parentAlias: true },
  { failed: true, parentAlias: true },
]) {
  test(`a cross-version patch retry records its ${
    failed ? 'failure' : 'success'
  }${parentAlias ? ' through an owned parent alias' : ''}`, async (t) => {
    const temporaryRoot = await fs.realpath(tmpdir());
    const directory = await fs.mkdtemp(
      path.join(temporaryRoot, 'books-patch-retry-')
    );
    let dbPath = path.join(directory, 'source.books.db');
    let canonicalDbPath = dbPath;
    const manager = new DatabaseManager();
    const version = '0.5.0-beta.0';
    const primary = new Error('retry failed');
    try {
      await fs.writeFile(path.join(directory, 'sentinel'), 'unrelated');
      await fs.mkdir(path.join(directory, 'sentinel-directory'));
      if (parentAlias) {
        const parent = path.join(directory, 'real-parent');
        const alias = path.join(directory, 'parent-alias');
        await fs.mkdir(parent);
        let aliasCreated = true;
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
          aliasCreated = false;
        }
        dbPath = path.join(aliasCreated ? alias : parent, 'source.books.db');
        canonicalDbPath = path.join(parent, 'source.books.db');
      }
      await manager._connect(dbPath, 'create', 'in');
      t.equal(manager.db!.dbPath, canonicalDbPath);
      await manager.db!.migrate();
      await manager.db!.insert('PatchRun', {
        ...getDefaultMetaFieldValueMap(),
        name: 'testPatch',
        failed: true,
        version: '0.4.3-beta.0',
      });
      await manager.db!.update('SystemSettings', { version });
      const runner = loadSource<any>('backend/database/runPatch.ts', {
        '../helpers': {
          emitMainProcessError: () => {},
          getDefaultMetaFieldValueMap,
        },
      });
      let executions = 0;
      let failure;
      try {
        await runner.runPatches(
          [
            {
              name: 'testPatch',
              patch: {
                execute: async () => {
                  executions++;
                  if (failed) throw primary;
                },
              },
            },
          ],
          manager,
          version
        );
      } catch (error) {
        failure = error;
      }
      t.equal(failure, failed ? primary : undefined);
      t.equal(executions, 1);
      await manager.db!.close();
      const independent = new BetterSQLite3(canonicalDbPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        t.deepEqual(
          independent
            .prepare(
              'SELECT name, failed, version FROM PatchRun WHERE name = ?'
            )
            .all('testPatch'),
          [{ name: 'testPatch', failed: Number(failed), version }]
        );
      } finally {
        independent.close();
      }
      const reopened = new DatabaseManager();
      try {
        await reopened.connectToDatabase(dbPath);
        t.notOk(failed, 'a successful retry permits reopening');
        t.equal(reopened.db!.dbPath, canonicalDbPath);
        t.deepEqual(
          await reopened.db!.knex!('PatchRun')
            .select('name', 'failed', 'version')
            .where({ name: 'testPatch' }),
          [{ name: 'testPatch', failed: 0, version }],
          'reopening retains the successful retry and its new version'
        );
      } catch (error) {
        t.ok(failed, 'a failed retry blocks reopening at its new version');
        t.ok((error as Error).message.includes('testPatch'));
      } finally {
        await reopened.db?.close();
      }
      t.equal(
        await fs.readFile(path.join(directory, 'sentinel'), 'utf8'),
        'unrelated'
      );
      t.deepEqual(
        await fs.readdir(path.join(directory, 'sentinel-directory')),
        []
      );
    } finally {
      await manager.db?.close();
      const resolved = await fs.realpath(directory);
      if (
        resolved !== path.resolve(directory) ||
        path.dirname(resolved) !== temporaryRoot ||
        !path.basename(directory).startsWith('books-patch-retry-')
      ) {
        throw new Error('Unexpected fixture path.');
      }
      await fs.rm(directory, { recursive: true });
    }
    t.end();
  });
}

test('only pre-migration patches may defer an absent PatchRun table', async (t) => {
  const manager = new DatabaseManager();
  const runner = loadSource<any>('backend/database/runPatch.ts', {
    '../helpers': {
      emitMainProcessError: () => {},
      getDefaultMetaFieldValueMap,
    },
  });
  try {
    await manager._connect(':memory:', 'create', 'in');
    await manager.db!.migrate();
    await manager.db!.knex!.schema.dropTable('PatchRun');
    const results = await runner.runPatches(
      [
        {
          name: 'pre',
          patch: { beforeMigrate: true, execute: async () => {} },
        },
      ],
      manager,
      '0.5.0-beta.0'
    );
    t.equal(results[0].name, 'pre');
    t.equal(results[0].success, true);
    try {
      await runner.runPatches(
        [
          {
            name: 'post',
            patch: { execute: async () => {} },
          },
        ],
        manager,
        '0.5.0-beta.0'
      );
      t.fail('post-migration recording failure must propagate');
    } catch (error) {
      t.ok(String(error).includes('PatchRun'));
    }
    await manager.db!.knex!.schema.createTable('PatchRun', (table) => {
      table.string('name').primary();
    });
    try {
      await runner.runPatches(
        [
          {
            name: 'pre',
            patch: { beforeMigrate: true, execute: async () => {} },
          },
        ],
        manager,
        '0.5.0-beta.0'
      );
      t.fail('a malformed existing PatchRun table must fail closed');
    } catch (error) {
      t.ok(String(error).includes('PatchRun'));
    }
  } finally {
    await manager.db?.close();
  }
  t.end();
});

test('persisted patch failure blocks two independent reopenings at the same version', async (t) => {
  const temporaryRoot = await fs.realpath(tmpdir());
  const directory = await fs.mkdtemp(
    path.join(temporaryRoot, 'books-patch-failure-')
  );
  const dbPath = path.join(directory, 'source.books.db');
  const setup = new DatabaseManager();
  const version = '0.5.0-beta.0';
  try {
    await setup._connect(dbPath, 'create', 'in');
    await setup.db!.migrate();
    await setup.db!.knex!('SingleValue')
      .where({ fieldname: 'version' })
      .delete();
    await setup.db!.knex!('SingleValue').insert({
      ...getDefaultMetaFieldValueMap(),
      name: 'test-version',
      parent: 'SystemSettings',
      fieldname: 'version',
      value: version,
    });
    await setup.db!.knex!.schema.createTable(
      'preserved_accounting',
      (table) => {
        table.string('value');
      }
    );
    await setup.db!.knex!('preserved_accounting').insert({
      value: 'original accounting state',
    });
    const runner = loadSource<any>('backend/database/runPatch.ts', {
      '../helpers': {
        emitMainProcessError: () => {},
        getDefaultMetaFieldValueMap,
      },
    });
    const primary = new Error('qualification failure');
    try {
      await runner.runPatches(
        [
          {
            name: 'qualification-patch',
            patch: {
              execute: async () => {
                throw primary;
              },
            },
          },
        ],
        setup,
        version
      );
      t.fail('failed patch must stop execution');
    } catch (error) {
      t.equal(error, primary);
    }
    t.equal(
      (
        await setup.db!.knex!('PatchRun')
          .where({ name: 'qualification-patch' })
          .first()
      ).failed,
      1
    );
    await setup.db!.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = new DatabaseManager();
      try {
        await reopened.connectToDatabase(dbPath);
        t.fail('recorded failure must block reopening');
      } catch (error) {
        t.ok((error as Error).message.includes('qualification-patch'));
      } finally {
        await reopened.db?.close();
      }
      const independent = new BetterSQLite3(dbPath, { readonly: true });
      try {
        t.deepEqual(
          independent.prepare('SELECT value FROM preserved_accounting').all(),
          [{ value: 'original accounting state' }]
        );
        t.equal(
          (
            independent
              .prepare('SELECT failed FROM PatchRun WHERE name = ?')
              .get('qualification-patch') as { failed: number }
          ).failed,
          1
        );
      } finally {
        independent.close();
      }
    }
  } finally {
    await setup.db?.close();
    const resolved = await fs.realpath(directory);
    if (
      resolved !== path.resolve(directory) ||
      path.dirname(resolved) !== temporaryRoot ||
      !path.basename(directory).startsWith('books-patch-failure-')
    )
      throw new Error('Unexpected fixture path.');
    await fs.rm(directory, { recursive: true });
  }
  t.end();
});
