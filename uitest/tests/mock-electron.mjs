import { existsSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

const mode = process.env.BOOKS_TEST_CASE;
let disabled = true;
let observation;
let keepAlive;
export const child = Object.assign(new EventEmitter(), {
  pid: 123456789,
  exitCode: null,
  signalCode: null,
});
function save() {
  writeFileSync(process.env.BOOKS_TEST_LOG, JSON.stringify(observation));
}

function stopped() {
  clearInterval(keepAlive);
  observation.terminated = true;
  observation.profilePresentAtExit = existsSync(
    observation.options.env.BOOKS_UI_TEST_DIR
  );
  save();
  child.emit('exit');
  child.emit('close');
}

export function forceStop(pid, signal) {
  if (pid !== -child.pid || signal !== 'SIGKILL')
    throw new Error('Unexpected kill target');
  observation.forced = true;
  save();
  if (mode === 'kill-error') throw new Error('Fabricated termination failure');
  if (mode === 'partial-kill') {
    child.exitCode = 7;
    child.emit('exit');
    throw new Error('Fabricated partial termination failure');
  }
  if (mode === 'kill-timeout') return;
  child.signalCode = 'SIGKILL';
  stopped();
}

const window = {
  setDefaultTimeout() {},
  async title() {
    if (mode === 'stdout')
      process.stdout.emit('error', new Error('Fabricated output failure'));
    if (mode === 'prior-exit') {
      process.exitCode = 7;
      return 'Incorrect title';
    }
    if (mode === 'assertion') return 'Incorrect title';
    if (mode === 'rejection') throw new Error('Fabricated test rejection');
    return 'Frappe Books';
  },
  async waitForLoadState(state) {
    observation.loadState = state;
    save();
  },
  getByTestId() {
    return {
      async waitFor() {},
      async isVisible() {
        return true;
      },
      async click() {},
      async isDisabled() {
        const value = disabled;
        disabled = false;
        return value;
      },
      async innerText() {
        return 'Test Company';
      },
    };
  },
  getByPlaceholder() {
    return { async fill() {}, async blur() {} };
  },
};

export const _electron = {
  async launch(options) {
    observation = { options, closed: false };
    save();
    if (mode === 'exit') process.exit(7);
    if (mode === 'launch') throw new Error('Fabricated launch failure');
    process.kill = forceStop;
    if (
      [
        'hang',
        'kill-error',
        'kill-timeout',
        'leader-exit',
        'partial-kill',
      ].includes(mode)
    )
      keepAlive = setInterval(() => {}, 1000);
    return {
      async firstWindow() {
        if (mode === 'window') throw new Error('Fabricated window failure');
        return window;
      },
      async close() {
        observation.closed = true;
        save();
        if (mode === 'hang') return new Promise(() => {});
        if (mode === 'leader-exit') {
          child.exitCode = 7;
          child.emit('exit');
          throw new Error(
            'Fabricated leader exit with open descendant streams'
          );
        }
        if (
          ['close', 'kill-error', 'kill-timeout', 'partial-kill'].includes(mode)
        )
          throw new Error('Fabricated close failure');
        child.exitCode =
          mode === 'child-exit' ? 7 : mode === 'child-signal' ? null : 0;
        child.signalCode = mode === 'child-signal' ? 'SIGSEGV' : null;
        stopped();
      },
      process() {
        if (observation.closed)
          throw new Error('Application connection closed');
        return child;
      },
    };
  },
};
