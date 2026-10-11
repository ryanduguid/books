import BetterSQLite3 from 'better-sqlite3';
import { promises as fs, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'tape';
import { loadSource } from '../../../main/tests/helpers';
import DatabaseCore from '../core';
import {
  assertDatabaseTarget,
  backupDatabase,
  captureDatabaseTarget,
  finishDatabaseCleanup,
  promoteDatabase,
  removeOwnedDatabaseDirectory,
} from '../files';
import { DatabaseManager } from '../manager';

async function withFixture(
  run: (directory: string, target: string) => Promise<void>
) {
  const temporaryRoot = await fs.realpath(tmpdir());
  const directory = await fs.mkdtemp(
    path.join(temporaryRoot, 'books-recovery-')
  );
  try {
    const target = path.join(directory, 'external arbitrary name');
    await fs.writeFile(
      path.join(directory, 'sentinel.txt'),
      'unrelated contents'
    );
    await fs.mkdir(path.join(directory, 'sentinel-directory'));
    await run(directory, target);
  } finally {
    const resolved = await fs.realpath(directory);
    if (
      resolved !== path.resolve(directory) ||
      path.dirname(resolved) !== temporaryRoot ||
      !path.basename(directory).startsWith('books-recovery-')
    ) {
      throw new Error('Unexpected fixture cleanup path.');
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function createOriginal(target: string, wal = false) {
  const db = new BetterSQLite3(target);
  if (wal) db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE original AS SELECT 'synthetic original' AS value");
  return db;
}

function readOriginal(target: string) {
  const db = new BetterSQLite3(target, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT value FROM original').get() as { value: string })
      .value;
  } finally {
    db.close();
  }
}

async function assertSentinels(t: test.Test, directory: string) {
  t.equal(
    await fs.readFile(path.join(directory, 'sentinel.txt'), 'utf8'),
    'unrelated contents'
  );
  t.deepEqual(await fs.readdir(path.join(directory, 'sentinel-directory')), []);
  t.notOk(
    (await fs.readdir(directory)).some((name) =>
      name.startsWith('.books-create-')
    ),
    'staging directories are cleaned'
  );
}

test('replacement retains a verified independent original through later renderer setup failure', async (t) => {
  await withFixture(async (directory, target) => {
    createOriginal(target).close();
    const manager = new DatabaseManager();
    try {
      t.equal(await manager.createNewDatabase(target, 'in'), 'in');
      t.equal(
        manager.db!.dbPath,
        target,
        'renderer uses the promoted destination'
      );
      const recovery = manager.getRecoveryPath(target)!;
      t.equal(
        path.dirname(path.dirname(recovery)),
        directory,
        'recovery remains beside the destination'
      );
      t.equal(readOriginal(recovery), 'synthetic original');
      const error = Object.assign(new Error('settings failure'), {
        code: 'SETUP_FIXTURE',
      });
      const rendererRecovery = loadSource<any>(
        'src/utils/db.ts',
        {},
        {
          ipc: { getDbRecoveryPath: async () => recovery },
        }
      );
      const setup = loadSource<any>('src/setup/setupInstance.ts', {
        'src/utils/initialization': { initializeInstance: async () => {} },
        'utils/misc': {
          getCountryCodeFromCountry: () => 'in',
          getCountryInfo: () => ({
            India: { currency: 'INR', locale: 'en-IN' },
          }),
        },
        'src/utils/db': rendererRecovery,
      });
      const fyo = {
        isElectron: true,
        store: { skipTelemetryLogging: false },
        doc: {
          getDoc: async () => {
            throw error;
          },
        },
      };
      try {
        await setup.default(
          target,
          { companyName: 'Synthetic', country: 'India' },
          fyo
        );
        t.fail('settings failure must propagate');
      } catch (failure) {
        t.equal(failure, error, 'the original setup error is preserved');
        t.equal((failure as any).code, 'SETUP_FIXTURE');
        t.ok(
          (failure as Error).message.includes(recovery),
          'recovery is discoverable on failure'
        );
      }
      t.equal(fyo.store.skipTelemetryLogging, false);
      t.equal(
        readOriginal(recovery),
        'synthetic original',
        'later failure retains a usable original'
      );
      t.ok(manager.db!.knex, 'replacement remains connected');
      await assertSentinels(t, directory);
    } finally {
      await manager.db?.close();
    }
  });
  t.end();
});

test('replacement through an owned parent alias retains canonical recovery lookup', async (t) => {
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
    const target = path.join(alias, 'original.db');
    const canonical = path.join(parent, 'original.db');
    createOriginal(canonical).close();
    const manager = new DatabaseManager();
    try {
      try {
        await backupDatabase(canonical, path.join(alias, '.backup-'));
        t.fail('backup parents must remain canonical');
      } catch (error) {
        t.ok(
          String(error).includes('backup parent must be a canonical directory')
        );
      }
      t.equal(await manager.createNewDatabase(target, 'in'), 'in');
      t.equal(manager.db!.dbPath, canonical);
      const recovery = manager.getRecoveryPath(canonical)!;
      t.ok(recovery, 'replacement retains an original recovery');
      t.equal(
        manager.getRecoveryPath(target),
        recovery,
        'stable parent alias finds the same recovery'
      );
      t.equal(readOriginal(recovery), 'synthetic original');
      await manager.db!.close();
      await fs.rename(canonical, canonical + '.retained');
      t.equal(
        manager.getRecoveryPath(target),
        recovery,
        'lookup does not need the database file'
      );
      await fs.writeFile(canonical, 'replacement sentinel');
      t.equal(manager.getRecoveryPath(target), recovery);
      await fs.unlink(alias);
      t.equal(
        manager.getRecoveryPath(target),
        undefined,
        'removed aliases have no persistent lookup key'
      );
      t.equal(
        manager.getRecoveryPath(canonical),
        recovery,
        'lexical canonical lookup survives alias removal'
      );
      t.equal(
        manager.getRecoveryPath(
          path.join(directory, 'missing-parent', 'database.db')
        ),
        undefined
      );
      t.equal(
        readOriginal(recovery),
        'synthetic original',
        'recovery remains independently readable'
      );
      t.equal(await fs.readFile(canonical, 'utf8'), 'replacement sentinel');
      await assertSentinels(t, directory);
    } finally {
      await manager.db?.close();
    }
  });
  t.end();
});

test('a replaced parent alias revokes the original selected target even for a canonical connect path', async (t) => {
  await withFixture(async (directory) => {
    const parent = path.join(directory, 'real-parent');
    const substitute = path.join(directory, 'substitute-parent');
    const alias = path.join(directory, 'parent-alias');
    await fs.mkdir(parent);
    await fs.mkdir(substitute);
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
    const canonical = path.join(parent, 'original.db');
    createOriginal(canonical).close();
    const selected = await captureDatabaseTarget(
      path.join(alias, 'original.db')
    );
    await fs.writeFile(
      path.join(substitute, 'original.db'),
      'substitute sentinel'
    );
    const manager = new DatabaseManager();
    const connect = manager._connect;
    let aliasChanged = false;
    let guards = 0;
    try {
      manager._connect = async function (...args) {
        const country = await connect.apply(this, args);
        await fs.unlink(alias);
        await fs.symlink(substitute, alias, 'dir');
        aliasChanged = true;
        return country;
      };
      try {
        await manager.connectToDatabase(
          canonical,
          'in',
          () => {
            guards++;
          },
          selected
        );
        t.fail('changed selected parent must reject');
      } catch (error) {
        t.ok(String(error).includes('parent changed after selection'));
      }
      t.ok(aliasChanged, 'parent replacement injection was reached');
      t.ok(guards > 0, 'operation guard is still used');
      t.notOk(
        manager.db?.knex,
        'revalidation failure closes the opened handle'
      );
      t.equal(manager.db!.dbPath, canonical);
      t.equal(readOriginal(canonical), 'synthetic original');
      t.equal(
        await fs.readFile(path.join(substitute, 'original.db'), 'utf8'),
        'substitute sentinel'
      );
      await assertSentinels(t, directory);
    } finally {
      manager._connect = connect;
      await manager.db?.close();
    }
  });
  t.end();
});

for (const phase of ['initialisation', 'migration', 'promotion', 'reconnect']) {
  test(`database ${phase} failure preserves original or recovery and the primary error`, async (t) => {
    await withFixture(async (directory, target) => {
      createOriginal(target).close();
      const manager = new DatabaseManager();
      const connect = DatabaseManager.prototype._connect;
      const migrate = DatabaseCore.prototype.migrate;
      const rename = fs.rename;
      const canonicalTarget = (await captureDatabaseTarget(target)).path;
      let promotionFailures = 0;
      const error = Object.assign(new Error(`${phase} fixture`), {
        code: 'RECOVERY_FIXTURE',
      });
      try {
        if (phase === 'initialisation') {
          DatabaseManager.prototype._connect = async function (
            dbPath,
            mode,
            country
          ) {
            if (mode === 'create') throw error;
            return connect.call(this, dbPath, mode, country);
          };
        } else if (phase === 'migration') {
          DatabaseCore.prototype.migrate = async function () {
            throw error;
          };
        } else if (phase === 'promotion') {
          fs.rename = async (from, to) => {
            if (to === canonicalTarget) {
              promotionFailures++;
              throw error;
            }
            return rename(from, to);
          };
        } else {
          manager._connect = async () => {
            throw error;
          };
        }
        try {
          await manager.createNewDatabase(target, 'in');
          t.fail('injected failure must propagate');
        } catch (failure) {
          t.equal(failure, error);
          t.equal((failure as any).code, 'RECOVERY_FIXTURE');
        }
        const recovery = manager.getRecoveryPath(target);
        if (phase === 'promotion')
          t.equal(promotionFailures, 1, 'promotion injection was reached');
        if (phase === 'promotion' || phase === 'reconnect') {
          t.ok(recovery);
          t.equal(readOriginal(recovery!), 'synthetic original');
          t.ok(error.message.includes(recovery!));
        }
        if (phase !== 'reconnect') {
          t.equal(
            readOriginal(target),
            'synthetic original',
            'pre-promotion failure retains the original'
          );
        } else {
          const replacement = new BetterSQLite3(target, {
            readonly: true,
            fileMustExist: true,
          });
          try {
            t.equal(
              replacement.pragma('quick_check', { simple: true }),
              'ok',
              'reconnect failure retains the promoted database'
            );
            t.ok(
              replacement
                .prepare(
                  "SELECT name FROM sqlite_master WHERE name = 'SingleValue'"
                )
                .get()
            );
          } finally {
            replacement.close();
          }
        }
        await assertSentinels(t, directory);
      } finally {
        DatabaseManager.prototype._connect = connect;
        DatabaseCore.prototype.migrate = migrate;
        fs.rename = rename;
        await manager.db?.close();
      }
    });
    t.end();
  });
}

test('exclusive promotion rejects a destination created after the final check', async (t) => {
  await withFixture(async (directory, target) => {
    const staged = path.join(directory, 'staged');
    await fs.writeFile(staged, 'owned staging contents');
    const captured = await captureDatabaseTarget(target);
    try {
      await promoteDatabase(staged, captured, () =>
        writeFileSync(target, 'collision sentinel', { flag: 'wx' })
      );
      t.fail('exclusive promotion must fail');
    } catch (error) {
      t.equal((error as NodeJS.ErrnoException).code, 'EEXIST');
    }
    t.equal(await fs.readFile(target, 'utf8'), 'collision sentinel');
    t.equal(await fs.readFile(staged, 'utf8'), 'owned staging contents');
    await assertSentinels(t, directory);
  });
  t.end();
});

test('exclusive creation supports filesystems without hard links and preserves collisions', async (t) => {
  await withFixture(async (directory, target) => {
    const staged = path.join(directory, 'staged');
    const contents = Buffer.alloc(150000, 42);
    await fs.writeFile(staged, contents);
    const link = fs.link;
    fs.link = async () => {
      throw Object.assign(new Error('unsupported fixture'), {
        code: 'ENOTSUP',
      });
    };
    try {
      const captured = await captureDatabaseTarget(target);
      await promoteDatabase(staged, captured);
      t.deepEqual(
        await fs.readFile(target),
        contents,
        'the complete database is copied'
      );
      t.notOk(
        await fs
          .access(staged)
          .then(() => true)
          .catch(() => false)
      );
      await fs.writeFile(staged, contents);
      const absent = path.join(directory, 'collision.db');
      const selected = await captureDatabaseTarget(absent);
      try {
        await promoteDatabase(staged, selected, () =>
          writeFileSync(absent, 'collision sentinel', { flag: 'wx' })
        );
        t.fail('the fallback must preserve a new destination');
      } catch (error) {
        t.equal((error as NodeJS.ErrnoException).code, 'EEXIST');
      }
      t.equal(await fs.readFile(absent, 'utf8'), 'collision sentinel');
      t.deepEqual(await fs.readFile(staged), contents);
      let authorised = true;
      const revoked = path.join(directory, 'revoked.db');
      const revokeTarget = await captureDatabaseTarget(revoked);
      const revokedError = new Error('window revoked fixture');
      fs.link = async () => {
        authorised = false;
        throw Object.assign(new Error('unsupported fixture'), {
          code: 'ENOTSUP',
        });
      };
      try {
        await promoteDatabase(staged, revokeTarget, () => {
          if (!authorised) throw revokedError;
        });
        t.fail('revoked authority must stop the copy');
      } catch (error) {
        t.equal(error, revokedError);
      }
      t.notOk(
        await fs
          .access(revoked)
          .then(() => true)
          .catch(() => false)
      );
      t.deepEqual(await fs.readFile(staged), contents);
    } finally {
      fs.link = link;
    }
  });
  t.end();
});

test('initial connections reject aliased and replaced sidecars before SQLite can open them', async (t) => {
  await withFixture(async (directory, target) => {
    createOriginal(target).close();
    const sidecar = target + '-wal';
    const sentinel = path.join(directory, 'sentinel.txt');
    await fs.link(sentinel, sidecar);
    try {
      await captureDatabaseTarget(target);
      t.fail('hard-linked sidecar must be rejected');
    } catch (error) {
      t.ok(String(error).includes('without aliases'));
    }
    await fs.unlink(sidecar);
    await fs.writeFile(sidecar, 'captured WAL');
    const selected = await captureDatabaseTarget(target);
    await fs.rename(sidecar, sidecar + '.retained');
    await fs.writeFile(sidecar, 'replacement WAL');
    try {
      await assertDatabaseTarget(selected, true, true);
      t.fail('replacement sidecar must be rejected');
    } catch (error) {
      t.ok(String(error).includes('changed after selection'));
    }
    const manager = new DatabaseManager();
    try {
      await manager.connectToDatabase(target, 'in', undefined, selected);
      t.fail('replacement sidecar must not reach SQLite');
    } catch (error) {
      t.ok(String(error).includes('changed after selection'));
    } finally {
      await manager.db?.close();
    }
    t.equal(await fs.readFile(sidecar, 'utf8'), 'replacement WAL');
    t.equal(await fs.readFile(sentinel, 'utf8'), 'unrelated contents');
  });
  t.end();
});

test('exact memory creation stays in memory and a similar filename is staged on disk', async (t) => {
  await withFixture(async (directory) => {
    const manager = new DatabaseManager();
    try {
      t.equal(await manager.createNewDatabase(':memory:', 'in'), 'in');
      t.equal(manager.db!.dbPath, ':memory:');
      t.deepEqual((await fs.readdir(directory)).sort(), [
        'sentinel-directory',
        'sentinel.txt',
      ]);
      const diskPath = path.join(
        directory,
        process.platform === 'win32' ? 'memory.db' : ':memory:'
      );
      t.equal(await manager.createNewDatabase(diskPath, 'in'), 'in');
      t.equal(manager.db!.dbPath, diskPath);
      const disk = new BetterSQLite3(diskPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        t.equal(disk.pragma('quick_check', { simple: true }), 'ok');
      } finally {
        disk.close();
      }
      await assertSentinels(t, directory);
    } finally {
      await manager.db?.close();
    }
  });
  t.end();
});

test('creation refuses an entry replaced during staging', async (t) => {
  await withFixture(async (directory, target) => {
    createOriginal(target).close();
    const manager = new DatabaseManager();
    const connect = DatabaseManager.prototype._connect;
    let replaced = false;
    try {
      DatabaseManager.prototype._connect = async function (
        dbPath,
        mode,
        country
      ) {
        const code = await connect.call(this, dbPath, mode, country);
        if (mode === 'create' && !replaced) {
          replaced = true;
          await fs.rename(target, target + '.original');
          await fs.writeFile(target, 'replacement sentinel');
        }
        return code;
      };
      try {
        await manager.createNewDatabase(target, 'in');
        t.fail('substitution must fail');
      } catch (error) {
        t.ok(String(error).includes('changed after selection'));
      }
      t.equal(await fs.readFile(target, 'utf8'), 'replacement sentinel');
      t.equal(readOriginal(target + '.original'), 'synthetic original');
      await assertSentinels(t, directory);
    } finally {
      DatabaseManager.prototype._connect = connect;
      await manager.db?.close();
    }
  });
  t.end();
});

test('WAL recovery contains committed data and an open sidecar prevents replacement', async (t) => {
  await withFixture(async (directory, target) => {
    const original = createOriginal(target, true);
    const manager = new DatabaseManager();
    try {
      original.exec("INSERT INTO original VALUES ('committed WAL fixture')");
      try {
        await manager.createNewDatabase(target, 'in');
        t.fail('open WAL database must not be replaced');
      } catch (error) {
        t.ok(String(error).includes('Close other database connections'));
      }
      const recovery = new BetterSQLite3(manager.getRecoveryPath(target)!, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const values = recovery
          .prepare('SELECT value FROM original ORDER BY rowid')
          .all() as { value: string }[];
        t.deepEqual(
          values.map((row) => row.value),
          ['synthetic original', 'committed WAL fixture']
        );
      } finally {
        recovery.close();
      }
      t.equal(
        (
          original.prepare('SELECT count(*) AS count FROM original').get() as {
            count: number;
          }
        ).count,
        2
      );
      await assertSentinels(t, directory);
    } finally {
      original.close();
      await manager.db?.close();
    }
  });
  t.end();
});

test('backup failure closes its read-only driver, preserves its error and cleans only its owned directory', async (t) => {
  await withFixture(async (directory, target) => {
    await fs.writeFile(target, 'synthetic source');
    const backupError = Object.assign(new Error('backup fixture'), {
      code: 'BACKUP_FIXTURE',
    });
    const closeError = new Error('close fixture');
    const calls: unknown[] = [];
    const files = loadSource<any>('backend/database/files.ts', {
      path,
      'fs/promises': fs,
      'better-sqlite3': class {
        constructor(filePath: string, options: unknown) {
          calls.push([filePath, options]);
        }
        async backup(filePath: string) {
          await fs.writeFile(filePath, 'partial');
          throw backupError;
        }
        close() {
          calls.push('close');
          throw closeError;
        }
      },
    });
    try {
      await files.backupDatabase(target, path.join(directory, '.backup-'));
      t.fail('backup must fail');
    } catch (error) {
      t.equal(error, backupError);
      t.equal((error as any).code, 'BACKUP_FIXTURE');
      t.deepEqual(Array.from((error as any).cleanupErrors), [
        String(closeError),
      ]);
    }
    t.deepEqual(JSON.parse(JSON.stringify(calls)), [
      [target, { readonly: true, fileMustExist: true }],
      'close',
    ]);
    t.notOk(
      (await fs.readdir(directory)).some((name) => name.startsWith('.backup-'))
    );
    t.equal(await fs.readFile(target, 'utf8'), 'synthetic source');
    await assertSentinels(t, directory);
  });
  t.end();
});

test('successful backups close both drivers and never overwrite a previous recovery', async (t) => {
  await withFixture(async (directory, target) => {
    const closes: string[] = [];
    await fs.writeFile(target, 'first original');
    const files = loadSource<any>('backend/database/files.ts', {
      path,
      'fs/promises': fs,
      'better-sqlite3': class {
        constructor(private filePath: string) {}
        async backup(filePath: string) {
          await fs.copyFile(this.filePath, filePath);
        }
        pragma() {
          return [{ quick_check: 'ok' }];
        }
        close() {
          closes.push(this.filePath);
        }
      },
    });
    const first = await files.backupDatabase(
      target,
      path.join(directory, '.backup-')
    );
    await fs.writeFile(target, 'second original');
    const second = await files.backupDatabase(
      target,
      path.join(directory, '.backup-')
    );
    t.notEqual(first, second);
    t.equal(await fs.readFile(first, 'utf8'), 'first original');
    t.equal(await fs.readFile(second, 'utf8'), 'second original');
    t.deepEqual(closes, [first, target, second, target]);
    await assertSentinels(t, directory);
  });
  t.end();
});

test('cleanup preserves the primary error, attempts every action and surfaces cleanup-only failures', async (t) => {
  const primary = Object.assign(new Error('primary'), {
    code: 'PRIMARY_FIXTURE',
  });
  const close = new Error('destination close');
  const remove = new Error('directory cleanup');
  for (const original of [primary, undefined]) {
    const calls: string[] = [];
    try {
      await finishDatabaseCleanup(original, [
        () => {
          calls.push('close');
          throw close;
        },
        () => {
          calls.push('remove');
          throw remove;
        },
      ]);
      t.fail('cleanup failure must surface');
    } catch (error) {
      t.equal(error, original ?? close);
      if (original) t.equal((error as any).code, 'PRIMARY_FIXTURE');
      t.deepEqual(
        (error as any).cleanupErrors,
        original ? [String(close), String(remove)] : [String(remove)]
      );
    }
    t.deepEqual(calls, ['close', 'remove']);
  }
  t.end();
});

test('temporary directory cleanup refuses unrelated children and changed directory identity', async (t) => {
  await withFixture(async (directory) => {
    const temporary = await fs.mkdtemp(path.join(directory, '.owned-'));
    const identity = await fs.lstat(temporary);
    await fs.writeFile(path.join(temporary, 'sentinel'), 'unrelated');
    try {
      await removeOwnedDatabaseDirectory(temporary, identity);
      t.fail('unexpected child must survive');
    } catch (error) {
      t.ok(String(error).includes('Unexpected entry'));
    }
    t.equal(
      await fs.readFile(path.join(temporary, 'sentinel'), 'utf8'),
      'unrelated'
    );
    await fs.rename(temporary, temporary + '.retained');
    await fs.mkdir(temporary);
    await fs.writeFile(
      path.join(temporary, 'database.db'),
      'replacement sentinel'
    );
    try {
      await removeOwnedDatabaseDirectory(temporary, identity);
      t.fail('changed directory must survive');
    } catch (error) {
      t.ok(String(error).includes('directory changed'));
    }
    t.equal(
      await fs.readFile(path.join(temporary, 'database.db'), 'utf8'),
      'replacement sentinel'
    );
    await assertSentinels(t, directory);
  });
  t.end();
});
