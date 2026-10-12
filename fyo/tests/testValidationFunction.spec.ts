import { validateEmail } from 'fyo/model/validationFunction';
import { ValidationError } from 'fyo/utils/errors';
import test from 'tape';

test('validateEmail accepts addresses matching the accepted shape', (t) => {
  for (const value of ['ab@cd.ef', 'a@bb.co', 'first.last@sub.example.com']) {
    t.doesNotThrow(() => validateEmail(value), `accepts ${value}`);
  }
  t.end();
});

test('validateEmail rejects values outside the accepted shape', (t) => {
  for (const value of ['nope', 'a@b.de', 'a@b.', '@b.cd', '']) {
    t.throws(
      () => validateEmail(value),
      ValidationError,
      `rejects ${JSON.stringify(value)}`
    );
  }
  t.end();
});

test('validateEmail rejects unmatchable input without backtracking delay', (t) => {
  const value = `a@${'b'.repeat(40)}`;
  const start = Date.now();
  t.throws(() => validateEmail(value), ValidationError, 'rejects');
  t.ok(Date.now() - start < 1000, 'rejects without pathological delay');
  t.end();
});
