import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createKubernetesCloudapter } from '../src/index.mjs';

async function context() {
  const workload = JSON.parse(
    await readFile(new URL('../../kube-renderer/test/fixtures/v2-worker.json', import.meta.url), 'utf8')
  );
  return {
    config: { project: { name: 'example' } },
    environment: 'production',
    target: workload.target,
    workloads: [workload],
    sourceDigest: 'sha256:source',
    targetStateDigest: 'sha256:state',
  };
}

test('plans and renders deterministic Kubernetes artifacts offline', async () => {
  const adapter = createKubernetesCloudapter();
  const input = await context();
  const plan = await adapter.plan(input);
  assert.equal(plan.actions[0].operation, 'apply-manifests');
  assert.equal(plan.metadata.clusterRef, 'example-cluster');
  assert.equal(plan.metadata.identityRef, 'example-runtime-identity');
  assert.deepEqual(plan.actions[0].resourceIds, [
    'Namespace/example-production',
    'ServiceAccount/queue-worker',
    'Deployment/queue-worker',
    'PodDisruptionBudget/queue-worker',
    'NetworkPolicy/queue-worker',
    'ScaledObject/queue-worker',
  ]);
  const first = await adapter.render(plan, input);
  const second = await adapter.render(plan, input);
  assert.deepEqual(first, second);
  assert.match(first.artifacts[0].content, /readOnlyRootFilesystem: true/);
  assert.doesNotMatch(first.artifacts[0].content, /kind: "Service"/);
});

test('materializes target-derived image, namespace and domain before rendering', async () => {
  const adapter = createKubernetesCloudapter();
  const input = await context();
  const workload = input.workloads[0];
  workload.deployment.id = 'public-api';
  workload.deployment.kind = 'service';
  delete workload.deployment.build.image;
  workload.deployment.network = {
    exposure: 'public',
    ports: [{ name: 'http', containerPort: 3000 }],
    routes: [{ path: '/' }],
  };
  workload.deployment.probes = {
    startup: { type: 'http', path: '/health', port: 'http' },
    readiness: { type: 'http', path: '/ready', port: 'http' },
    liveness: { type: 'http', path: '/health', port: 'http' },
  };
  workload.deployment.lifecycle = {
    terminationGracePeriodSeconds: 60,
    preStopCommand: [],
    drain: { enabled: false, timeoutSeconds: 30 },
  };
  workload.deployment.scaling = { mode: 'none', minReplicas: 1, maxReplicas: 1, metrics: [] };
  input.target.bindings.domain = 'apps.example.invalid';

  const plan = await adapter.plan(input);
  assert.equal(plan.workloads[0].deployment.build.image.repository, 'registry.invalid/example/public-api');
  assert.match(plan.workloads[0].deployment.build.image.tag, /^source-[a-f0-9]{24}$/);
  const rendered = await adapter.render(plan, input);
  assert.match(rendered.artifacts[0].content, /namespace: "example-production"/);
  assert.match(rendered.artifacts[0].content, /host: "apps\.example\.invalid"/);
  assert.match(rendered.artifacts[0].content, /image: "registry\.invalid\/example\/public-api:source-/);
});

test('requires an injected transport and rejects stale apply plans', async () => {
  const adapter = createKubernetesCloudapter();
  const input = await context();
  const plan = await adapter.plan(input);
  await assert.rejects(() => adapter.apply(plan, input), /applyArtifact/);
  await assert.rejects(
    () =>
      adapter.apply(plan, { ...input, sourceDigest: 'sha256:changed', kubernetes: { applyArtifact() {} } }),
    /Plan is stale/
  );
});

test('applies only through an injected function and confirms destroy identity', async () => {
  const adapter = createKubernetesCloudapter();
  const applied = [];
  const input = await context();
  input.kubernetes = {
    async applyArtifact(artifact, binding) {
      applied.push({ name: artifact.name, binding });
      return { changed: true, name: artifact.name };
    },
    async destroy() {
      return { status: 'destroyed', changed: true };
    },
  };
  const plan = await adapter.plan(input);
  const receipt = await adapter.apply(plan, input);
  assert.equal(receipt.result.status, 'applied');
  assert.deepEqual(applied, [
    {
      name: 'queue-worker.kubernetes.yaml',
      binding: {
        clusterRef: 'example-cluster',
        identityRef: 'example-runtime-identity',
        namespace: 'example-production',
      },
    },
  ]);
  await assert.rejects(() => adapter.destroy({ plan, confirm: 'wrong' }, input), /Destroy confirmation/);
  const destroyed = await adapter.destroy({ plan, confirm: 'example/production/production-gke' }, input);
  assert.equal(destroyed.operation, 'destroy');
});
