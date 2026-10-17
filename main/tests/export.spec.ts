import { randomUUID } from 'crypto';
import { rejects } from 'assert';
import BetterSQLite3 from 'better-sqlite3';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'tape';
import { loadSource } from './helpers';

async function fixture(overrides: Partial<typeof fs> = {}) {
  const temporaryRoot = await fs.realpath(tmpdir());
  const directory = await fs.mkdtemp(
    path.join(temporaryRoot, 'books-export-test-')
  );
  const frame = {};
  const sender = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: sender, isDestroyed: () => false };
  const event = { sender, senderFrame: frame };
  const main = { mainWindow: window };
  const filesystem = { ...fs, ...overrides };
  const files = loadSource<any>('backend/database/files.ts', {
    'fs/promises': filesystem,
    path,
  });
  const { DatabasePathAuthority } = loadSource<any>(
    'main/databasePathAuthority.ts',
    {
      '../backend/database/files': files,
    }
  );
  let selectedPath = path.join(directory, 'export');
  let canceled = false;
  let response = 1;
  let onConfirm: () => Promise<void> = async () => {};
  const dialogs: any[] = [];
  const protectedPaths: string[] = [];
  const { ExportPathAuthority } = loadSource<any>(
    'main/exportPathAuthority.ts',
    {
      'fs/promises': filesystem,
      crypto: { randomUUID },
      path,
      '../backend/database/files': files,
      './helpers': loadSource<any>('main/helpers.ts'),
      electron: {
        dialog: {
          showSaveDialog: async () => ({ canceled, filePath: selectedPath }),
          showMessageBox: async (parent: unknown, options: unknown) => {
            dialogs.push({ parent, options });
            await onConfirm();
            return { response };
          },
        },
      },
    }
  );
  const authority = new ExportPathAuthority(
    new DatabasePathAuthority(main),
    () => protectedPaths
  );
  return {
    directory,
    event,
    main,
    window,
    authority,
    dialogs,
    protectedPaths,
    select: (format = 'csv') => authority.select(event, 'export', format),
    setPath: (value: string) => {
      selectedPath = value;
    },
    cancel: () => {
      canceled = true;
    },
    decline: () => {
      response = 0;
    },
    duringConfirmation: (action: () => Promise<void>) => {
      onConfirm = action;
    },
    async close() {
      const resolved = await fs.realpath(directory);
      if (
        resolved !== path.resolve(directory) ||
        path.dirname(resolved) !== temporaryRoot ||
        !path.basename(directory).startsWith('books-export-test-')
      ) {
        throw new Error('Unexpected fixture cleanup path.');
      }
      await fs.rm(directory, { recursive: true });
    },
  };
}

test('short reads still protect a real renamed SQLite database', async (t) => {
  const f = await fixture({
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      const read = file.read.bind(file);
      (file as any).read = (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number
      ) => read(buffer, offset, Math.min(length, 8), position);
      return file;
    },
  });
  try {
    const target = path.join(f.directory, 'renamed.csv');
    const database = new BetterSQLite3(target);
    database.exec(
      "CREATE TABLE original AS SELECT 'accounting sentinel' AS value"
    );
    database.close();
    const before = await fs.readFile(target);
    f.setPath(target);
    await rejects(f.select(), /SQLite data/);
    t.deepEqual(await fs.readFile(target), before);
    t.equal(f.dialogs.length, 0, 'protected data gets no replace consent');
  } finally {
    await f.close();
  }
  t.end();
});

test('export header read failure survives a simultaneous close failure', async (t) => {
  const primary = new Error('header read fixture');
  const f = await fixture({
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      const close = file.close.bind(file);
      (file as any).read = async () => {
        throw primary;
      };
      file.close = async () => {
        await close();
        throw new Error('close fixture');
      };
      return file;
    },
  });
  try {
    const target = path.join(f.directory, 'report.csv');
    await fs.writeFile(target, 'preserve this');
    f.setPath(target);
    try {
      await f.select();
      t.fail('header failure must reject');
    } catch (error) {
      t.equal(error, primary);
    }
    t.ok(
      (
        primary as Error & { cleanupErrors: string[] }
      ).cleanupErrors[0].includes('close fixture')
    );
    t.equal(await fs.readFile(target, 'utf8'), 'preserve this');
  } finally {
    await f.close();
  }
  t.end();
});

