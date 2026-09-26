import { createRequire } from 'node:module';
import test from 'tape';

const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve('@eslint/eslintrc'));
const Ajv = eslintRequire('ajv');

test('development validation rejects malformed dynamic patterns', (t) => {
  const validate = new Ajv({ $data: true }).compile({
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      value: { type: 'string', pattern: { $data: '1/pattern' } },
    },
  });
  t.equal(validate({ pattern: '^ok$', value: 'ok' }), true);
  t.equal(validate({ pattern: '^ok$', value: 'no' }), false);
  let valid = true;
  t.doesNotThrow(() => {
    valid = validate({ pattern: '[', value: 'ok' });
  }, 'malformed patterns do not escape as exceptions');
  t.equal(valid, false, 'malformed patterns fail validation');
  t.end();
});
