import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'tape';

const require = createRequire(import.meta.url);
const storeRequire = createRequire(require.resolve('electron-store'));
const confRequire = createRequire(storeRequire.resolve('conf'));
const Conf = storeRequire('conf');
const Ajv = confRequire('ajv');

test('settings validation handles dynamic patterns with the configured engine', (t) => {
  const patterns = [];
  const regExp = (pattern, flags) => {
    patterns.push(pattern);
    return new RegExp(pattern, flags);
  };
  regExp.code = 'RegExp';
  const ajv = new Ajv({ $data: true, code: { regExp } });
  const validate = ajv.compile({
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      value: { type: 'string', pattern: { $data: '1/pattern' } },
    },
  });
  patterns.length = 0;
  t.equal(validate({ pattern: '^ok$', value: 'ok' }), true);
  t.equal(validate({ pattern: '^ok$', value: 'no' }), false);
  t.deepEqual(patterns, ['^ok$', '^ok$'], 'dynamic patterns use the engine');
  t.doesNotThrow(() => {
    t.equal(validate({ pattern: '[', value: 'ok' }), false);
  }, 'an invalid dynamic pattern fails validation without throwing');
  t.end();
});

test('settings persist ordinary data and preserve malformed files', (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'books-settings-'));
  try {
    const config = new Conf({ cwd });
    const values = {
      text: 'Synthetic settings',
      unicode: 'caf\u00e9',
      zero: 0,
      enabled: false,
      empty: '',
      missing: null,
      nested: { list: [1, false, ''] },
      schema: { $data: true, pattern: '[', format: { $data: '1/name' } },
    };
    let changed;
    const unsubscribe = config.onDidChange('enabled', (value) => {
      changed = value;
    });
    config.set(values);
    unsubscribe();
    t.equal(changed, false, 'change notifications preserve false');
    const reopened = new Conf({ cwd });
    for (const [key, value] of Object.entries(values)) {
      t.deepEqual(reopened.get(key), value, `${key} survives reopening`);
    }
    t.equal(reopened.has('zero'), true);
    reopened.delete('zero');
    t.equal(new Conf({ cwd }).has('zero'), false);
    writeFileSync(config.path, '{');
    t.throws(() => new Conf({ cwd }), SyntaxError);
    t.equal(
      readFileSync(config.path, 'utf8'),
      '{',
      'invalid JSON is preserved'
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    t.end();
  }
});

test('settings keep static schema validation and local references', (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'books-settings-schema-'));
  try {
    const options = {
      cwd,
      schema: {
        count: { type: 'integer', minimum: 0, default: 1 },
        date: { type: 'string', format: 'date' },
      },
    };
    const config = new Conf(options);
    t.equal(config.get('count'), 1, 'schema defaults remain available');
    config.set({ count: 0, date: '2026-04-15' });
    const before = readFileSync(config.path, 'utf8');
    t.throws(() => config.set('count', -1), /must be >= 0/);
    t.throws(() => config.set('date', 'invalid'), /must match format/);
    t.equal(
      readFileSync(config.path, 'utf8'),
      before,
      'invalid writes preserve settings'
    );
    t.equal(new Conf(options).get('count'), 0);
    const validate = new Ajv().compile({
      definitions: { count: { type: 'integer', minimum: 0 } },
      $ref: '#/definitions/count',
    });
    t.equal(validate(0), true);
    t.equal(validate(-1), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    t.end();
  }
});
