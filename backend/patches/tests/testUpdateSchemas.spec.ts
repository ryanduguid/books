import BetterSQLite3 from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import test from 'tape';
import { DatabaseManager } from '../../database/manager';
import { getDefaultMetaFieldValueMap } from '../../helpers';
import updateSchemas from '../updateSchemas';

test('schema migration owns its temporary destination', async (t) => {
  for (const mode of [
    'current',
    'copy',
    'copy failure',
    'replace failure',
    'reconnect failure',
  ]) {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'books-schema-'));
    const manager = new DatabaseManager();
    const sourcePath = path.join(directory, 'source.books.db');
    const sentinelPath = path.join(directory, '__update_schemas_temp.db');
    const rename = fs.rename;
    const connect = manager._connect;
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
      if (mode === 'replace failure') {
        fs.rename = async (from, to) => {
          if (to === sourcePath) {
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
      }
      if (mode === 'copy failure') {
        t.ok(
          String(failure).includes('Party'),
          'the copy failure is propagated'
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
        (await fs.readdir(directory)).sort(),
        ['__update_schemas_temp.db', 'source.books.db'],
        `${mode} leaves no migration temporary files`
      );
      if (mode === 'copy') {
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
          connection[0].file,
          sourcePath,
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
        if (mode === 'replace failure') {
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
          } finally {
            original.close();
          }
        }
      }
    } finally {
      fs.rename = rename;
      manager._connect = connect;
      if (manager.db?.knex) await manager.db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  t.end();
});