test('export consent distinguishes whitespace and direction controls in filenames', async (t) => {
  const f = await fixture();
  try {
    for (const name of ['report\n.csv', 'report .csv', 'report\u202e.csv']) {
      const target = path.join(f.directory, name);
      f.setPath(target);
      await f.select();
      t.equal(
        f.dialogs[f.dialogs.length - 1].options.detail,
        JSON.stringify(target).replace('\u202e', '\\u202e')
      );
    }
    t.notEqual(f.dialogs[0].options.detail, f.dialogs[1].options.detail);
  } finally {
    await f.close();
  }
  t.end();
});

test('export permission binds final path, writer and active main frame, and is used once', async (t) => {
  const f = await fixture();
  try {
    f.setPath(path.join(f.directory, 'mycsv'));
    let selection = await f.select();
    t.equal(selection.filePath, path.join(f.directory, 'mycsv.csv'));
    t.equal(f.dialogs[0].options.defaultId, 0);
    t.equal(f.dialogs[0].options.cancelId, 0);
    t.equal(f.dialogs[0].parent, f.window);
    t.equal(f.dialogs[0].options.detail, JSON.stringify(selection.filePath));
    let grant = f.authority.consume(
      f.event,
      'text',
      selection.filePath,
      selection.grantId
    );
    await f.authority.write(grant, 'approved data');
    t.equal(await fs.readFile(selection.filePath, 'utf8'), 'approved data');
    t.throws(() =>
      f.authority.consume(
        f.event,
        'text',
        selection.filePath,
        selection.grantId
      )
    );
    t.throws(() =>
      f.authority.consume(f.event, 'text', selection.filePath, undefined)
    );
    selection = await f.select();
    t.throws(() =>
      f.authority.consume(f.event, 'pdf', selection.filePath, selection.grantId)
    );
    selection = await f.select();
    t.throws(() =>
      f.authority.consume(
        f.event,
        'text',
        path.join(f.directory, 'forged.csv'),
        selection.grantId
      )
    );
    selection = await f.select();
    t.throws(() =>
      f.authority.consume(
        { ...f.event, senderFrame: {} },
        'text',
        selection.filePath,
        selection.grantId
      )
    );
    selection = await f.select();
    grant = f.authority.consume(
      f.event,
      'text',
      selection.filePath,
      selection.grantId
    );
    f.main.mainWindow = { ...f.window };
    await rejects(f.authority.write(grant, 'unauthorised'));
    t.pass('changed window rejected');
    t.equal(await fs.readFile(selection.filePath, 'utf8'), 'approved data');
  } finally {
    await f.close();
  }
  t.end();
});

test('parent-alias export selection displays and grants only the canonical destination', async (t) => {
  const f = await fixture();
  try {
    const parent = path.join(f.directory, 'real-parent');
    const alias = path.join(f.directory, 'parent-alias');
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
      aliasCreated = false;
      t.skip('parent symlink requires Windows privilege');
    }
    if (aliasCreated) {
      const lexical = path.join(alias, 'report.csv');
      const canonical = path.join(parent, 'report.csv');
      await fs.writeFile(path.join(parent, 'sentinel'), 'unrelated');
      f.setPath(lexical);
      let selection = await f.select();
      t.equal(selection.filePath, canonical);
      t.equal(f.dialogs[0].options.detail, JSON.stringify(canonical));
      t.throws(() =>
        f.authority.consume(f.event, 'text', lexical, selection.grantId)
      );
      t.deepEqual(
        await fs.readdir(parent),
        ['sentinel'],
        'ungranted lexical alias cannot write'
      );
      selection = await f.select();
      const grant = f.authority.consume(
        f.event,
        'text',
        selection.filePath,
        selection.grantId
      );
      await f.authority.write(grant, 'approved export');
      t.equal(await fs.readFile(canonical, 'utf8'), 'approved export');
      t.equal(
        await fs.readFile(path.join(parent, 'sentinel'), 'utf8'),
        'unrelated'
      );
    }
  } finally {
    await f.close();
  }
  t.end();
});

