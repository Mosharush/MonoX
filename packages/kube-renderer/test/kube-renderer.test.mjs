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

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
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
    ['private[_-]?product', 'customer[_-]?(?:name|domain)', '\\.com\\b', 'password', 'private[_-]?key'].join(
      '|'
    ),
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

test('renders a v2 non-network worker without a Service or Ingress', async () => {
  const input = await fixture('v2-worker');
  const resources = buildKubernetesResources(input);
  const golden = JSON.parse(
    await readFile(new URL('./golden/v2-worker.resources.json', import.meta.url), 'utf8')
  );
  assert.deepEqual(
    resources.map(({ apiVersion, kind, metadata }) => ({ apiVersion, kind, name: metadata.name })),
    golden
  );
  assert.equal(byKind(resources, 'Service'), undefined);
  assert.equal(byKind(resources, 'Ingress'), undefined);

  const workload = byKind(resources, 'Deployment');
  const pod = workload.spec.template.spec;
  const serviceAccount = byKind(resources, 'ServiceAccount');
  assert.equal(serviceAccount.metadata.name, 'queue-worker');
  assert.equal(serviceAccount.automountServiceAccountToken, false);
  assert.notEqual(pod.serviceAccountName, 'default');
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(pod.containers[0].securityContext.runAsNonRoot, true);
  assert.equal(pod.containers[0].securityContext.allowPrivilegeEscalation, false);
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(pod.containers[0].securityContext.capabilities.drop, ['ALL']);
  assert(pod.containers[0].startupProbe.exec.command.length > 0);
  assert(pod.containers[0].readinessProbe.exec.command.length > 0);
  assert(pod.containers[0].livenessProbe.exec.command.length > 0);
  assert.deepEqual(pod.containers[0].resources.requests, { cpu: '250m', memory: '256Mi' });
  assert.deepEqual(pod.containers[0].resources.limits, { cpu: '1', memory: '1Gi' });
  assert.deepEqual(pod.containers[0].lifecycle.preStop.exec.command, ['node', 'dist/drain.mjs']);
  assert.equal(pod.terminationGracePeriodSeconds, 300);
  assert.deepEqual(
    pod.topologySpreadConstraints.map((constraint) => constraint.topologyKey),
    ['topology.kubernetes.io/zone', 'kubernetes.io/hostname']
  );

  assert.equal(byKind(resources, 'PodDisruptionBudget').spec.maxUnavailable, 1);
  assert.equal(
    resources.some(({ kind }) => ['Role', 'RoleBinding', 'ClusterRole'].includes(kind)),
    false
  );

  const policy = byKind(resources, 'NetworkPolicy');
  assert.deepEqual(policy.spec.ingress, []);
  assert.deepEqual(policy.spec.policyTypes, ['Ingress', 'Egress']);
  assert.deepEqual(policy.spec.egress, [
    {
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
    { to: [{ podSelector: {} }] },
  ]);
  assert.equal(
    policy.spec.egress.some((rule) => rule.to == null),
    false
  );
  assert.equal(
    policy.spec.egress.some((rule) => rule.to.some((peer) => 'ipBlock' in peer)),
    false
  );
  const scaler = byKind(resources, 'ScaledObject');
  assert.equal(scaler.spec.minReplicaCount, 0);
  assert.equal(scaler.spec.fallback.replicas, 2);
  assert.equal(scaler.spec.triggers[0].metadata.protocol, 'auto');
  assert.equal(scaler.spec.triggers[0].metadata.hostFromEnv, 'RABBITMQ_URL');
  assert.equal(
    scaler.spec.advanced.horizontalPodAutoscalerConfig.behavior.scaleDown.stabilizationWindowSeconds,
    300
  );

  const yaml = renderKubernetesManifests(input);
  assert.doesNotMatch(yaml, /allow_pod_self_patch|verbs:\s*\[[^\]]*patch/i);
});

test('preserves the image WORKDIR for a relative runtime working directory', async () => {
  const input = await fixture('v2-worker');
  input.deployment.runtime.workingDirectory = 'apps/queue-worker';

  const workload = byKind(buildKubernetesResources(input), 'Deployment');
  const container = workload.spec.template.spec.containers[0];
  assert.equal(Object.hasOwn(container, 'workingDir'), false);
});

test('renders an explicit absolute container working directory', async () => {
  const input = await fixture('v2-worker');
  input.deployment.runtime.workingDirectory = '/workspace/apps/queue-worker';

  const workload = byKind(buildKubernetesResources(input), 'Deployment');
  const container = workload.spec.template.spec.containers[0];
  assert.equal(container.workingDir, '/workspace/apps/queue-worker');
});

test('renders a v2 GPU model with per-replica cache and ServiceMonitor', async () => {
  const input = await fixture('v2-model');
  input.deployment.labels = {
    team: 'models',
    'app.kubernetes.io/managed-by': 'untrusted-override',
    'monox.dev/environment': 'untrusted-override',
  };
  const resources = buildKubernetesResources(input);
  assert.deepEqual(
    resources.map(({ kind }) => kind),
    [
      'Namespace',
      'ServiceAccount',
      'Service',
      'StatefulSet',
      'Service',
      'PodDisruptionBudget',
      'NetworkPolicy',
      'ScaledObject',
      'ServiceMonitor',
    ]
  );

  const serviceAccount = byKind(resources, 'ServiceAccount');
  assert.equal(
    serviceAccount.metadata.annotations['iam.gke.io/gcp-service-account'],
    'embedding-model@example.invalid'
  );
  const workload = byKind(resources, 'StatefulSet');
  assert.equal(workload.metadata.labels.team, 'models');
  assert.equal(workload.metadata.labels['app.kubernetes.io/managed-by'], 'monox');
  assert.equal(workload.metadata.labels['monox.dev/environment'], 'production');
  assert.equal(workload.spec.volumeClaimTemplates[0].spec.resources.requests.storage, '100Gi');
  assert.equal(workload.spec.template.spec.nodeSelector['nvidia.com/gpu.present'], 'true');
  const workloadResources = workload.spec.template.spec.containers[0].resources;
  assert.equal(workloadResources.requests['nvidia.com/gpu'], '1');
  assert.equal(workloadResources.limits['nvidia.com/gpu'], '1');
  assert.equal(workload.spec.template.spec.tolerations[0].key, 'nvidia.com/gpu');
  assert.doesNotMatch(
    JSON.stringify(resources),
    /machineSku|machineType|instanceType|node\.kubernetes\.io\/instance-type/i
  );

  const scaler = byKind(resources, 'ScaledObject');
  assert.equal(
    scaler.spec.triggers[0].metadata.serverAddress,
    'http://prometheus.monitoring.svc.cluster.local:9090'
  );
  assert.equal(byKind(resources, 'ServiceMonitor').spec.endpoints[0].port, 'metrics');
  const networkPolicy = byKind(resources, 'NetworkPolicy');
  assert.deepEqual(networkPolicy.spec.ingress[0].from[1], {
    podSelector: {
      matchLabels: {
        'app.kubernetes.io/managed-by': 'monox',
        'monox.dev/environment': 'production',
      },
    },
  });
  const monitoringIngress = networkPolicy.spec.ingress.find(
    (rule) => rule.from?.[0]?.namespaceSelector?.matchLabels?.['monox.dev/monitoring-access'] === 'true'
  );
  assert.equal(monitoringIngress.ports[0].port, 9090);
});

test('renders v2 HPA resource metrics and batch workload kinds', async () => {
  const model = await fixture('v2-model');
  model.deployment.id = 'example-api';
  model.deployment.kind = 'service';
  model.deployment.storage = [];
  model.deployment.resources.accelerators = [];
  model.deployment.telemetry.metrics.enabled = false;
  model.deployment.scaling = {
    mode: 'hpa',
    minReplicas: 2,
    maxReplicas: 10,
    metrics: [
      { type: 'cpu', target: 70 },
      { type: 'memory', target: 75 },
    ],
  };
  const serviceResources = buildKubernetesResources(model);
  const hpa = byKind(serviceResources, 'HorizontalPodAutoscaler');
  assert.equal(hpa.spec.metrics.length, 2);
  assert.equal(hpa.spec.behavior.scaleDown.stabilizationWindowSeconds, 300);

  const worker = await fixture('v2-worker');
  worker.deployment.scaling = { mode: 'none', minReplicas: 1, maxReplicas: 1, metrics: [] };
  worker.deployment.kind = 'job';
  assert(byKind(buildKubernetesResources(worker), 'Job'));
  worker.deployment.kind = 'cron';
  worker.deployment.runtime.cron = '0 2 * * *';
  assert(byKind(buildKubernetesResources(worker), 'CronJob'));
});

test('renders target-packaged static output and suspends long-lived workloads', async () => {
  const input = await fixture('v2-model');
  input.deployment.id = 'docs';
  input.deployment.kind = 'static';
  input.deployment.build = {
    strategy: 'static',
    output: 'dist',
    image: { repository: 'registry.invalid/example/docs', tag: '0.2.0' },
  };
  input.deployment.runtime = {
    language: 'typescript',
    command: ['serve', 'dist'],
  };
  input.deployment.storage = [];
  input.deployment.resources.accelerators = [];
  input.deployment.telemetry.metrics.enabled = false;
  input.deployment.suspended = true;
  input.deployment.scaling = { mode: 'none', minReplicas: 0, maxReplicas: 1, metrics: [] };

  const resources = buildKubernetesResources(input);
  assert.equal(byKind(resources, 'Deployment').spec.replicas, 0);
  assert(byKind(resources, 'Service'));
  assert.equal(byKind(resources, 'HorizontalPodAutoscaler'), undefined);
  assert.equal(byKind(resources, 'ScaledObject'), undefined);
});

test('rejects invalid v2 exposure and scale-to-zero before rendering', async () => {
  const worker = await fixture('v2-worker');
  worker.deployment.network = {
    exposure: 'public',
    ports: [{ name: 'http', containerPort: 3000 }],
    routes: [{ host: 'worker.example.invalid', path: '/' }],
  };
  assert.throws(() => buildKubernetesResources(worker), /worker workloads cannot be public/);

  const model = await fixture('v2-model');
  model.deployment.scaling.metrics = [{ type: 'cpu', target: 70 }];
  assert.throws(() => buildKubernetesResources(model), /scale to zero requires an external metric/);

  const rps = await fixture('v2-model');
  rps.deployment.scaling.metrics[0].sourceRef = 'PROMETHEUS_URL';
  assert.throws(() => buildKubernetesResources(rps), /sourceRef/);

  const noDrain = await fixture('v2-worker');
  noDrain.deployment.lifecycle.drain.enabled = false;
  assert.throws(() => buildKubernetesResources(noDrain), /enabled drain contract/);
});

test('maps typed queue metrics and validates generic KEDA scaler metadata', async () => {
  const cases = [
    {
      metric: { type: 'sqs', target: 5, sourceRef: 'SQS_QUEUE_URL' },
      scaler: 'aws-sqs-queue',
      field: ['queueURLFromEnv', 'SQS_QUEUE_URL'],
    },
    {
      metric: { type: 'pubsub', target: 5, sourceRef: 'pubsub-source', topic: 'jobs-subscription' },
      scaler: 'gcp-pubsub',
      field: ['subscriptionName', 'jobs-subscription'],
    },
    {
      metric: { type: 'redis', target: 5, sourceRef: 'REDIS_ADDRESS', queue: 'jobs' },
      scaler: 'redis',
      field: ['addressFromEnv', 'REDIS_ADDRESS'],
    },
    {
      metric: {
        type: 'kafka',
        target: 5,
        sourceRef: 'kafka.example.invalid:9092',
        topic: 'jobs',
        consumerGroup: 'workers',
      },
      scaler: 'kafka',
      field: ['bootstrapServers', 'kafka.example.invalid:9092'],
    },
    {
      metric: {
        type: 'nats',
        target: 5,
        sourceRef: 'http://nats.monitoring.svc.cluster.local:8222',
        stream: 'jobs',
        consumerGroup: 'workers',
      },
      scaler: 'nats-jetstream',
      field: ['stream', 'jobs'],
    },
    {
      metric: {
        type: 'keda',
        target: 5,
        scaler: 'metrics-api',
        metadata: { url: 'http://metrics.example.invalid/value', targetValue: '5' },
      },
      scaler: 'metrics-api',
      field: ['targetValue', '5'],
    },
  ];

  for (const { metric, scaler, field } of cases) {
    const input = await fixture('v2-worker');
    input.deployment.scaling.metrics = [metric];
    if (metric.type === 'sqs') {
      input.target.provider = 'aws';
      input.target.region = 'us-east-1';
    }
    if (['sqs', 'redis'].includes(metric.type))
      input.deployment.env.values[metric.sourceRef] = 'external-ref';
    const trigger = byKind(buildKubernetesResources(input), 'ScaledObject').spec.triggers[0];
    assert.equal(trigger.type, scaler);
    assert.equal(trigger.metadata[field[0]], field[1]);
    if (metric.type === 'sqs') assert.equal(trigger.metadata.awsRegion, 'us-east-1');
    if (metric.type === 'pubsub') assert.equal(trigger.metadata.mode, 'SubscriptionSize');
    if (metric.type === 'nats') {
      assert.equal(trigger.metadata.natsServerMonitoringEndpoint, 'nats.monitoring.svc.cluster.local:8222');
      assert.equal(trigger.metadata.useHttps, 'false');
    }
  }

  const alternatives = await fixture('v2-worker');
  alternatives.deployment.scaling.metrics.push({ type: 'cpu', target: 70 });
  const triggers = byKind(buildKubernetesResources(alternatives), 'ScaledObject').spec.triggers;
  assert.deepEqual(
    triggers.map(({ type }) => type),
    ['rabbitmq', 'cpu']
  );
});
