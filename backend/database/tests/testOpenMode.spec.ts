import { constants, promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'tape';
import DatabaseCore from '../core';
import { DatabaseManager } from '../manager';

test('opening a disk database cannot create a missing entry', async (t) => {
  const temporaryRoot = await fs.realpath(tmpdir());
  const directory = await fs.mkdtemp(
    path.join(temporaryRoot, 'books-open-mode-')
  );
  const databases: DatabaseCore[] = [];
  const managers: DatabaseManager[] = [];
  async function connect(target: string, country?: string) {
    const manager = new DatabaseManager();
    managers.push(manager);
    try {
      await manager.connectToDatabase(target, country);
      return undefined;
    } catch (error) {
      return error;
    }
  }
  try {
    for (const country of [undefined, 'in']) {
      const target = path.join(directory, `missing-${country ?? 'probe'}.db`);
      for (let attempt = 0; attempt < 2; attempt++) {
        t.ok(await connect(target, country), 'missing disk connection fails');
        t.deepEqual(
          await fs.readdir(directory),
          [],
          'no file or sidecar created'
        );
      }
    }

    const probePath = path.join(directory, 'missing-country.db');
    let probeError;
    try {
      await DatabaseCore.getCountryCode(probePath);
    } catch (error) {
      probeError = error;
    }
    t.ok(probeError, 'country discovery also requires an existing disk entry');
    t.deepEqual(
      await fs.readdir(directory),
      [],
      'country probe creates no file'
    );

    const existingPath = path.join(directory, 'external arbitrary name');
    const creator = new DatabaseManager();
    managers.push(creator);
    t.equal(await creator.createNewDatabase(existingPath, 'in'), 'in');
    await creator.db!.close();
    t.notOk(await connect(existingPath), 'existing external database opens');
    await managers[managers.length - 1].db!.close();
    const relativePath = path.relative(process.cwd(), existingPath);
    t.notOk(
      await connect(relativePath, 'in'),
      'existing relative database opens'
    );
    await managers[managers.length - 1].db!.close();

    await fs.access(existingPath, constants.R_OK | constants.W_OK);
    await fs.unlink(existingPath);
    t.ok(await connect(existingPath, 'in'), 'removal after access check fails');
    t.deepEqual(
      await fs.readdir(directory),
      [],
      'connection does not recreate it'
    );
    t.ok(
      await connect(path.relative(process.cwd(), existingPath)),
      'missing relative database fails'
    );
    t.deepEqual(
      await fs.readdir(directory),
      [],
      'relative target is not created'
    );

    for (const country of [undefined, 'in']) {
      t.notOk(
        await connect(':memory:', country),
        'exact memory database opens'
      );
    }
    t.deepEqual(
      await fs.readdir(directory),
      [],
      'memory creates no disk files'
    );
    t.ok(await connect(path.join(directory, ':memory:'), 'in'));
    t.deepEqual(
      await fs.readdir(directory),
      [],
      'similar disk filename is missing'
    );

    const sentinel = path.join(directory, 'sentinel.txt');
    await fs.writeFile(sentinel, 'preserve this non-database entry');
    t.ok(await connect(sentinel, 'in'), 'non-database entry fails');
    t.equal(
      await fs.readFile(sentinel, 'utf8'),
      'preserve this non-database entry'
    );

    const core = new DatabaseCore(path.join(directory, 'missing-core.db'));
    databases.push(core);
    let coreError;
    try {
      await core.connect();
    } catch (error) {
      coreError = error;
    }
    t.ok(coreError, 'the core defaults to existing-file mode for disk paths');
    t.deepEqual(await fs.readdir(directory), ['sentinel.txt']);
  } finally {
    for (const manager of managers) {
      if (manager.db?.knex) await manager.db.close();
    }
    for (const database of databases) {
      if (database.knex) await database.close();
    }
    const resolved = await fs.realpath(directory);
    if (
      resolved !== path.resolve(directory) ||
      path.dirname(resolved) !== temporaryRoot ||
      !path.basename(directory).startsWith('books-open-mode-')
    ) {
      throw new Error('Unexpected fixture cleanup path.');
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
  t.end();
});

test('direct disk connects canonicalise parent aliases before probing and reject file aliases', async (t) => {
  const temporaryRoot = await fs.realpath(tmpdir());
  const directory = await fs.mkdtemp(
    path.join(temporaryRoot, 'books-open-mode-')
  );
  const managers: DatabaseManager[] = [];
  const probe = DatabaseCore.getCountryCode;
  const probes: string[] = [];
  DatabaseCore.getCountryCode = async function (dbPath, mode) {
    probes.push(dbPath);
    return probe.call(this, dbPath, mode);
  };
  try {
    const sentinel = path.join(directory, 'sentinel.txt');
    await fs.writeFile(sentinel, 'unrelated sentinel');
    const parent = path.join(directory, 'real-parent');
    const alias = path.join(directory, 'parent-alias');
    await fs.mkdir(parent);
    let parentAlias = true;
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
      parentAlias = false;
      t.skip('parent symlink requires Windows privilege');
    }
    if (parentAlias) {
      const target = path.join(alias, 'database.db');
      const canonical = path.join(parent, 'database.db');
      const manager = new DatabaseManager();
      managers.push(manager);
      t.equal(await manager._connect(target, 'create'), 'in');
      t.equal(manager.db!.dbPath, canonical);
      await manager.db!.migrate();
      await manager.db!.update('SystemSettings', { version: '0.5.0-beta.0' });
      await manager.db!.close();
      const reopened = new DatabaseManager();
      managers.push(reopened);
      t.equal(await reopened.connectToDatabase(target), 'in');
      t.equal(reopened.db!.dbPath, canonical);
      t.deepEqual(
        probes,
        [canonical, canonical],
        'country probes receive only canonical disk paths'
      );
      await reopened.db!.close();
    }

    const hardlink = path.join(directory, 'hardlink.db');
    const folder = path.join(directory, 'directory.db');
    const fileAlias = path.join(directory, 'file-alias.db');
    await fs.link(sentinel, hardlink);
    await fs.mkdir(folder);
    const targets = [hardlink, folder];
    try {
      await fs.symlink(sentinel, fileAlias);
      targets.push(fileAlias);
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      ) {
        throw error;
      }
      t.skip('file symlink requires Windows privilege');
    }
    const probesBeforeRefusals = probes.length;
    for (const target of targets) {
      for (const mode of ['create', 'existing'] as const) {
        const manager = new DatabaseManager();
        managers.push(manager);
        try {
          await manager._connect(target, mode);
          t.fail('file aliases and nonregular entries must reject');
        } catch (error) {
          t.ok(String(error).includes('regular database file'));
        }
        t.equal(
          manager.db,
          undefined,
          'refusal precedes DatabaseCore construction'
        );
      }
    }
    t.equal(
      probes.length,
      probesBeforeRefusals,
      'refusal precedes country probing'
    );
    t.equal(await fs.readFile(sentinel, 'utf8'), 'unrelated sentinel');
    t.equal(await fs.readFile(hardlink, 'utf8'), 'unrelated sentinel');
    t.deepEqual(await fs.readdir(folder), []);
  } finally {
    DatabaseCore.getCountryCode = probe;
    for (const manager of managers) await manager.db?.close();
    const resolved = await fs.realpath(directory);
    if (
      resolved !== path.resolve(directory) ||
      path.dirname(resolved) !== temporaryRoot ||
      !path.basename(directory).startsWith('books-open-mode-')
    ) {
      throw new Error('Unexpected fixture cleanup path.');
    }
    await fs.rm(directory, { recursive: true });
  }
  t.end();
});
