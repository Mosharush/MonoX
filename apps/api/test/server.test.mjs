import assert from 'node:assert/strict';
import test from 'node:test';

import { startApiServer } from '../src/server.mjs';

async function withServer(run) {
  const server = await startApiServer({ host: '127.0.0.1', port: 0 });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('serves health and synthetic API responses', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      name: '@monox/api',
      version: '0.2.0-alpha.1',
      ready: true,
      live: true,
      state: 'running',
    });

    const readiness = await fetch(`${baseUrl}/readyz`);
    assert.equal(readiness.status, 200);
    assert.deepEqual(await readiness.json(), { ready: true });

    const hello = await fetch(`${baseUrl}/api/hello`, { headers: { 'x-request-id': 'test-id' } });
    assert.equal(hello.status, 200);
    assert.equal(hello.headers.get('x-request-id'), 'test-id');
    assert.equal((await hello.json()).message, 'Hello from MonoX');

    const metrics = await fetch(`${baseUrl}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /monox_http_requests_total/);
  });
});

test('rejects unsupported methods', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hello`, { method: 'POST' });
    assert.equal(response.status, 405);
  });
});
