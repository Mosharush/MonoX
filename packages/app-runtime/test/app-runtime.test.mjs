import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createAppRuntime } from '../src/index.mjs';

function responseCapture() {
  return {
    headers: {},
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    },
  };
}

test('exposes bounded health transitions and request ids', () => {
  const runtime = createAppRuntime({ name: 'api', version: '1.0.0' });
  const response = responseCapture();
  assert.equal(runtime.handleSystemRequest({ url: '/readyz', headers: {} }, response), true);
  assert.equal(response.statusCode, 503);
  runtime.setReady();
  const healthy = responseCapture();
  runtime.handleSystemRequest({ url: '/healthz', headers: { 'x-request-id': 'safe-1' } }, healthy);
  assert.equal(healthy.statusCode, 200);
  assert.equal(healthy.headers['x-request-id'], 'safe-1');
});

test('attaches server shutdown to the shared lifecycle', async () => {
  const runtime = createAppRuntime();
  const server = new EventEmitter();
  server.close = (callback) => callback();
  runtime.attachServer(server);
  runtime.setReady(true);
  const result = await runtime.lifecycle.shutdown('test');
  assert.equal(result.state, 'stopped');
  assert.deepEqual(runtime.health(), {
    name: 'application',
    version: 'development',
    ready: false,
    live: false,
    state: 'stopped',
  });
});

test('exports request metrics in Prometheus format', () => {
  const runtime = createAppRuntime();
  runtime.observeRequest({ route: '/items', statusCode: 200, durationSeconds: 0.1 });
  assert.match(runtime.telemetry.prometheus(), /monox_http_requests_total/);
});