test('cancelled selection and confirmation revoke unused export permission', async (t) => {
  for (const decline of [false, true]) {
    const f = await fixture();
    try {
      const selection = await f.select();
      if (decline) f.decline();
      else f.cancel();
      const cancelled = await f.select();
      t.equal(cancelled.canceled, true);
      t.equal(cancelled.filePath, undefined);
      t.equal(cancelled.grantId, undefined);
      t.throws(() =>
        f.authority.consume(
          f.event,
          'text',
          selection.filePath,
          selection.grantId
        )
      );
      t.equal((await fs.readdir(f.directory)).length, 0);
    } finally {
      await f.close();
    }
  }
  t.end();
});

test('exports protect database content, sidecars, registered paths and recovery folders', async (t) => {
  for (const mode of [
    'sqlite',
    'wal',
    'journal',
    'sidecar',
    'registered',
    'recovery',
    'hardlink',
    'symlink',
  ]) {
    const f = await fixture();
    try {
      let target = path.join(f.directory, 'financial.csv');
      let content = Buffer.from('preserve me');
      if (mode === 'sqlite')
        content = Buffer.from('SQLite format 3\0corrupted database');
      if (mode === 'wal') content = Buffer.from('377f0682', 'hex');
      if (mode === 'journal') content = Buffer.from('d9d505f920a163d7', 'hex');
      if (mode === 'recovery') {
        const recovery = path.join(f.directory, '.company.recovery-test');
        await fs.mkdir(recovery);
        target = path.join(recovery, 'renamed.csv');
      }
      await fs.writeFile(target, content);
      if (mode === 'sidecar') await fs.writeFile(target + '-wal', 'wal');
      if (mode === 'registered') f.protectedPaths.push(target);
      if (mode === 'hardlink' || mode === 'symlink') {
        const alias = path.join(f.directory, 'alias.csv');
        if (mode === 'hardlink') await fs.link(target, alias);
        else await fs.symlink(target, alias);
        target = alias;
      }
      f.setPath(target);
      await rejects(f.select());
      t.pass(`${mode} rejected`);
      t.deepEqual(await fs.readFile(target), content, `${mode} preserved`);
    } finally {
      await f.close();
    }
  }
  t.end();
});

test('exports reject final-path replacement during consent and during PDF rendering', async (t) => {
  for (const rendering of [false, true]) {
    const f = await fixture();
    try {
      const target = path.join(f.directory, 'report.pdf');
      f.setPath(target);
      await fs.writeFile(target, 'old export');
      const replace = async () => {
        await fs.rename(target, target + '.original');
        await fs.writeFile(target, 'replacement sentinel');
      };
      if (!rendering) {
        f.duringConfirmation(replace);
        await rejects(f.select('pdf'));
      } else {
        const selection = await f.select('pdf');
        const grant = f.authority.consume(
          f.event,
          'pdf',
          selection.filePath,
          selection.grantId
        );
        await replace();
        await rejects(f.authority.write(grant, Buffer.from('pdf result')));
      }
      t.equal(await fs.readFile(target, 'utf8'), 'replacement sentinel');
      t.equal(await fs.readFile(target + '.original', 'utf8'), 'old export');
    } finally {
      await f.close();
    }
  }
  t.end();
});

test('ordinary exports can replace a confirmed file without retaining trailing bytes', async (t) => {
  const f = await fixture();
  try {
    const target = path.join(f.directory, 'export.json');
    await fs.writeFile(target, 'a much longer original file');
    f.setPath(target);
    const selection = await f.select('json');
    const grant = f.authority.consume(
      f.event,
      'text',
      selection.filePath,
      selection.grantId
    );
    await f.authority.write(grant, '{}');
    t.equal(await fs.readFile(target, 'utf8'), '{}');
    t.equal(f.dialogs[0].options.buttons.join(','), 'Cancel,Replace');
  } finally {
    await f.close();
  }
  t.end();
});

