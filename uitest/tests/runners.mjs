import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'tape';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryRoot = fs.realpathSync(os.tmpdir());
const env = {};
for (const name of [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}

function removeFixture(directory) {
  if (
    path.dirname(directory) !== temporaryRoot ||
    !path.basename(directory).startsWith('books-')
  ) {
    throw new Error('Refusing to remove an unrelated directory');
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

test('unit runner preserves failures and argument boundaries', (t) => {
  const directory = fs.mkdtempSync(
    path.join(temporaryRoot, 'books-runner-test-')
  );
  try {
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.mkdirSync(path.join(directory, 'node_modules', '.bin'), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(root, 'scripts', 'test.sh'),
      path.join(directory, 'scripts', 'test.sh')
    );
    fs.writeFileSync(
      path.join(directory, 'scripts', 'runner.sh'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > arguments.txt\nprintf "TAP version 13\\n"\nexit "$PRODUCER_STATUS"\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(directory, 'node_modules', '.bin', 'tap-spec'),
      '#!/usr/bin/env bash\nwhile IFS= read -r line; do :; done\nexit "$REPORTER_STATUS"\n',
      { mode: 0o755 }
    );

    for (const [producer, reporter] of [
      [0, 0],
      [7, 0],
      [0, 9],
      [7, 9],
    ]) {
      const result = spawnSync(
        process.env.BOOKS_TEST_SHELL || 'zsh',
        [
          'scripts/test.sh',
          'folder with spaces/example.spec.ts',
          'second.spec.ts',
        ],
        {
          cwd: directory,
          env: {
            ...env,
            PRODUCER_STATUS: String(producer),
            REPORTER_STATUS: String(reporter),
          },
          encoding: 'utf8',
          timeout: 10_000,
        }
      );
      t.error(result.error, 'runner started');
      t.equal(
        result.status,
        reporter || producer,
        `producer ${producer}, reporter ${reporter}`
      );
      t.deepEqual(
        fs
          .readFileSync(path.join(directory, 'arguments.txt'), 'utf8')
          .trim()
          .split('\n'),
        [
          './node_modules/.bin/tape',
          'folder with spaces/example.spec.ts',
          'second.spec.ts',
        ],
        'arguments remain separate'
      );
    }
    const result = spawnSync(
      process.env.BOOKS_TEST_SHELL || 'zsh',
      ['scripts/test.sh'],
      {
        cwd: directory,
        env: { ...env, PRODUCER_STATUS: '0', REPORTER_STATUS: '0' },
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    t.equal(result.status, 0, 'default discovery succeeds');
    t.equal(
      fs
        .readFileSync(path.join(directory, 'arguments.txt'), 'utf8')
        .trim()
        .split('\n')[1],
      './**/tests/**/*.spec.ts',
      'Tape receives its recursive glob'
    );
  } finally {
    removeFixture(directory);
    t.end();
  }
});

test('UI command preserves failures and cleans its isolated profile', (t) => {
  const directory = fs.mkdtempSync(
    path.join(temporaryRoot, 'books-runner-test-')
  );
  const command = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
    .scripts.uitest;
  const loader = new URL('./mock-loader.mjs', import.meta.url).href;
  t.equal(
    command,
    'node uitest/index.mjs',
    'UI command has no masking shell pipeline'
  );
  try {
    for (const [mode, status] of [
      ['pass', 0],
      ['assertion', 1],
      ['rejection', 1],
      ['launch', 1],
      ['window', 1],
      ['close', 1],
      ['reporter', 1],
      ['exit', 7],
      ['child-exit', 7],
      ['child-signal', 1],
      ['stdout', 1],
      ['prior-exit', 7],
      ['hang', 1],
      ['kill-error', 1],
      ['kill-timeout', 1],
    ]) {
      const log = path.join(directory, `${mode}.json`);
      const result = spawnSync(process.execPath, ['uitest/index.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...env,
          NODE_OPTIONS: `--import=${loader}`,
          BOOKS_TEST_CASE: mode,
          BOOKS_TEST_LOG: log,
          NODE_ENV: 'development',
          ELECTRON_RUN_AS_NODE: '1',
        },
      });
      t.error(result.error, `${mode}: command started`);
      t.equal(result.status, status, `${mode}: exit status`);
      const observation = JSON.parse(fs.readFileSync(log));
      const childEnv = observation.options.env;
      const profile = childEnv?.BOOKS_UI_TEST_DIR;
      t.equal(
        childEnv?.NODE_ENV,
        'production',
        `${mode}: development database path disabled`
      );
      t.equal(
        childEnv?.ELECTRON_RUN_AS_NODE,
        undefined,
        `${mode}: Electron node mode excluded`
      );
      t.equal(
        childEnv?.NODE_OPTIONS,
        undefined,
        `${mode}: parent hooks excluded`
      );
      t.equal(
        path.dirname(profile || ''),
        temporaryRoot,
        `${mode}: temporary profile`
      );
      t.deepEqual(
        observation.options.args,
        [
          path.join(root, 'uitest', 'bootstrap.cjs'),
          `--user-data-dir=${path.join(profile, 'userData')}`,
        ],
        `${mode}: isolated bootstrap used`
      );
      for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
        t.equal(childEnv[name], profile, `${mode}: synthetic ${name}`);
      }
      for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
        t.equal(
          childEnv[name],
          path.join(profile, 'temp'),
          `${mode}: isolated ${name}`
        );
      }
      const retained = ['kill-error', 'kill-timeout'].includes(mode);
      if (profile && path.dirname(profile) === temporaryRoot) {
        if (mode === 'exit') removeFixture(profile);
        else
          t.equal(
            fs.existsSync(profile),
            retained,
            `${mode}: profile retained only when termination is unverified`
          );
        if (fs.existsSync(profile)) removeFixture(profile);
      }
      if (!['launch', 'exit'].includes(mode))
        t.equal(observation.closed, true, `${mode}: app close requested`);
      if (!['launch', 'exit'].includes(mode) && !retained) {
        t.equal(observation.terminated, true, `${mode}: child terminated`);
        t.equal(
          observation.profilePresentAtExit,
          true,
          `${mode}: termination precedes removal`
        );
      }
      if (mode === 'pass') {
        t.equal(
          observation.loadState,
          'load',
          'already loaded windows are accepted'
        );
        t.match(
          result.stdout,
          /passing:\s+6/,
          'formatted results drain before exit'
        );
      }
    }
  } finally {
    removeFixture(directory);
    t.end();
  }
});

test('bootstrap isolates paths before importing application code', (t) => {
  const directory = fs.mkdtempSync(
    path.join(temporaryRoot, 'books-bootstrap-test-')
  );
  const source = fs.readFileSync(
    path.join(root, 'uitest', 'bootstrap.cjs'),
    'utf8'
  );
  try {
    const paths = {};
    let applicationImports = 0;
    const childEnv = { BOOKS_UI_TEST_DIR: directory, NODE_ENV: 'development' };
    vm.runInNewContext(source, {
      process: { env: childEnv },
      require(name) {
        if (name === 'electron')
          return {
            app: {
              setPath(name, value) {
                t.ok(
                  fs.statSync(value).isDirectory(),
                  `${name} exists before setPath`
                );
                paths[name] = value;
              },
            },
          };
        if (name === 'node:fs') return fs;
        if (name === 'node:path') return path;
        applicationImports++;
        t.equal(
          name,
          '../dist_electron/build/main.js',
          'built entrypoint imported'
        );
        t.deepEqual(
          Object.keys(paths),
          ['userData', 'sessionData', 'documents', 'logs'],
          'all paths set before application import'
        );
        for (const value of Object.values(paths))
          t.equal(path.dirname(value), directory, 'path stays in fixture');
        t.equal(
          childEnv.NODE_ENV,
          'production',
          'development path disabled before import'
        );
        t.equal(childEnv.IS_TEST, 'true', 'test mode enabled before import');
      },
    });
    t.equal(applicationImports, 1, 'application imported exactly once');
    for (const value of [undefined, 'relative-directory']) {
      t.throws(
        () =>
          vm.runInNewContext(source, {
            process: { env: { BOOKS_UI_TEST_DIR: value } },
            require(name) {
              return name === 'electron'
                ? { app: {} }
                : name === 'node:fs'
                ? fs
                : path;
            },
          }),
        /absolute temporary directory/,
        'invalid root rejected'
      );
    }
  } finally {
    removeFixture(directory);
    t.end();
  }
});
