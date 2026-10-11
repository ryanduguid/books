import { readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';
import { runInNewContext } from 'vm';

const root = path.resolve(__dirname, '../..');

export function loadSource<T>(
  file: string,
  mocks: Record<string, unknown> = {},
  globals = {}
): T {
  let source = readFileSync(path.join(root, file), 'utf8');
  if (file.endsWith('.vue')) {
    source = source.split('<script lang="ts">')[1].split('</script>')[0];
  }
  const exports = {};
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  });
  runInNewContext(outputText, {
    exports,
    require: (name: string) => mocks[name] ?? {},
    Error,
    TypeError,
    Buffer,
    process,
    ...globals,
  });
  return exports as T;
}