test('printing owns separate temporary files and closes windows on every outcome', async (t) => {
  for (const mode of [
    'success',
    'load failure',
    'render failure',
    'concurrent',
  ]) {
    const f = await fixture();
    const windows: any[] = [];
    const failure = new Error(mode);
    const { withPrintWindow } = loadSource<any>('main/printWindow.ts', {
      'fs/promises': fs,
      path,
      electron: {
        BrowserWindow: class {
          destroyed = false;
          file = '';
          constructor() {
            windows.push(this);
          }
          async loadFile(file: string) {
            this.file = file;
            if (mode === 'load failure') throw failure;
          }
          isDestroyed() {
            return this.destroyed;
          }
          destroy() {
            this.destroyed = true;
          }
        },
      },
    });
    try {
      await fs.writeFile(
        path.join(f.directory, 'temp-print.html'),
        'unrelated sentinel'
      );
      const render = async (window: any) => {
        if (mode === 'render failure') throw failure;
        if (process.platform !== 'win32') {
          t.equal(
            (await fs.stat(window.file)).mode & 0o077,
            0,
            'print HTML has private POSIX permissions'
          );
        }
        return fs.readFile(window.file, 'utf8');
      };
      const app = { getPath: () => f.directory };
      if (mode.endsWith('failure')) {
        try {
          await withPrintWindow(mode, app, 20, 30, render);
          t.fail('must reject');
        } catch (error) {
          t.equal(error, failure, 'primary error preserved');
        }
      } else if (mode === 'concurrent') {
        t.deepEqual(
          await Promise.all(
            ['first', 'second'].map((html) =>
              withPrintWindow(html, app, 20, 30, render)
            )
          ),
          ['first', 'second']
        );
        t.notEqual(windows[0].file, windows[1].file);
      } else t.equal(await withPrintWindow(mode, app, 20, 30, render), mode);
      t.ok(windows.every((window) => window.destroyed));
      t.deepEqual(await fs.readdir(f.directory), ['temp-print.html']);
      t.equal(
        await fs.readFile(path.join(f.directory, 'temp-print.html'), 'utf8'),
        'unrelated sentinel'
      );
    } finally {
      await f.close();
    }
  }
  t.end();
});

