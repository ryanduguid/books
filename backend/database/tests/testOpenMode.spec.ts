import { constants, promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'tape';
import DatabaseCore from '../core';
import { DatabaseManager } from '../manager';

test('opening a disk database cannot create a missing entry', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'books-open-mode-'));
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
    await fs.rm(directory, { recursive: true, force: true });
  }
  t.end();
});
