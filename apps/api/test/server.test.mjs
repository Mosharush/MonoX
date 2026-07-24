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
    assert.deepEqual(await health.json(), { status: 'ok' });

    const hello = await fetch(`${baseUrl}/api/hello`, { headers: { 'x-request-id': 'test-id' } });
    assert.equal(hello.status, 200);
    assert.equal(hello.headers.get('x-request-id'), 'test-id');
    assert.equal((await hello.json()).message, 'Hello from MonoX');
  });
});

test('rejects unsupported methods', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/hello`, { method: 'POST' });
    assert.equal(response.status, 405);
  });
});
