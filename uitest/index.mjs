import path from 'path';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron } from 'playwright';
import { fileURLToPath } from 'url';
import tape from 'tape';
import tapSpec from 'tap-spec';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..');
const bootstrapPath = path.join(dirname, 'bootstrap.cjs');
const execFileAsync = promisify(execFile);

async function withinDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Electron shutdown timed out')),
          5_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeApp(electronApp, child, resourcesClosed) {
  if (!electronApp) return;
  const alive = () => child.exitCode === null && child.signalCode === null;
  try {
    await withinDeadline(Promise.all([electronApp.close(), resourcesClosed]));
  } catch (error) {
    process.exitCode ||= 1;
    console.error(error);
    if (!alive()) {
      await withinDeadline(resourcesClosed);
      return;
    }
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new Error('Cannot stop Electron without its owned process id');
    }
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        timeout: 5_000,
      });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
    await withinDeadline(resourcesClosed);
  }
  if (child.exitCode !== 0 || child.signalCode !== null) {
    process.exitCode ||= child.exitCode || 1;
    console.error(
      `Electron terminated: code=${child.exitCode}, signal=${child.signalCode}`
    );
  }
}

function createLaunchEnvironment(testRoot, temporaryPath) {
  const env = {
    BOOKS_UI_TEST_DIR: testRoot,
    NODE_ENV: 'production',
    IS_TEST: 'true',
    HOME: testRoot,
    USERPROFILE: testRoot,
    APPDATA: testRoot,
    LOCALAPPDATA: testRoot,
    TEMP: temporaryPath,
    TMP: temporaryPath,
    TMPDIR: temporaryPath,
  };
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'DISPLAY',
    'XDG_RUNTIME_DIR',
  ]) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return env;
}

async function run() {
  const temporaryRoot = await realpath(tmpdir());
  const testRoot = await mkdtemp(path.join(temporaryRoot, 'books-ui-test-'));
  const temporaryPath = path.join(testRoot, 'temp');
  const env = createLaunchEnvironment(testRoot, temporaryPath);
  let electronApp;
  let child;
  let resourcesClosed;
  let primaryFailure;
  try {
    await mkdir(temporaryPath);
    electronApp = await _electron.launch({
      args: [
        bootstrapPath,
        `--user-data-dir=${path.join(testRoot, 'userData')}`,
      ],
      cwd: root,
      env,
      timeout: 60_000,
    });
    child = electronApp.process();
    resourcesClosed = new Promise((resolve) => child.once('close', resolve));
    await runSmokeTests(electronApp);
  } catch (error) {
    primaryFailure = error?.stack ?? String(error);
    throw error;
  } finally {
    try {
      await closeApp(electronApp, child, resourcesClosed);
    } catch (error) {
      await new Promise(() => {
        const original =
          primaryFailure === undefined
            ? ''
            : `Original failure:\n${primaryFailure}\n`;
        process.stderr.write(
          `${original}Temporary profile retained: ${testRoot}\n${error}\n`,
          () => {
            process.exit(process.exitCode || 1);
          }
        );
      });
    }
    await removeProfile(testRoot, temporaryRoot);
  }
}

async function removeProfile(testRoot, temporaryRoot) {
  if (path.dirname(testRoot) !== temporaryRoot) {
    process.exitCode ||= 1;
    console.error(
      new Error('Refusing to remove a directory outside the test root')
    );
  } else {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch (error) {
      process.exitCode ||= 1;
      console.error(`Temporary profile retained: ${testRoot}`);
      console.error(error);
    }
  }
}

async function runSmokeTests(electronApp) {
  const window = await electronApp.firstWindow();
  window.setDefaultTimeout(60_000);
  const test = tape.createHarness({ autoclose: true });
  const finished = new Promise((resolve) => test.onFinish(resolve));
  const fail = () => {
    process.exitCode ||= 1;
  };
  test.onFailure(fail);
  test
    .createStream()
    .on('error', fail)
    .pipe(tapSpec())
    .on('error', fail)
    .pipe(process.stdout, { end: false })
    .on('error', fail);
  registerSmokeTests(test, window, electronApp);
  await finished;
}

function registerSmokeTests(test, window, electronApp) {
  test('load app', async (t) => {
    t.equal(await window.title(), 'Frappe Books', 'title matches');

    await window.waitForLoadState('load', { timeout: 60_000 });
    t.ok(true, 'window has loaded');
  });

  test('navigate to database selector', async (t) => {
    const createNew = window.getByTestId('create-new-file');
    await createNew.waitFor({ state: 'visible' });
    t.ok(await createNew.isVisible(), 'create new is visible');
  });

  test('fill setup form', async (t) => {
    await window.getByTestId('create-new-file').click();
    await window.getByTestId('submit-button').waitFor();

    t.equal(
      await window.getByTestId('submit-button').isDisabled(),
      true,
      'submit button is disabled before form fill'
    );

    await window.getByPlaceholder('Company Name').fill('Test Company');
    await window.getByPlaceholder('John Doe').fill('Test Owner');
    await window.getByPlaceholder('john@doe.com').fill('test@example.com');
    await window.getByPlaceholder('Select Country').fill('India');
    await window.getByPlaceholder('Select Country').blur();
    await window.getByPlaceholder('Prime Bank').fill('Test Bank');
    await window.getByPlaceholder('Prime Bank').blur();

    t.equal(
      await window.getByTestId('submit-button').isDisabled(),
      false,
      'submit button enabled after form fill'
    );
  });

  test('create new instance', async (t) => {
    const confirmation = await electronApp.evaluateHandle(({ dialog }) => {
      const original = dialog.showMessageBox;
      const state = {
        options: undefined,
        parented: false,
        restore: () => {
          dialog.showMessageBox = original;
        },
      };
      dialog.showMessageBox = async (parent, options) => {
        if (options.title !== 'Create or replace database') {
          return original.call(dialog, parent, options);
        }
        state.options = options;
        state.parented = !!parent && !parent.isDestroyed();
        state.restore();
        return { response: 1, checkboxChecked: false };
      };
      return state;
    });
    try {
      await window.getByTestId('submit-button').click();
      t.equal(
        await window.getByTestId('company-name').innerText(),
        'Test Company',
        'new instance created, company name found in sidebar'
      );
      const record = await confirmation.evaluate((state) => ({
        options: state.options,
        parented: state.parented,
      }));
      t.ok(record.parented, 'creation confirmation belongs to the main window');
      t.deepEqual(record.options.buttons, ['Cancel', 'Create']);
      t.equal(record.options.defaultId, 0, 'creation defaults to cancellation');
      t.equal(record.options.cancelId, 0, 'Escape cancels creation');
      t.ok(record.options.detail.startsWith('Filesystem path: '));
    } finally {
      await confirmation.evaluate((state) => state.restore());
      await confirmation.dispose();
    }
  });
}

run().catch((error) => {
  console.error(error);
  process.exitCode ||= 1;
});
