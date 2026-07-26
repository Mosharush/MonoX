import assert from 'node:assert/strict';
import test from 'node:test';

import { createPm2Cloudapter } from '../src/index.mjs';

function context() {
  return {
    config: { project: { name: 'example' } },
    environment: 'production',
    target: { id: 'production-vm', provider: 'generic', transport: 'ssh', runtime: 'pm2' },
    sourceDigest: 'sha256:1234567890abcdef1234',
    targetStateDigest: 'sha256:state',
    workloads: [
      {
        deployment: {
          schemaVersion: '2',
          enabled: true,
          id: 'api',
          kind: 'service',
          build: { strategy: 'none' },
          runtime: { language: 'typescript', command: ['node', 'dist/server.mjs'] },
          env: {
            values: { NODE_ENV: 'production' },
            secretRefs: [{ name: 'runtime-secret', target: 'DATABASE_URL' }],
          },
          probes: { readiness: { type: 'http', path: '/ready', port: 3000 } },
          lifecycle: { terminationGracePeriodSeconds: 60 },
          adapterOverrides: { pm2: { instances: 2, execMode: 'cluster' } },
        },
      },
    ],
  };
}

test('renders PM2 config with references but no secret values', async () => {
  const adapter = createPm2Cloudapter();
  const input = context();
  const plan = await adapter.plan(input);
  const rendered = await adapter.render(plan);
  const config = JSON.parse(rendered.artifacts[0].content);
  assert.equal(config.apps[0].instances, 2);
  assert.deepEqual(config.apps[0].requiredEnv, ['DATABASE_URL']);
  assert.equal(config.apps[0].env.DATABASE_URL, undefined);
  assert(plan.actions.some((action) => action.operation === 'health-check'));
  assert(plan.actions.some((action) => action.operation === 'promote-release'));
});

test('rolls back an injected PM2 release when health fails', async () => {
  const adapter = createPm2Cloudapter();
  const input = context();
  let rolledBack = false;
  input.pm2 = {
    execute: async (action) => ({ healthy: action.operation === 'health-check' ? false : undefined }),
    rollback: async () => {
      rolledBack = true;
      return { status: 'rolled-back', changed: true };
    },
  };
  const plan = await adapter.plan(input);
  await assert.rejects(() => adapter.apply(plan, input), /Health gate failed/);
  assert.equal(rolledBack, true);
});
