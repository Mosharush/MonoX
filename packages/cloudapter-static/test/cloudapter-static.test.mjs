import assert from 'node:assert/strict';
import test from 'node:test';

import { createStaticCloudapter } from '../src/index.mjs';

function context() {
  return {
    config: { project: { name: 'example' } },
    environment: 'staging',
    target: {
      id: 'static-aws',
      provider: 'aws',
      provisioner: 'pulumi',
      transport: 'local',
      runtime: 'static',
      bindings: { domain: 'docs.example.invalid' },
    },
    workloads: [
      {
        workspace: { name: '@example/docs', location: 'apps/docs' },
        deployment: {
          schemaVersion: '2',
          enabled: true,
          id: 'docs',
          kind: 'static',
          build: { strategy: 'static', output: 'dist' },
          runtime: { language: 'typescript', command: ['static'] },
        },
      },
    ],
    sourceDigest: 'sha256:source',
    targetStateDigest: 'sha256:state',
  };
}

test('plans static output without shell commands or unmanaged deletion', async () => {
  const adapter = createStaticCloudapter();
  const input = context();
  const plan = await adapter.plan(input);
  assert.equal(plan.actions[0].provider, 'aws');
  assert.equal(plan.actions[0].source.output, 'dist');
  assert.equal(plan.actions[0].destination.domain, 'docs.example.invalid');
  assert.equal(plan.actions[0].policy.deleteUnmanaged, false);
  assert.equal(Object.hasOwn(plan.actions[0], 'command'), false);
  assert.deepEqual(await adapter.render(plan), await adapter.render(plan));
});

test('fails closed without an injected executor and rejects non-static workloads', async () => {
  const adapter = createStaticCloudapter();
  const input = context();
  const plan = await adapter.plan(input);
  await assert.rejects(() => adapter.apply(plan, input), /requires context\.static\.execute/);
  input.workloads[0].deployment.kind = 'service';
  await assert.rejects(() => adapter.plan(input), /accept only static workloads/);
});
