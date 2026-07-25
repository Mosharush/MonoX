import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalCloudapter } from '../src/index.mjs';

function context() {
  return {
    config: { project: { name: 'example' } },
    environment: 'development',
    target: {
      id: 'local',
      provider: 'generic',
      provisioner: 'none',
      transport: 'local',
      runtime: 'docker',
    },
    workloads: [
      {
        deployment: {
          schemaVersion: '2',
          enabled: true,
          id: 'api',
          kind: 'service',
          build: { strategy: 'none' },
          runtime: { language: 'typescript', command: ['node', 'server.mjs'] },
          probes: { readiness: { type: 'http', path: '/ready', port: 3000 } },
        },
      },
    ],
    sourceDigest: 'sha256:source',
    targetStateDigest: 'sha256:state',
  };
}

test('plans argument arrays and renders a deterministic local artifact', async () => {
  const adapter = createLocalCloudapter();
  const input = context();
  const plan = await adapter.plan(input);
  assert.deepEqual(plan.actions[0].args, [
    'compose',
    '--project-name',
    'example-development',
    '-f',
    'infra/local/docker-compose.yml',
    'config',
    '--services',
  ]);
  assert.equal(plan.actions[1].args.includes('--remove-orphans'), false);
  assert.equal(typeof plan.actions[0].command, 'undefined');
  assert.deepEqual(await adapter.render(plan), await adapter.render(plan));
});

test('health gates injected local execution', async () => {
  const adapter = createLocalCloudapter();
  const input = context();
  input.local = {
    execute: async (action) => ({ healthy: action.operation !== 'health-check' ? undefined : false }),
  };
  const plan = await adapter.plan(input);
  await assert.rejects(() => adapter.apply(plan, input), /Health gate failed/);
  input.local.execute = async (action) => ({
    healthy: action.operation === 'health-check' ? true : undefined,
  });
  assert.equal((await adapter.apply(plan, input)).result.status, 'applied');
});

test('doctor delegates Docker and Compose file verification to the local executor', async () => {
  const adapter = createLocalCloudapter();
  const input = context();
  let requests = 0;
  input.local = {
    doctor: async ({ composeFiles }) => {
      requests += 1;
      assert.deepEqual(composeFiles, ['infra/local/docker-compose.yml']);
      return { ok: false, message: 'Docker is unavailable' };
    },
    execute: async () => ({}),
  };
  const result = await adapter.doctor(input);
  assert.equal(requests, 1);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.id === 'executor').status, 'fail');
});

test('plans enabled bundled add-ons as explicit owned Compose services', async () => {
  const adapter = createLocalCloudapter();
  const input = context();
  input.config.addons = {
    redis: {
      recipe: 'redis',
      enabled: true,
      mode: 'bundled',
      environments: ['development'],
    },
    external: {
      recipe: 'postgresql',
      enabled: true,
      mode: 'external',
      environments: ['development'],
    },
  };
  const plan = await adapter.plan(input);
  assert.deepEqual(plan.metadata.composeFiles, [
    'infra/local/docker-compose.yml',
    'infra/docker/addons.compose.yaml',
  ]);
  assert.deepEqual(plan.metadata.ownedComposeServices, ['api', 'redis']);
  assert.deepEqual(plan.actions[1].args, [
    'compose',
    '--project-name',
    'example-development',
    '-f',
    'infra/local/docker-compose.yml',
    '-f',
    'infra/docker/addons.compose.yaml',
    'up',
    '--detach',
    'api',
    'redis',
  ]);
});
