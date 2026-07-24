import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../src/cli.mjs';
import { buildKubernetesResources, renderKubernetesManifests } from '../src/index.mjs';

function deployment(overrides = {}) {
  return {
    schemaVersion: '1',
    name: 'example-api',
    namespace: 'example',
    labels: { 'app.kubernetes.io/part-of': 'example-platform' },
    image: {
      repository: 'registry.invalid/example/api',
      tag: '0.1.0',
    },
    container: {
      port: 3000,
      env: [{ name: 'NODE_ENV', value: 'production' }],
      envFromSecrets: ['example-runtime'],
    },
    service: { enabled: true, port: 80 },
    ingress: {
      enabled: true,
      className: 'example-gateway',
      host: 'api.example.invalid',
      tls: { enabled: false },
    },
    probes: {
      startup: { path: '/healthz' },
      readiness: { path: '/readyz' },
      liveness: { path: '/healthz' },
    },
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    },
    autoscaling: {
      mode: 'hpa',
      minReplicas: 2,
      maxReplicas: 12,
      cpuUtilization: 70,
      memoryUtilization: 75,
    },
    networkPolicy: {
      enabled: true,
      ingressFrom: [
        {
          namespaceLabels: { 'kubernetes.io/metadata.name': 'gateway-system' },
          podLabels: { 'app.kubernetes.io/component': 'gateway' },
        },
      ],
      egress: { dns: true, https: true, sameNamespace: true },
    },
    ...overrides,
  };
}

function byKind(resources, kind) {
  return resources.find((resource) => resource.kind === kind);
}

test('renders a complete hardened HPA workload', () => {
  const resources = buildKubernetesResources(deployment());
  assert.deepEqual(
    resources.map((resource) => resource.kind),
    [
      'Namespace',
      'ServiceAccount',
      'Deployment',
      'Service',
      'Ingress',
      'PodDisruptionBudget',
      'NetworkPolicy',
      'HorizontalPodAutoscaler',
    ]
  );

  const workload = byKind(resources, 'Deployment');
  const podSpec = workload.spec.template.spec;
  const container = podSpec.containers[0];
  assert.equal(workload.spec.strategy.type, 'RollingUpdate');
  assert.equal(container.image, 'registry.invalid/example/api:0.1.0');
  assert.equal(container.readinessProbe.httpGet.path, '/readyz');
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.equal(podSpec.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(podSpec.automountServiceAccountToken, false);
  assert.equal(podSpec.topologySpreadConstraints.length, 2);
  assert.deepEqual(container.envFrom, [{ secretRef: { name: 'example-runtime' } }]);

  const hpa = byKind(resources, 'HorizontalPodAutoscaler');
  assert.equal(hpa.apiVersion, 'autoscaling/v2');
  assert.equal(hpa.spec.minReplicas, 2);
  assert.equal(hpa.spec.maxReplicas, 12);
  assert.equal(hpa.spec.metrics.length, 2);
});

test('renders KEDA scale to zero instead of an HPA', () => {
  const resources = buildKubernetesResources(
    deployment({
      ingress: { enabled: false, tls: { enabled: false } },
      autoscaling: {
        mode: 'keda',
        minReplicas: 0,
        maxReplicas: 25,
        keda: {
          triggers: [
            {
              type: 'prometheus',
              metadata: {
                serverAddress: 'http://metrics.monitoring.svc.cluster.local',
                query: 'sum(example_pending_jobs)',
                threshold: '5',
              },
              authenticationRef: 'example-metrics-auth',
            },
          ],
        },
      },
    })
  );

  assert.equal(byKind(resources, 'HorizontalPodAutoscaler'), undefined);
  const scaledObject = byKind(resources, 'ScaledObject');
  assert.equal(scaledObject.spec.minReplicaCount, 0);
  assert.equal(scaledObject.spec.maxReplicaCount, 25);
  assert.deepEqual(scaledObject.spec.triggers[0].authenticationRef, { name: 'example-metrics-auth' });
});

test('emits deterministic multi-document YAML without private markers', () => {
  const yaml = renderKubernetesManifests(deployment());
  const forbiddenPattern = new RegExp(
    [
      ['select', 'ika'].join(''),
      ['ease', 'dev', 'flow'].join(''),
      '\\.com\\b',
      'password',
      'private[_-]?key',
    ].join('|'),
    'i'
  );
  assert.match(yaml, /^apiVersion: "v1"/);
  assert.match(yaml, /\n---\napiVersion: "apps\/v1"/);
  assert.match(yaml, /kind: "NetworkPolicy"/);
  assert.match(yaml, /runAsNonRoot: true/);
  assert.doesNotMatch(yaml, forbiddenPattern);
  assert.equal(yaml, renderKubernetesManifests(deployment()));
});

test('CLI validates and renders JSON to an explicit output file', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monox-kube-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'deployment.json');
  const output = path.join(directory, 'manifests.yaml');
  await writeFile(input, JSON.stringify(deployment()), 'utf8');

  let messages = '';
  const stdout = { write: (chunk) => (messages += chunk) };
  const validation = await run(['validate', input], { stdout });
  assert.equal(validation.config.schemaVersion, '1');
  assert.match(messages, /Valid deployment configuration/);

  await run(['render', input, '--output', output], { stdout });
  const yaml = await readFile(output, 'utf8');
  assert.match(yaml, /kind: "Deployment"/);
  assert.match(messages, /Rendered Kubernetes manifests/);
});

test('CLI rejects an empty output path', async () => {
  await assert.rejects(() => run(['render', 'deployment.json', '--output=']), /requires a file path/);
});
