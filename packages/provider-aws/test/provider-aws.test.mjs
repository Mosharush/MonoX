import assert from 'node:assert/strict';
import test from 'node:test';

import { createAwsProviderCloudapter } from '../src/index.mjs';

function context() {
  return {
    config: { project: { name: 'example' } },
    environment: 'production',
    sourceDigest: 'sha256:source',
    targetStateDigest: 'sha256:state',
    target: {
      id: 'production-eks',
      provider: 'aws',
      provisioner: 'pulumi',
      transport: 'kubernetes-api',
      runtime: 'kubernetes',
      region: 'us-east-1',
      projectRef: 'aws-project',
      bindings: {
        identityRef: 'iam-role://github-actions-production',
        secretStoreRef: 'secrets-manager://production',
      },
    },
    workloads: [
      { deployment: { id: 'model', resources: { accelerators: [{ type: 'nvidia.com/gpu', count: 1 }] } } },
    ],
  };
}

test('plans EKS and GPU capacity with OIDC references only', async () => {
  const adapter = createAwsProviderCloudapter();
  const input = context();
  const plan = await adapter.plan(input);
  assert(plan.actions.some((action) => action.resource === 'eks'));
  assert(plan.actions.some((action) => action.operation === 'ensure-gpu-node-capacity'));
  assert.deepEqual(plan.actions.find((action) => action.operation === 'ensure-gpu-node-capacity').capacity, [
    'spot',
    'on-demand',
  ]);
  assert.equal(
    plan.actions.find((action) => action.operation === 'ensure-secret-integration').secretStoreRef,
    'secrets-manager://production'
  );
  assert.equal(plan.metadata.identity, 'github-oidc');
  await assert.rejects(() => adapter.apply(plan, input), /plan-only.*apply is unsupported/);
  await assert.rejects(
    () => adapter.apply(plan, { ...input, sourceDigest: 'sha256:changed' }),
    /Plan is stale/
  );
  await assert.rejects(() => adapter.rollback({ plan }, input), /plan-only.*rollback is unsupported/);
  await assert.rejects(() => adapter.destroy({ plan, confirm: 'wrong' }, input), /Destroy confirmation/);
  await assert.rejects(
    () => adapter.destroy({ plan, confirm: 'example/production/production-eks' }, input),
    /plan-only.*destroy is unsupported/
  );
});

test('rejects static AWS credentials', async () => {
  const adapter = createAwsProviderCloudapter();
  const input = context();
  input.target.bindings.accessKey = 'not-allowed';
  const validation = await adapter.validate(input);
  assert.equal(validation.valid, false);
  assert(validation.errors.some((error) => /identity reference/.test(error)));
});
