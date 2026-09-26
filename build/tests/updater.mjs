import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'tape';

const require = createRequire(import.meta.url);
const updaterRequire = createRequire(
  require.resolve('electron-updater/package.json')
);
const { HttpExecutor } = updaterRequire('builder-util-runtime');

test('updater redirects retain credentials only within the same origin', (t) => {
  const headers = {
    Authorization: 'synthetic-only',
    'PRIVATE-TOKEN': 'synthetic-only',
    X_Api_Key: 'synthetic-only',
    Cookie: 'synthetic=value',
    'Cache-Control': 'no-cache',
    'User-Agent': 'synthetic-updater',
  };
  const source = {
    protocol: 'https:',
    hostname: 'updates.example.invalid',
    path: '/release',
    headers,
  };
  t.deepEqual(
    HttpExecutor.prepareRedirectUrlOptions(
      'https://updates.example.invalid/asset',
      source
    ).headers,
    headers,
    'same origin retains request headers'
  );
  for (const url of [
    'https://cdn.example.invalid/asset',
    'https://updates.example.invalid:8443/asset',
    'http://updates.example.invalid/asset',
  ]) {
    t.deepEqual(
      HttpExecutor.prepareRedirectUrlOptions(url, source).headers,
      { 'Cache-Control': 'no-cache', 'User-Agent': 'synthetic-updater' },
      'host, port and protocol changes remove sensitive headers'
    );
  }
  t.equal(
    headers.Authorization,
    'synthetic-only',
    'source headers are preserved'
  );
  t.end();
});

class LoopbackExecutor extends HttpExecutor {
  createRequest(options, callback) {
    return http.request(options, callback);
  }
}

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
const close = (server) => new Promise((resolve) => server.close(resolve));

test('updater HTTP requests strip credentials at a cross-origin redirect', async (t) => {
  const respond = (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.headers));
  };
  const destination = http.createServer(respond);
  const origin = http.createServer((request, response) => {
    if (request.url === '/same') {
      response.writeHead(302, {
        Location: `http://127.0.0.1:${origin.address().port}/final`,
      });
      response.end();
    } else if (request.url === '/cross') {
      response.writeHead(302, {
        Location: `http://127.0.0.1:${destination.address().port}/final`,
      });
      response.end();
    } else {
      respond(request, response);
    }
  });
  try {
    await listen(destination);
    await listen(origin);
    const executor = new LoopbackExecutor();
    for (const path of ['/same', '/cross']) {
      const received = JSON.parse(
        await executor.request({
          protocol: 'http:',
          hostname: '127.0.0.1',
          port: origin.address().port,
          path,
          timeout: 5000,
          headers: {
            Authorization: 'synthetic-only',
            'PRIVATE-TOKEN': 'synthetic-only',
            'Cache-Control': 'no-cache',
          },
        })
      );
      const expected = path === '/same' ? 'synthetic-only' : undefined;
      t.equal(received.authorization, expected, `${path}: authorization`);
      t.equal(received['private-token'], expected, `${path}: private token`);
      t.equal(received['cache-control'], 'no-cache', `${path}: cache policy`);
    }
  } finally {
    await Promise.all([close(origin), close(destination)]);
  }
  t.end();
});
