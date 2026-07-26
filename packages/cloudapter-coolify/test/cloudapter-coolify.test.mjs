import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoolifyCloudapter } from '../src/index.mjs';

function context() {
  return {
    config: { project: { name: 'example' } },
    environment: 'production',
    sourceDigest: 'sha256:source',
    targetStateDigest: 'sha256:state',
    target: {
      id: 'coolify-production',
      provider: 'generic',
      provisioner: 'none',
      transport: 'coolify-api',
      runtime: 'coolify',
      projectRef: 'project-id',
      serverRef: 'server-id',
      clusterRef: 'destination-id',
      bindings: {
        namespace: 'production',
        domain: 'api.example.invalid',
        identityRef: 'secret-store://coolify/deploy-token',
      },
    },
    workloads: [
      {
        deployment: {
          schemaVersion: '2',
          enabled: true,
          id: 'api',
          kind: 'service',
          build: {
            strategy: 'dockerfile',
            dockerfile: 'Dockerfile',
            image: { repository: 'registry.invalid/example/api', tag: '0.2.0' },
          },
          runtime: { language: 'typescript', command: ['node', 'server.mjs'] },
          network: {
            exposure: 'internal',
            ports: [{ name: 'http', containerPort: 3000 }],
            routes: [],
          },
          probes: {
            readiness: { type: 'http', path: '/ready', port: 3000 },
            liveness: { type: 'http', path: '/health', port: 3000 },
          },
          env: {
            values: { NODE_ENV: 'production' },
            secretRefs: [{ name: 'runtime-secret', target: 'DATABASE_URL' }],
          },
          adapterOverrides: { coolify: {} },
        },
      },
    ],
  };
}

test('plans only the current Coolify services endpoint with token references', async () => {
  const adapter = createCoolifyCloudapter();
  const input = context();
  const plan = await adapter.plan(input);
  assert.equal(plan.actions[0].path, '/api/v1/services');
  assert.equal(plan.actions[0].auth.tokenRef, 'secret-store://coolify/deploy-token');
  assert.deepEqual(plan.actions[0].auth.requiredScopes, ['read', 'write', 'deploy']);
  assert.deepEqual(plan.actions[0].auth.forbiddenScopes, ['root']);
  assert.equal(plan.actions[0].auth.token, undefined);
  assert.equal(plan.actions[0].body.instant_deploy, true);
  const rendered = await adapter.render(plan, input);
  assert.match(rendered.artifacts[0].content, /\$\{DATABASE_URL:\?required\}/);
  assert.doesNotMatch(rendered.artifacts[1].content, /Bearer\s/);
  assert.equal(
    Buffer.from(plan.actions[0].body.docker_compose_raw, 'base64').toString('utf8'),
    rendered.artifacts[0].content
  );
});

test('requires a token reference and needs an injected HTTP transport', async () => {
  const adapter = createCoolifyCloudapter();
  const input = context();
  delete input.target.bindings.identityRef;
  assert.equal((await adapter.validate(input)).valid, false);
  input.target.bindings.identityRef = 'secret-store://coolify/deploy-token';
  const plan = await adapter.plan(input);
  await assert.rejects(() => adapter.apply(plan, input), /context\.coolify\.request/);
});

test('health gates Coolify apply and invokes rollback on failure', async () => {
  const adapter = createCoolifyCloudapter();
  const input = context();
  let rolledBack = false;
  input.coolify = {
    request: async () => ({ changed: true, healthy: false, previousRevision: 'previous' }),
    rollback: async ({ revision }) => {
      rolledBack = revision === 'previous';
      return { changed: true };
    },
  };
  const plan = await adapter.plan(input);
  await assert.rejects(() => adapter.apply(plan, input), /health gate failed/);
  assert.equal(rolledBack, true);

  input.coolify.request = async () => ({ changed: true, healthy: true, uuid: 'service-id' });
  assert.equal((await adapter.apply(plan, input)).result.status, 'applied');
});
