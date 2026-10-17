import { promises as fs } from 'fs';
import path from 'path';
import test from 'tape';
import { cancelledCode, getHandlers, withFixture } from './databaseIpcFixture';

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
    for (const action of ['delete-file', 'db-create', 'db-connect'] as const) {
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
    for (const action of ['db-connect', 'db-create', 'delete-file'] as const) {
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
      const selectedPath =
        operation === 'create'
          ? (await fixture.grant('create', lexical)).filePath!
          : (await fixture.grant(operation, lexical)).filePaths[0];
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
        t.deepEqual(Array.from(options.buttons!), [
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
      const detail = fixture.calls.dialogs[0].options.detail!;
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
