import * as fs from 'node:fs/promises';
import path from 'node:path';

export * from 'node:fs/promises';

export async function mkdtemp(prefix) {
  if (process.env.BOOKS_TEST_CASE !== 'launch-unsafe-cleanup')
    return fs.mkdtemp(prefix);
  const nested = path.join(path.dirname(prefix), 'nested-fixture');
  await fs.mkdir(nested);
  return fs.mkdtemp(path.join(nested, path.basename(prefix)));
}

export async function rm(target, options) {
  if (
    process.env.BOOKS_TEST_CASE === 'launch-rm-error' &&
    path.dirname(target) === process.env.TEMP &&
    path.basename(target).startsWith('books-ui-test-') &&
    options?.recursive
  ) {
    throw new Error('Fabricated profile removal failure');
  }
  return fs.rm(target, options);
}
