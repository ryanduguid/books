import { rejects } from 'assert';
import { constants, promises as fs } from 'fs';
import path from 'path';
import test from 'tape';
import { getHandlers, withFixture } from './databaseIpcFixture';

test('database access probes reject foreign senders before filesystem lookup', async (t) => {
  await withFixture(async (directory) => {
    const target = path.join(directory, 'company.db');
    await fs.writeFile(target, 'synthetic database');
    for (const change of [
      'missing',
      'sender',
      'frame',
      'destroyed-sender',
      'destroyed-window',
      'no-window',
    ]) {
      const fixture = getHandlers(directory);
      await fixture.grant('connect', target);
      fixture.calls.targetLookups.length = 0;
      let event: any = fixture.event;
      if (change === 'missing') event = null;
      else if (change === 'sender') event = { ...event, sender: {} };
      else if (change === 'frame') event = { ...event, senderFrame: {} };
      else if (change === 'destroyed-sender')
        fixture.event.sender.isDestroyed = () => true;
      else if (change === 'destroyed-window')
        fixture.window.isDestroyed = () => true;
      else fixture.main.mainWindow = undefined as any;
      await rejects(
        fixture.handlers['check-db-access'](event, target),
        /active main window sender/
      );
      t.pass(`${change} rejects`);
      t.deepEqual(fixture.calls.access, [], `${change} cannot probe`);
      t.deepEqual(
        fixture.calls.targetLookups,
        [],
        `${change} cannot inspect a target`
      );
    }
  });
  t.end();
});

test('database access probes need a Connect grant and valid path', async (t) => {
  await withFixture(async (directory) => {
    const target = path.join(directory, 'company.db');
    await fs.writeFile(target, 'synthetic database');
    const fixture = getHandlers(directory);
    for (const value of [
      '',
      'invalid\0path',
      {},
      [],
      1,
      null,
      undefined,
      target,
      ':memory:',
      String.raw`\\fixture.invalid\share\company.db`,
    ]) {
      await rejects(
        fixture.handlers['check-db-access'](fixture.event, value),
        /Invalid database path|no authority/
      );
      t.pass('invalid or unselected input rejects');
    }
    t.deepEqual(fixture.calls.access, [], 'unselected input cannot probe');
    t.deepEqual(
      fixture.calls.targetLookups,
      [],
      'unselected input cannot inspect a target'
    );
    for (const operation of ['create', 'delete'] as const) {
      const selected = getHandlers(directory);
      await selected.grant(operation, target);
      selected.calls.targetLookups.length = 0;
      await rejects(
        selected.handlers['check-db-access'](selected.event, target),
        /no authority/
      );
      t.pass(`${operation} authority cannot authorise an access probe`);
      t.deepEqual(selected.calls.access, []);
      t.deepEqual(selected.calls.targetLookups, []);
    }
  });
  t.end();
});

test('selected database access probes retain Connect authority and Boolean results', async (t) => {
  await withFixture(async (directory) => {
    const target = path.join(directory, 'company.db');
    await fs.writeFile(target, 'synthetic database');
    const fixture = getHandlers(directory);
    const selection = await fixture.grant('connect', target);
    t.equal(selection.filePaths[0], target);
    const probe = () =>
      fixture.handlers['check-db-access'](
        fixture.event,
        directory + path.sep + '.' + path.sep + 'company.db'
      );
    t.equal(
      await probe(),
      true,
      'native-selected file is accessible before connection'
    );
    t.equal(await probe(), true, 'probing does not consume the grant');
    fixture.duringAccess(() => {
      throw Object.assign(new Error('denied fixture'), { code: 'EACCES' });
    });
    t.equal(
      await probe(),
      false,
      'permitted accessibility failure returns false'
    );
    fixture.duringAccess(() => {});
    t.notOk(
      (await fixture.invoke('connect', target)).error,
      'grant remains usable by DB_CONNECT without reselection'
    );
    t.equal(fixture.calls.selections.length, 1);
    t.deepEqual(
      fixture.calls.access,
      Array.from({ length: 3 }, () => ({
        path: target,
        mode: constants.R_OK | constants.W_OK,
      })),
      'only the canonical selected path is probed'
    );
    t.equal(fixture.calls.connect.length, 1);
  });
  t.end();
});