test('print failures preserve every rejected value and close each opened file once', async (t) => {
  const cases = [
    ...['write', 'render', 'close'].flatMap((mode) =>
      [
        new Error(mode + ' fixture'),
        Object.freeze(new Error(mode + ' frozen fixture')),
        undefined,
        null,
        false,
        0,
        '',
        'primitive',
        true,
        1,
        1n,
        Symbol('primitive'),
      ].map((primary) => ({ mode, primary }))
    ),
    { mode: 'stat', primary: new Error('stat fixture') },
    { mode: 'stat', primary: Object.freeze(new Error('stat frozen fixture')) },
    { mode: 'false', primary: undefined },
    { mode: 'success', primary: undefined },
  ];
  for (const { mode, primary } of cases) {
    const f = await fixture();
    const closeError = mode === 'close' ? primary : new Error('close fixture');
    const calls = { close: 0, destroy: 0, unlink: 0, rmdir: 0, render: 0 };
    const { withPrintWindow } = loadSource<any>('main/printWindow.ts', {
      path,
      'fs/promises': {
        ...fs,
        open: async (...args: Parameters<typeof fs.open>) => {
          t.equal(args[1], 'wx', 'print HTML is created exclusively');
          t.equal(
            args[2],
            0o600,
            'print HTML is created with private permissions'
          );
          const file = await fs.open(...args);
          const close = file.close.bind(file);
          if (mode === 'stat')
            file.stat = async () => {
              throw primary;
            };
          if (mode === 'write')
            file.writeFile = async () => {
              throw primary;
            };
          file.close = async () => {
            calls.close++;
            await close();
            if (['stat', 'write', 'close'].includes(mode)) throw closeError;
          };
          return file;
        },
        unlink: async (file: Parameters<typeof fs.unlink>[0]) => {
          calls.unlink++;
          await fs.unlink(file);
        },
        rmdir: async (directory: Parameters<typeof fs.rmdir>[0]) => {
          calls.rmdir++;
          await fs.rmdir(directory);
        },
      },
      electron: {
        BrowserWindow: class {
          async loadFile() {}
          isDestroyed() {
            return false;
          }
          destroy() {
            calls.destroy++;
          }
        },
      },
    });
    try {
      await fs.writeFile(path.join(f.directory, 'sentinel'), 'unrelated');
      let rejected = false;
      let failure;
      let result;
      try {
        result = await withPrintWindow(
          'private HTML',
          { getPath: () => f.directory },
          20,
          30,
          async () => {
            calls.render++;
            if (mode === 'render') throw primary;
            return mode === 'false' ? false : 'rendered result';
          }
        );
      } catch (error) {
        rejected = true;
        failure = error;
      }
      const mustReject = !['false', 'success'].includes(mode);
      t.equal(rejected, mustReject, `${mode} has the correct Promise outcome`);
      if (mustReject)
        t.equal(failure, primary, 'exact rejection identity retained');
      else t.equal(result, mode === 'false' ? false : 'rendered result');
      t.equal(calls.close, 1, 'opened handle is closed exactly once');
      const rendered = ['render', 'false', 'success'].includes(mode);
      t.equal(calls.render, Number(rendered));
      t.equal(
        calls.destroy,
        Number(rendered),
        'every acquired window is destroyed'
      );
      t.equal(
        calls.unlink,
        mode === 'stat' ? 0 : 1,
        'only verified HTML is unlinked'
      );
      t.equal(calls.rmdir, 1, 'directory cleanup is attempted');
      if (primary instanceof Error) {
        const diagnostics = (primary as Error & { cleanupErrors?: string[] })
          .cleanupErrors;
        if (!Object.isExtensible(primary)) {
          t.equal(diagnostics, undefined, 'frozen primary is not modified');
        } else if (mode === 'write' || mode === 'stat') {
          t.equal(
            diagnostics?.[0],
            String(closeError),
            'close failure is secondary'
          );
          if (mode === 'stat')
            t.equal(diagnostics?.length, 2, 'unverified file is retained');
        } else t.equal(diagnostics, undefined, 'no invented secondary error');
      }
      const retained = (await fs.readdir(f.directory)).filter(
        (name) => name !== 'sentinel'
      );
      t.equal(retained.length, mode === 'stat' ? 1 : 0);
      if (mode === 'stat') {
        t.deepEqual(await fs.readdir(path.join(f.directory, retained[0])), [
          'document.html',
        ]);
      }
      t.equal(
        await fs.readFile(path.join(f.directory, 'sentinel'), 'utf8'),
        'unrelated'
      );
    } finally {
      await f.close();
    }
  }
  t.end();
});

