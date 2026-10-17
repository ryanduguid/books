import BetterSQLite3 from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import test from 'tape';
import { DatabaseManager } from '../../database/manager';
import DatabaseCore from '../../database/core';
import { getDefaultMetaFieldValueMap } from '../../helpers';
import updateSchemas from '../updateSchemas';

test('first-run schema promotion reports the original pre-migration recovery', async (t) => {
  const temporaryRoot = await fs.realpath(tmpdir());
  const directory = await fs.mkdtemp(
    path.join(temporaryRoot, 'books-first-recovery-')
  );
  const sourcePath = path.join(directory, 'source.books.db');
  const manager = new DatabaseManager();
  const connect = manager._connect;
  const primary = new Error('post-promotion reconnect fixture');
  let connectionCalls = 0;
  try {
    await manager._connect(sourcePath, 'create', 'in');
    await manager.db!.migrate();
    await manager.db!.update('SystemSettings', { version: '0.4.3-beta.0' });
    await manager.db!.knex!.schema.dropTable('PatchRun');
    await manager.db!.knex!.schema.createTable(
      'preserved_accounting',
      (table) => {
        table.string('value');
      }
    );
    await manager.db!.knex!('preserved_accounting').insert({
      value: 'original accounting state',
    });
    await manager.db!.close();
    manager._connect = async function (...args) {
      connectionCalls++;
      if (connectionCalls === 2) throw primary;
      return connect.apply(this, args);
    };
    try {
      await manager.connectToDatabase(sourcePath, 'in');
      t.fail('post-promotion reconnect must fail');
    } catch (error) {
      t.equal(error, primary);
      t.equal(
        connectionCalls,
        2,
        'the source is opened, then promotion reconnect fails'
      );
      const recoveryPath = manager.getRecoveryPath(sourcePath)!;
      t.ok(
        primary.message.includes(recoveryPath),
        'the error reports the selected original'
      );
      const recovery = new BetterSQLite3(recoveryPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        t.notOk(
          recovery
            .prepare("SELECT name FROM sqlite_master WHERE name = 'PatchRun'")
            .get(),
          'reported recovery precedes the first in-place schema migration'
        );
        t.deepEqual(
          recovery.prepare('SELECT value FROM preserved_accounting').all(),
          [{ value: 'original accounting state' }]
        );
        t.equal(recovery.pragma('quick_check', { simple: true }), 'ok');
      } finally {
        recovery.close();
      }
    }
    t.equal(
      (await fs.readdir(directory)).filter((name) =>
        name.startsWith('.source.books.db.recovery-')
      ).length,
      1,
      'the operation keeps one original recovery'
    );
  } finally {
    manager._connect = connect;
    await manager.db?.close();
    const resolved = await fs.realpath(directory);
    if (
      resolved !== path.resolve(directory) ||
      path.dirname(resolved) !== temporaryRoot ||
      !path.basename(directory).startsWith('books-first-recovery-')
    ) {
      throw new Error('Unexpected fixture path.');
    }
    await fs.rm(directory, { recursive: true });
  }
  t.end();
});

