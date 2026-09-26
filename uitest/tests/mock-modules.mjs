export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process') {
    return {
      shortCircuit: true,
      url: new URL('./mock-kill.mjs', import.meta.url).href,
    };
  }
  if (specifier === 'playwright') {
    return {
      shortCircuit: true,
      url: new URL('./mock-electron.mjs', import.meta.url).href,
    };
  }
  if (specifier === 'tap-spec' && process.env.BOOKS_TEST_CASE === 'reporter') {
    return {
      shortCircuit: true,
      url:
        'data:text/javascript,' +
        encodeURIComponent(`
        import { Transform } from 'node:stream';
        export default () => new Transform({
          transform(chunk, encoding, callback) {
            callback(new Error('Fabricated reporter failure'));
          }
        });
      `),
    };
  }
  return nextResolve(specifier, context);
}