test('print cleanup refuses replaced file and directory identities', async (t) => {
  for (const mode of ['file', 'directory']) {
    const f = await fixture();
    let htmlPath = '';
    let destructions = 0;
    const { withPrintWindow } = loadSource<any>('main/printWindow.ts', {
      'fs/promises': fs,
      path,
      electron: {
        BrowserWindow: class {
          async loadFile(file: string) {
            htmlPath = file;
          }
          isDestroyed() {
            return false;
          }
          destroy() {
            destructions++;
          }
        },
      },
    });
    try {
      await fs.writeFile(path.join(f.directory, 'sentinel'), 'unrelated');
      try {
        await withPrintWindow(
          'private HTML',
          { getPath: () => f.directory },
          20,
          30,
          async () => {
            if (mode === 'file')
              await fs.rename(htmlPath, htmlPath + '.original');
            else {
              await fs.rename(
                path.dirname(htmlPath),
                path.dirname(htmlPath) + '.original'
              );
              await fs.mkdir(path.dirname(htmlPath));
            }
            await fs.writeFile(htmlPath, 'replacement sentinel');
            return true;
          }
        );
        t.fail('cleanup-only identity failure must reject');
      } catch (error) {
        t.ok(error instanceof Error);
        t.ok(
          (error as Error & { cleanupErrors: string[] }).cleanupErrors.some(
            (diagnostic) => diagnostic.includes('changed ' + mode)
          )
        );
      }
      t.equal(destructions, 1, 'window destruction is still attempted');
      t.equal(await fs.readFile(htmlPath, 'utf8'), 'replacement sentinel');
      const originalPath =
        mode === 'file'
          ? htmlPath + '.original'
          : path.join(path.dirname(htmlPath) + '.original', 'document.html');
      t.equal(await fs.readFile(originalPath, 'utf8'), 'private HTML');
      t.equal(
        await fs.readFile(path.join(f.directory, 'sentinel'), 'utf8'),
        'unrelated'
      );
    } finally {
      await f.close();
    }
  }
  t.end();
});

test('export opening and failed-write cleanup preserve replaced files and folders', async (t) => {
  for (const mode of [
    'file replacement',
    'folder replacement',
    'write failure',
    'replaced write failure',
  ]) {
    let armed = false;
    const primary = new Error('export write fixture');
    const f = await fixture({
      open: async (...args: Parameters<typeof fs.open>) => {
        const target = String(args[0]);
        if (armed && args[1] === 'r+' && mode === 'file replacement') {
          await fs.rename(target, target + '.original');
          await fs.writeFile(target, 'replacement sentinel');
        }
        if (armed && args[1] === 'wx' && mode === 'folder replacement') {
          await fs.rename(
            path.dirname(target),
            path.dirname(target) + '.original'
          );
          await fs.mkdir(path.dirname(target));
          await fs.writeFile(
            path.join(path.dirname(target), 'sentinel'),
            'replacement folder'
          );
        }
        const file = await fs.open(...args);
        if (armed && args[1] === 'wx' && mode.endsWith('write failure')) {
          file.writeFile = async () => {
            if (mode === 'replaced write failure') {
              await fs.rename(target, target + '.original');
              await fs.writeFile(target, 'replacement sentinel');
            }
            throw primary;
          };
        }
        return file;
      },
    });
    try {
      const parent = path.join(f.directory, 'destination');
      await fs.mkdir(parent);
      await fs.writeFile(path.join(parent, 'sentinel'), 'original folder');
      const target = path.join(parent, 'report.csv');
      if (mode === 'file replacement')
        await fs.writeFile(target, 'original export');
      f.setPath(target);
      const selection = await f.select();
      const grant = f.authority.consume(
        f.event,
        'text',
        selection.filePath,
        selection.grantId
      );
      armed = true;
      try {
        await f.authority.write(grant, 'unapproved replacement');
        t.fail('changed or failed output must reject');
      } catch (error) {
        if (mode.endsWith('write failure')) t.equal(error, primary);
        else t.ok(error instanceof Error);
      }
      if (mode.includes('file') || mode === 'replaced write failure') {
        t.equal(await fs.readFile(target, 'utf8'), 'replacement sentinel');
        if (mode === 'file replacement')
          t.equal(
            await fs.readFile(target + '.original', 'utf8'),
            'original export'
          );
        else
          t.ok(
            (primary as Error & { cleanupErrors: string[] }).cleanupErrors.some(
              (error) => error.includes('changed file')
            )
          );
      } else {
        await rejects(fs.stat(target), { code: 'ENOENT' });
        t.pass('owned failed output removed');
      }
      t.equal(
        await fs.readFile(path.join(parent, 'sentinel'), 'utf8'),
        mode === 'folder replacement' ? 'replacement folder' : 'original folder'
      );
      if (mode === 'folder replacement')
        t.equal(
          await fs.readFile(
            path.join(parent + '.original', 'sentinel'),
            'utf8'
          ),
          'original folder'
        );
    } finally {
      await f.close();
    }
  }
  t.end();
});

