import assert from 'node:assert/strict';
import test from 'node:test';

import { installMonoXFastify } from '../src/index.mjs';

test('registers health and metrics routes on a Fastify-compatible instance', () => {
  const routes = [];
  const hooks = [];
  const app = {
    get: (path, options, handler) => routes.push({ path, options, handler }),
    addHook: (name, hook) => hooks.push({ name, hook }),
  };
  const runtime = installMonoXFastify(app, { name: 'api' });
  assert.deepEqual(
    routes.map(({ path }) => path),
    ['/healthz', '/readyz', '/livez', '/metrics']
  );
  assert.deepEqual(
    hooks.map(({ name }) => name),
    ['onReady', 'onClose']
  );
  assert.equal(runtime.name, 'api');
});
