import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'tape';

const root = fileURLToPath(new URL('../../', import.meta.url));
const assets = path.join(root, 'dist_electron', 'build', 'src', 'assets');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('source build preserves the bundled font', (t) => {
  const fonts = readdirSync(assets).filter((name) =>
    /^Inter\.var-[\w-]+\.woff2$/.test(name)
  );
  t.equal(fonts.length, 1, 'one Inter font is bundled');
  if (fonts.length === 1) {
    const source = readFileSync(
      path.join(root, 'src', 'assets', 'fonts', 'Inter.var.woff2')
    );
    const built = readFileSync(path.join(assets, fonts[0]));
    t.equal(built.length, source.length, 'font size is preserved');
    t.equal(hash(built), hash(source), 'font bytes are preserved');
  }
  t.end();
});
