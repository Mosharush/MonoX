import assert from 'node:assert/strict';
import test from 'node:test';

import { createLifecycle } from '../src/index.mjs';

test('drains hooks once in reverse registration order', async () => {
  const calls = [];
  const lifecycle = createLifecycle();
  lifecycle.onShutdown('server', () => calls.push('server'));
  lifecycle.onShutdown('queue', () => calls.push('queue'));
  const [first, second] = await Promise.all([lifecycle.shutdown('test'), lifecycle.shutdown('ignored')]);
  assert.deepEqual(calls, ['queue', 'server']);
  assert.equal(first, second);
  assert.equal(lifecycle.state, 'stopped');
});

test('reports failures without terminating the process', async () => {
  const lifecycle = createLifecycle({ timeoutMs: 20 });
  lifecycle.onShutdown('broken', () => {
    throw new Error('boom');
  });
  const result = await lifecycle.shutdown();
  assert.equal(result.state, 'failed');
  assert.equal(result.failures[0].name, 'broken');
});
