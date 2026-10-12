import { rejects } from 'assert';
import { promises as fs } from 'fs';
import path from 'path';
import test from 'tape';
import { withFixture } from './databaseIpcFixture';

test('fixture cleanup preserves frozen and falsy failures', async (t) => {
  for (const primary of [
    0,
    '',
    undefined,
    Object.freeze(new Error('fixture failure')),
  ]) {
    let target = '';
    let rejected = false;
    let actual: unknown;
    try {
      await withFixture(async (directory) => {
        target = directory;
        await fs.writeFile(path.join(directory, 'synthetic.txt'), 'fixture');
        throw primary;
      });
    } catch (error) {
      rejected = true;
      actual = error;
    }
    t.ok(rejected, 'fixture failure rejects');
    t.equal(actual, primary, 'original rejection identity is preserved');
    await rejects(fs.stat(target), { code: 'ENOENT' });
    t.pass('owned temporary directory is removed');
  }
  t.end();
});

test('fixture cleanup retains both execution and cleanup failures', async (t) => {
  const primary = Object.freeze(new Error('fixture failure'));
  await rejects(
    withFixture(async (directory) => {
      await fs.rmdir(directory);
      throw primary;
    }),
    (error: unknown) => {
      t.ok(error instanceof AggregateError, 'both failures are reported');
      if (!(error instanceof AggregateError)) return false;
      const errors = error.errors as unknown[];
      t.equal(errors.length, 2);
      t.equal(errors[0], primary, 'frozen original remains accessible');
      t.equal((errors[1] as NodeJS.ErrnoException).code, 'ENOENT');
      return true;
    }
  );
  t.end();
});

test('fixture cleanup failures reject successful fixture execution', async (t) => {
  await rejects(
    withFixture((directory) => fs.rmdir(directory)),
    {
      code: 'ENOENT',
    }
  );
  t.pass('cleanup failure remains visible');
  t.end();
});