test('schema migration preflight rejects unsupported series without changing their source', async (t) => {
  for (const referenceType of [
    undefined,
    null,
    '',
    '-',
    'Quotation',
    'unknown',
    'SalesInvoice',
  ]) {
    const temporaryRoot = await fs.realpath(tmpdir());
    const directory = await fs.mkdtemp(
      path.join(temporaryRoot, 'books-series-preflight-')
    );
    const manager = new DatabaseManager();
    const dbPath = path.join(directory, 'source.books.db');
    try {
      await manager._connect(dbPath, 'create', 'in');
      await manager.db!.migrate();
      await manager.db!.knex!.schema.dropTable('NumberSeries');
      await manager.db!.knex!.schema.createTable('NumberSeries', (table) => {
        table.string('name');
        table.integer('start');
        table.integer('current');
        table.integer('padZeros');
        table.string('referenceType');
      });
      await manager.db!.knex!('SingleValue')
        .where({ fieldname: 'version' })
        .delete();
      await manager.db!.knex!('SingleValue').insert({
        ...getDefaultMetaFieldValueMap(),
        name: 'unrelated-version',
        parent: 'AccountingSettings',
        fieldname: 'version',
        value: '99.0.0',
      });
      await manager.db!.knex!('SingleValue').insert({
        ...getDefaultMetaFieldValueMap(),
        name: 'fixture-version',
        parent: 'SystemSettings',
        fieldname: 'version',
        value: '0.4.3-beta.0',
      });
      const row = {
        name: 'CUSTOM-',
        start: 500,
        current: 501,
        padZeros: 5,
        referenceType: referenceType ?? null,
      };
      await manager.db!.knex!('NumberSeries').insert(row);
      const before = await manager.db!.knex!('NumberSeries')
        .where({ name: row.name })
        .first();
      const tables = await manager.db!.knex!.raw(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      );
      if (referenceType === 'SalesInvoice') {
        await updateSchemas.preflight(manager);
        t.pass('supported type accepted');
        for (const current of [-1, 0.5, null, Number.MAX_SAFE_INTEGER + 1]) {
          await manager.db!.knex!('NumberSeries')
            .where({ name: row.name })
            .update({ current });
          try {
            await updateSchemas.preflight(manager);
            t.fail('invalid counter must reject');
          } catch (error) {
            t.ok((error as Error).message.includes('CUSTOM-'));
          }
          t.equal(
            (
              await manager.db!.knex!('NumberSeries')
                .where({ name: row.name })
                .first()
            ).current,
            current
          );
        }
        await manager.db!.knex!('NumberSeries')
          .where({ name: row.name })
          .update({ current: row.current });
      } else {
        try {
          await updateSchemas.preflight(manager);
          t.fail('unsupported series must reject');
        } catch (error) {
          t.ok((error as Error).message.includes('CUSTOM-'));
        }
        try {
          await updateSchemas.execute(manager);
          t.fail('execution must also reject');
        } catch (error) {
          t.ok((error as Error).message.includes('CUSTOM-'));
        }
      }
      t.deepEqual(
        await manager.db!.knex!('NumberSeries')
          .where({ name: row.name })
          .first(),
        before
      );
      t.deepEqual(
        await manager.db!.knex!.raw(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ),
        tables
      );
      t.deepEqual(await fs.readdir(directory), ['source.books.db']);
      if (referenceType === '-') {
        await manager.db!.knex!.schema.dropTable('PatchRun');
        await manager.db!.close();
        const reopened = new DatabaseManager();
        const migrate = DatabaseCore.prototype.migrate;
        let migrations = 0;
        DatabaseCore.prototype.migrate = async function (...args) {
          migrations++;
          return migrate.apply(this, args);
        };
        try {
          await reopened.connectToDatabase(dbPath);
          t.fail('first-run connection must reject unsupported series');
        } catch (error) {
          t.ok((error as Error).message.includes('CUSTOM-'));
        } finally {
          DatabaseCore.prototype.migrate = migrate;
          await reopened.db?.close();
        }
        t.equal(
          migrations,
          0,
          'preflight precedes ordinary first-run migration'
        );
        const original = new BetterSQLite3(dbPath, { readonly: true });
        try {
          t.deepEqual(
            original
              .prepare(
                'SELECT name, start, current, padZeros, referenceType FROM NumberSeries'
              )
              .all(),
            [row]
          );
          t.equal(
            original
              .prepare("SELECT name FROM sqlite_master WHERE name='PatchRun'")
              .get(),
            undefined
          );
        } finally {
          original.close();
        }
      }
    } finally {
      await manager.db?.close();
      const resolved = await fs.realpath(directory);
      if (
        resolved !== path.resolve(directory) ||
        path.dirname(resolved) !== temporaryRoot ||
        !path.basename(directory).startsWith('books-series-preflight-')
      )
        throw new Error('Unexpected fixture path.');
      await fs.rm(directory, { recursive: true });
    }
  }
  t.end();
});

