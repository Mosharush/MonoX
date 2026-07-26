import assert from 'node:assert/strict';
import test from 'node:test';

import { createServiceDiscovery } from '../src/index.mjs';

test('resolves explicit internal and public service URLs', () => {
  const discovery = createServiceDiscovery({
    environment: 'preview',
    services: { api: { internal: 'http://api:3000', public: 'https://preview.example.test/api' } },
  });
  assert.equal(discovery.resolve('api', { path: 'v1/items' }).href, 'http://api:3000/v1/items');
  assert.equal(
    discovery.resolve('api', { scope: 'public', path: 'healthz' }).href,
    'https://preview.example.test/api/healthz'
  );
});

test('fails closed when a scope or service is not configured', () => {
  const discovery = createServiceDiscovery({ services: { worker: { internal: 'http://worker:3000' } } });
  assert.throws(() => discovery.resolve('worker', { scope: 'public' }), /no public endpoint/);
  assert.throws(() => discovery.resolve('missing'), /Unknown service/);
});

test('rejects credentials embedded in service URLs', () => {
  assert.throws(
    () =>
      createServiceDiscovery({
        services: { api: { internal: 'https://client:secret@api.example.invalid' } },
      }),
    /must not contain inline credentials/
  );
});