test('database access probes revoke stale targets before accessibility checks', async (t) => {
  await withFixture(async (directory) => {
    const target = path.join(directory, 'company.db');
    await fs.writeFile(target, 'synthetic database');
    const fixture = getHandlers(directory);
    await fixture.grant('connect', target);
    await fs.rename(target, target + '.retained');
    await fs.writeFile(target, 'replacement sentinel');
    await rejects(
      fixture.handlers['check-db-access'](fixture.event, target),
      /entry changed/
    );
    t.pass('replaced target rejects');
    t.deepEqual(fixture.calls.access, []);
    fixture.calls.targetLookups.length = 0;
    await rejects(
      fixture.handlers['check-db-access'](fixture.event, target),
      /no authority/
    );
    t.pass('the stale grant is revoked');
    t.deepEqual(
      fixture.calls.targetLookups,
      [],
      'revoked grant cannot inspect the replacement'
    );
    t.equal(await fs.readFile(target, 'utf8'), 'replacement sentinel');
    t.equal(
      await fs.readFile(target + '.retained', 'utf8'),
      'synthetic database'
    );
  });
  t.end();
});

test('pending database access probes reject changed owners on success and failure', async (t) => {
  await withFixture(async (directory) => {
    const target = path.join(directory, 'company.db');
    await fs.writeFile(target, 'synthetic database');
    for (const change of ['window', 'frame']) {
      for (const denied of [false, true]) {
        const fixture = getHandlers(directory);
        await fixture.grant('connect', target);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        fixture.duringAccess(async () => {
          entered();
          await pending;
          if (denied) throw new Error('denied fixture');
        });
        const probe = fixture.handlers['check-db-access'](
          fixture.event,
          target
        );
        await started;
        if (change === 'window')
          fixture.main.mainWindow = { ...fixture.window };
        else fixture.window.webContents.mainFrame = {};
        release();
        await rejects(probe, /window changed|active main window sender/);
        t.pass(
          `${change} rejects after ${denied ? 'denied' : 'successful'} access`
        );
        t.equal(
          fixture.calls.access.length,
          1,
          'probe began under the selected authority'
        );
      }
    }
  });
  t.end();
});

test('a new valid database owner cannot reuse the previous Connect grant', async (t) => {
  await withFixture(async (directory) => {
    const target = path.join(directory, 'company.db');
    await fs.writeFile(target, 'synthetic database');
    for (const change of ['window', 'frame']) {
      const fixture = getHandlers(directory);
      await fixture.grant('connect', target);
      fixture.calls.targetLookups.length = 0;
      const frame = {};
      let sender = fixture.event.sender;
      if (change === 'window') {
        sender = { isDestroyed: () => false, mainFrame: frame };
        fixture.main.mainWindow = {
          isDestroyed: () => false,
          webContents: sender,
        };
      } else fixture.window.webContents.mainFrame = frame;
      const event = { sender, senderFrame: frame };
      await rejects(
        fixture.handlers['check-db-access'](event, target),
        /different window or sender/
      );
      t.pass(`${change} rejects the former owner's grant`);
      t.deepEqual(fixture.calls.access, []);
      t.deepEqual(fixture.calls.targetLookups, []);
      await rejects(
        fixture.handlers['check-db-access'](event, target),
        /no authority/
      );
      t.pass('the former grant is revoked');
    }
  });
  t.end();
});

test('database access uses the canonical selection from an aliased parent', async (t) => {
  await withFixture(async (directory) => {
    const parent = path.join(directory, 'parent');
    const alias = path.join(directory, 'alias');
    await fs.mkdir(parent);
    await fs.symlink(parent, alias);
    const target = path.join(parent, 'company.db');
    const selected = path.join(alias, 'company.db');
    await fs.writeFile(target, 'synthetic database');
    const fixture = getHandlers(directory);
    const selection = await fixture.grant('connect', selected);
    t.equal(
      selection.filePaths[0],
      target,
      'native selection returns the canonical path'
    );
    fixture.calls.targetLookups.length = 0;
    await rejects(
      fixture.handlers['check-db-access'](fixture.event, selected),
      /no authority/
    );
    t.pass('an unregistered alias cannot be probed');
    t.deepEqual(fixture.calls.access, []);
    t.deepEqual(fixture.calls.targetLookups, []);
    t.equal(
      await fixture.handlers['check-db-access'](
        fixture.event,
        selection.filePaths[0]
      ),
      true
    );
    t.deepEqual(fixture.calls.access, [
      { path: target, mode: constants.R_OK | constants.W_OK },
    ]);
    t.notOk((await fixture.invoke('connect', target)).error);
    t.equal(
      fixture.calls.selections.length,
      1,
      'connection reuses the canonical grant'
    );
  });
  t.end();
});