test('schema migration owns its temporary destination', async (t) => {
  for (const mode of [
    'current',
    'copy',
    'copy failure',
    'copy corruption',
    'replace failure',
    'reconnect failure',
  ]) {
    const temporaryRoot = await fs.realpath(tmpdir());
    const directory = await fs.mkdtemp(
      path.join(temporaryRoot, 'books-schema-')
    );
    const manager = new DatabaseManager();
    const sourcePath = path.join(directory, 'source.books.db');
    const sentinelPath = path.join(directory, '__update_schemas_temp.db');
    const rename = fs.rename;
    const connect = manager._connect;
    const truncate = DatabaseCore.prototype.truncate;
    const digest = (bytes: Buffer) =>
      createHash('sha256').update(bytes).digest('hex');
    try {
      const sentinel = new BetterSQLite3(sentinelPath);
      try {
        sentinel.exec(
          "CREATE TABLE sentinel AS SELECT 'preserve this' AS value"
        );
      } finally {
        sentinel.close();
      }
      const sentinelBefore = digest(await fs.readFile(sentinelPath));
      await manager._connect(sourcePath, 'create', 'in');
      await manager.db!.migrate();
      await manager.db!.knex!('SingleValue')
        .whereIn('fieldname', ['version', 'country'])
        .delete();
      const meta = getDefaultMetaFieldValueMap();
      await manager.db!.knex!('SingleValue').insert([
        {
          ...meta,
          name: 'fixture-version',
          parent: 'SystemSettings',
          fieldname: 'version',
          value: mode === 'current' ? '0.5.0-beta.0' : '0.4.3-beta.0',
        },
        {
          ...meta,
          name: 'fixture-country',
          parent: 'AccountingSettings',
          fieldname: 'country',
          value: 'India',
        },
      ]);
      if (mode === 'copy' || mode === 'copy corruption') {
        await manager.db!.knex!('NumberSeries').insert([
          {
            ...meta,
            name: 'CUSTOM-',
            referenceType: 'SalesInvoice',
            start: 500,
            current: 501,
            padZeros: 5,
          },
          {
            ...meta,
            name: 'SECOND-',
            referenceType: 'Payment',
            start: 200,
            current: 0,
            padZeros: 3,
          },
        ]);
      }
      if (mode === 'copy failure') {
        await manager.db!.knex!.schema.dropTable('Party');
      }
      const fixtureVersion = await manager.db!.knex!('SingleValue')
        .where({ fieldname: 'version' })
        .first();
      t.equal(
        fixtureVersion.value,
        mode === 'current' ? '0.5.0-beta.0' : '0.4.3-beta.0',
        `${mode} has the intended migration eligibility`
      );
      const sourceBefore = digest(await fs.readFile(sourcePath));
      const injectedError = Object.assign(new Error(`${mode} fixture`), {
        code: mode === 'replace failure' ? 'EACCES' : 'BOOKS_TEST_RECONNECT',
      });
      let replacementCalls = 0;
      const canonicalSourcePath = await fs.realpath(sourcePath);
      if (mode === 'copy corruption') {
        DatabaseCore.prototype.truncate = async function (...args) {
          await truncate.apply(this, args);
          await this.knex!.raw(`
            CREATE TRIGGER corrupt_series AFTER INSERT ON NumberSeries
            BEGIN
              UPDATE NumberSeries SET current = current + 1 WHERE name = NEW.name;
            END
          `);
        };
      }
      if (mode === 'replace failure') {
        fs.rename = async (from, to) => {
          if (to === canonicalSourcePath) {
            replacementCalls++;
            throw injectedError;
          }
          return rename(from, to);
        };
      } else if (mode === 'reconnect failure') {
        manager._connect = async () => {
          replacementCalls++;
          throw injectedError;
        };
      }
      let failure;
      try {
        await updateSchemas.execute(manager);
      } catch (error) {
        failure = error;
      } finally {
        fs.rename = rename;
        manager._connect = connect;
        DatabaseCore.prototype.truncate = truncate;
      }
      if (mode === 'copy failure') {
        t.ok(
          String(failure).includes('Party'),
          'the copy failure is propagated'
        );
      } else if (mode === 'copy corruption') {
        t.ok(
          String(failure).includes('Number series changed during migration'),
          'copied counter corruption rejects before promotion'
        );
      } else if (mode === 'replace failure' || mode === 'reconnect failure') {
        t.equal(failure, injectedError, `${mode} propagates the exact error`);
        t.equal(
          (failure as NodeJS.ErrnoException).code,
          injectedError.code,
          `${mode} propagates the error code`
        );
        t.equal(replacementCalls, 1, `${mode} reaches the intended operation`);
      } else {
        t.notOk(failure, `${mode} database completes`);
      }
      t.equal(
        digest(await fs.readFile(sentinelPath)),
        sentinelBefore,
        `${mode} preserves the unrelated sibling database`
      );
      t.deepEqual(
        (await fs.readdir(directory))
          .filter((name) => !name.startsWith('.source.books.db.recovery-'))
          .sort(),
        ['__update_schemas_temp.db', 'source.books.db'],
        `${mode} leaves no migration temporary files`
      );
      const recoveryDirectories = (await fs.readdir(directory)).filter((name) =>
        name.startsWith('.source.books.db.recovery-')
      );
      t.equal(
        recoveryDirectories.length,
        ['copy', 'replace failure', 'reconnect failure'].includes(mode) ? 1 : 0,
        `${mode} retains exactly the required recovery snapshot`
      );
      if (recoveryDirectories.length) {
        const recovery = new BetterSQLite3(
          path.join(directory, recoveryDirectories[0], 'database.db'),
          { readonly: true, fileMustExist: true }
        );
        try {
          const version = recovery
            .prepare(
              "SELECT value FROM SingleValue WHERE fieldname = 'version'"
            )
            .get() as { value: string };
          t.equal(
            version.value,
            '0.4.3-beta.0',
            `${mode} retains a usable independent original`
          );
        } finally {
          recovery.close();
        }
      }
      if (mode === 'copy') {
        t.deepEqual(
          await manager.db!.knex!('NumberSeries')
            .select('name', 'referenceType', 'start', 'current', 'padZeros')
            .orderBy('name'),
          [
            {
              name: 'CUSTOM-',
              referenceType: 'SalesInvoice',
              start: 500,
              current: 501,
              padZeros: 5,
            },
            {
              name: 'SECOND-',
              referenceType: 'Payment',
              start: 200,
              current: 0,
              padZeros: 3,
            },
          ],
          'migration preserves every supported series and counter setting'
        );
        const version = await manager.db!.knex!('SingleValue')
          .where({ fieldname: 'version' })
          .first();
        t.equal(
          version.value,
          '0.5.0-beta.0',
          'replacement database reconnects'
        );
        const connection = await manager.db!.knex!.raw('PRAGMA database_list');
        t.equal(
          await fs.realpath(connection[0].file),
          await fs.realpath(sourcePath),
          'connection uses the source path'
        );
      } else if (mode === 'reconnect failure') {
        const fresh = new DatabaseManager();
        try {
          await fresh._connect(sourcePath, 'existing');
          const version = await fresh.db!.knex!('SingleValue')
            .where({ fieldname: 'version' })
            .first();
          t.equal(
            version.value,
            '0.5.0-beta.0',
            'reconnect failure leaves a usable migrated database at the source'
          );
        } finally {
          await fresh.db?.close();
        }
      } else {
        t.equal(
          digest(await fs.readFile(sourcePath)),
          sourceBefore,
          `${mode} preserves the source bytes`
        );
        if (mode === 'replace failure' || mode === 'copy corruption') {
          const original = new BetterSQLite3(sourcePath, {
            readonly: true,
            fileMustExist: true,
          });
          try {
            const version = original
              .prepare(
                "SELECT value FROM SingleValue WHERE fieldname = 'version'"
              )
              .get() as { value: string };
            t.equal(
              version.value,
              '0.4.3-beta.0',
              'replacement failure preserves a usable original database'
            );
            if (mode === 'copy corruption') {
              t.deepEqual(
                original
                  .prepare(
                    'SELECT name, referenceType, start, current, padZeros FROM NumberSeries ORDER BY name'
                  )
                  .all(),
                [
                  {
                    name: 'CUSTOM-',
                    referenceType: 'SalesInvoice',
                    start: 500,
                    current: 501,
                    padZeros: 5,
                  },
                  {
                    name: 'SECOND-',
                    referenceType: 'Payment',
                    start: 200,
                    current: 0,
                    padZeros: 3,
                  },
                ],
                'independent reopening confirms every original counter is intact'
              );
            }
          } finally {
            original.close();
          }
        }
      }
    } finally {
      fs.rename = rename;
      manager._connect = connect;
      DatabaseCore.prototype.truncate = truncate;
      if (manager.db?.knex) await manager.db.close();
      const resolved = await fs.realpath(directory);
      if (
        resolved !== path.resolve(directory) ||
        path.dirname(resolved) !== temporaryRoot ||
        !path.basename(directory).startsWith('books-schema-')
      ) {
        throw new Error('Unexpected fixture cleanup path.');
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  t.end();
});

for (const mode of ['primary plus cleanup', 'cleanup only']) {
  test(`schema migration ${mode} preserves the primary result and attempts bounded cleanup`, async (t) => {
    const temporaryRoot = await fs.realpath(tmpdir());
    const directory = await fs.mkdtemp(
      path.join(temporaryRoot, 'books-schema-cleanup-')
    );
    const manager = new DatabaseManager();
    const close = DatabaseCore.prototype.close;
    const truncate = DatabaseCore.prototype.truncate;
    const rmdir = fs.rmdir;
    const primary = Object.assign(new Error('copy fixture'), {
      code: 'COPY_FIXTURE',
    });
    const closeError = new Error('destination close fixture');
    const removeError = new Error('directory cleanup fixture');
    const staged: DatabaseCore[] = [];
    let closeAttempts = 0;
    let removeAttempts = 0;
    const target = path.join(directory, 'source.books.db');
    try {
      await fs.writeFile(path.join(directory, 'sentinel'), 'unrelated');
      await fs.mkdir(path.join(directory, 'sentinel-directory'));
      await manager._connect(target, 'create', 'in');
      await manager.db!.migrate();
      await manager.db!.knex!('SingleValue')
        .where({ fieldname: 'version' })
        .update({ value: '0.4.3-beta.0' });
      if (mode === 'primary plus cleanup') {
        DatabaseCore.prototype.truncate = async function () {
          throw primary;
        };
        DatabaseCore.prototype.close = async function () {
          if (
            path
              .basename(path.dirname(this.dbPath))
              .startsWith('__update_schemas-')
          ) {
            staged.push(this);
            closeAttempts++;
            throw closeError;
          }
          return close.call(this);
        };
      }
      fs.rmdir = (async (value: any) => {
        if (path.basename(String(value)).startsWith('__update_schemas-')) {
          removeAttempts++;
          throw removeError;
        }
        return rmdir(value);
      }) as typeof fs.rmdir;
      try {
        await updateSchemas.execute(manager);
        t.fail('injected failure must surface');
      } catch (error) {
        t.equal(error, mode === 'primary plus cleanup' ? primary : removeError);
        if (mode === 'primary plus cleanup') {
          t.equal((error as any).code, 'COPY_FIXTURE');
          t.deepEqual((error as any).cleanupErrors, [
            String(closeError),
            String(removeError),
          ]);
        } else {
          t.ok(
            (error as Error).message.includes(manager.getRecoveryPath(target)!)
          );
          const version = await manager.db!.knex!('SingleValue')
            .where({ fieldname: 'version' })
            .first();
          t.equal(
            version.value,
            '0.5.0-beta.0',
            'cleanup-only failure retains the connected migrated database'
          );
        }
      }
      t.equal(closeAttempts, mode === 'primary plus cleanup' ? 1 : 0);
      t.equal(
        removeAttempts,
        1,
        'directory cleanup is attempted even after close failure'
      );
      t.equal(
        await fs.readFile(path.join(directory, 'sentinel'), 'utf8'),
        'unrelated'
      );
      t.deepEqual(
        await fs.readdir(path.join(directory, 'sentinel-directory')),
        []
      );
    } finally {
      DatabaseCore.prototype.close = close;
      DatabaseCore.prototype.truncate = truncate;
      fs.rmdir = rmdir;
      for (const db of staged) await db.close();
      await manager.db?.close();
      const resolved = await fs.realpath(directory);
      if (
        resolved !== path.resolve(directory) ||
        path.dirname(resolved) !== temporaryRoot ||
        !path.basename(directory).startsWith('books-schema-cleanup-')
      ) {
        throw new Error('Unexpected fixture cleanup path.');
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
    t.end();
  });
}