test('print cleanup failures retain every render rejection and reject cleanup-only failures', async (t) => {
  const cases = ['destroy', 'unlink', 'rmdir'].flatMap((mode) => [
    ...[
      new Error('render fixture'),
      Object.freeze(new Error('render frozen fixture')),
      undefined,
      null,
      false,
      0,
      '',
      'primitive',
      true,
      1,
      1n,
      Symbol('primitive'),
    ].map((primary) => ({ mode, primary, rejectRender: true })),
    { mode, primary: undefined, rejectRender: false },
  ]);
  for (const { mode, primary, rejectRender } of cases) {
    const f = await fixture();
    let destroyed = false;
    let closeAttempts = 0;
    let destroyAttempts = 0;
    let unlinkAttempts = 0;
    let directoryAttempts = 0;
    let failedCleanup = 0;
    let failure;
    const filesystem = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const file = await fs.open(...args);
        const close = file.close.bind(file);
        file.close = async () => {
          closeAttempts++;
          await close();
        };
        return file;
      },
      unlink: async (file: Parameters<typeof fs.unlink>[0]) => {
        unlinkAttempts++;
        if (mode === 'unlink') {
          failedCleanup++;
          throw new Error('unlink fixture');
        }
        await fs.unlink(file);
      },
      rmdir: async (directory: Parameters<typeof fs.rmdir>[0]) => {
        directoryAttempts++;
        if (mode === 'rmdir') {
          failedCleanup++;
          throw new Error('rmdir fixture');
        }
        await fs.rmdir(directory);
      },
    };
    const { withPrintWindow } = loadSource<any>('main/printWindow.ts', {
      'fs/promises': filesystem,
      path,
      electron: {
        BrowserWindow: class {
          async loadFile() {}
          isDestroyed() {
            return destroyed;
          }
          destroy() {
            destroyAttempts++;
            destroyed = true;
            if (mode === 'destroy') {
              failedCleanup++;
              throw new Error('destroy fixture');
            }
          }
        },
      },
    });
    try {
      await fs.writeFile(path.join(f.directory, 'sentinel'), 'unrelated');
      try {
        await withPrintWindow(
          'private HTML',
          { getPath: () => f.directory },
          20,
          30,
          async () => {
            if (rejectRender) throw primary;
            return false;
          }
        );
        t.fail('render or cleanup failure must reject');
      } catch (error) {
        failure = error;
        if (rejectRender)
          t.equal(error, primary, 'exact render rejection retained');
        else t.ok(error instanceof Error, 'cleanup-only failure rejects');
      }
      t.equal(failedCleanup, 1);
      t.equal(closeAttempts, 1);
      t.equal(destroyAttempts, 1);
      t.equal(unlinkAttempts, 1);
      t.equal(directoryAttempts, mode === 'unlink' ? 0 : 1);
      t.ok(destroyed, 'window destruction was attempted');
      if (failure instanceof Error) {
        if (!Object.isExtensible(failure)) {
          t.equal(
            (failure as Error & { cleanupErrors?: string[] }).cleanupErrors,
            undefined,
            'frozen primary is not modified'
          );
        } else
          t.ok(
            (failure as Error & { cleanupErrors: string[] }).cleanupErrors.some(
              (error) => error.includes(mode + ' fixture')
            )
          );
      }
      t.equal(
        await fs.readFile(path.join(f.directory, 'sentinel'), 'utf8'),
        'unrelated'
      );
      const retained = (await fs.readdir(f.directory)).filter((name) =>
        name.startsWith('books-print-')
      );
      t.equal(
        retained.length,
        mode === 'destroy' ? 0 : 1,
        'only uncleanable owned resources are retained'
      );
    } finally {
      await f.close();
    }
  }
  t.end();
});
