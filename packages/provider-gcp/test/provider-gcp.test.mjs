import assert from 'node:assert/strict';
import test from 'node:test';

import { createGcpProviderCloudapter } from '../src/index.mjs';

function context() {
  return {
    config: { project: { name: 'example' } },
    environment: 'production',
    sourceDigest: 'sha256:source',
    targetStateDigest: 'sha256:state',
    target: {
      id: 'production-gke',
      provider: 'gcp',
      provisioner: 'pulumi',
      transport: 'kubernetes-api',
      runtime: 'kubernetes',
      region: 'us-central1',
      projectRef: 'gcp-project',
      bindings: {
        identityRef: 'wif://github-production/deployer',
        secretStoreRef: 'secret-manager://production',
      },
    },
    workloads: [
      { deployment: { id: 'model', resources: { accelerators: [{ type: 'nvidia.com/gpu', count: 1 }] } } },
    ],
  };
}

test('plans GKE security, observability and GPU capacity with WIF references', async () => {
  const adapter = createGcpProviderCloudapter();
  const input = context();
  const plan = await adapter.plan(input);
  const cluster = plan.actions.find((action) => action.resource === 'gke-standard');
  assert.equal(cluster.workloadIdentity, true);
  assert.equal(cluster.dataplaneV2, true);
  const monitoring = plan.actions.find((action) => action.resource === 'google-cloud-monitoring');
  assert(monitoring.metrics.includes('APISERVER'));
  assert.equal(monitoring.alerts[0].metric, 'apiserver_request_duration_seconds');
  const gpu = plan.actions.find((action) => action.operation === 'ensure-gpu-node-capacity');
  assert.deepEqual(gpu.capacity, ['spot', 'on-demand']);
  assert.equal(gpu.dcgmMetrics, true);
  assert.equal(
    plan.actions.find((action) => action.operation === 'ensure-secret-integration').secretStoreRef,
    'secret-manager://production'
  );
  await assert.rejects(() => adapter.apply(plan, input), /plan-only.*apply is unsupported/);
  await assert.rejects(
    () => adapter.apply(plan, { ...input, targetStateDigest: 'sha256:changed' }),
    /Plan is stale/
  );
  await assert.rejects(() => adapter.rollback({ plan }, input), /plan-only.*rollback is unsupported/);
  await assert.rejects(() => adapter.destroy({ plan, confirm: 'wrong' }, input), /Destroy confirmation/);
  await assert.rejects(
    () => adapter.destroy({ plan, confirm: 'example/production/production-gke' }, input),
    /plan-only.*destroy is unsupported/
  );
});

test('rejects service account key material', async () => {
  const adapter = createGcpProviderCloudapter();
  const input = context();
  input.target.bindings.serviceAccountKey = 'not-allowed';
  const validation = await adapter.validate(input);
  assert.equal(validation.valid, false);
  assert(validation.errors.some((error) => /identity reference/.test(error)));
});
