import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEPLOYMENT_SCHEMA_VERSION,
  DeploymentValidationError,
  assertValidDeploymentConfig,
  deploymentSchema,
  validateDeploymentConfig,
} from '../src/index.mjs';

function validConfig(overrides = {}) {
  return {
    schemaVersion: '1',
    name: 'example-api',
    namespace: 'example',
    image: {
      repository: 'registry.invalid/example/api',
      tag: '0.1.0',
    },
    container: {
      port: 3000,
      env: [{ name: 'NODE_ENV', value: 'production' }],
    },
    service: {
      enabled: true,
      port: 80,
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
      maxReplicas: 10,
      cpuUtilization: 70,
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

test('exports a versioned JSON schema and normalizes safe defaults', () => {
  assert.equal(DEPLOYMENT_SCHEMA_VERSION, '1');
  assert.equal(deploymentSchema.$id, 'urn:monox:deployment:v1');

  const config = assertValidDeploymentConfig(validConfig());
  assert.equal(config.image.pullPolicy, 'IfNotPresent');
  assert.equal(config.serviceAccount.create, true);
  assert.equal(config.serviceAccount.name, 'example-api');
  assert.equal(config.podSecurity.readOnlyRootFilesystem, true);
  assert.equal(config.probes.startup.failureThreshold, 30);
  assert.deepEqual(config.topologySpread.topologyKeys, [
    'topology.kubernetes.io/zone',
    'kubernetes.io/hostname',
  ]);
});

test('accepts KEDA scale to zero with external authentication', () => {
  const result = validateDeploymentConfig(
    validConfig({
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

  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.value.autoscaling.keda.pollingInterval, 30);
  assert.equal(result.value.autoscaling.keda.cooldownPeriod, 300);
});

test('rejects mutable image tags and inline secret-like environment values', () => {
  const result = validateDeploymentConfig(
    validConfig({
      image: { repository: 'example-api', tag: 'latest' },
      container: {
        port: 3000,
        env: [{ name: 'API_TOKEN', value: 'not-allowed-here' }],
      },
    })
  );

  assert.equal(result.valid, false);
  assert(result.errors.some((error) => error.path === '$.image.tag' && error.code === 'security'));
  assert(
    result.errors.some((error) => error.path === '$.container.env[0].value' && error.code === 'security')
  );
});

test('rejects resource requests above limits and invalid HPA scale to zero', () => {
  const result = validateDeploymentConfig(
    validConfig({
      resources: {
        requests: { cpu: '900m', memory: '1Gi' },
        limits: { cpu: '500m', memory: '512Mi' },
      },
      autoscaling: {
        mode: 'hpa',
        minReplicas: 0,
        maxReplicas: 3,
        cpuUtilization: 70,
      },
    })
  );

  assert.equal(result.valid, false);
  assert(result.errors.some((error) => error.path === '$.resources.requests.cpu'));
  assert(result.errors.some((error) => error.path === '$.resources.requests.memory'));
  assert(result.errors.some((error) => error.path === '$.autoscaling.minReplicas'));
});

test('rejects rolling updates whose integer or percentage limits both resolve to zero', () => {
  for (const rollingUpdate of [
    { maxSurge: 0, maxUnavailable: 0 },
    { maxSurge: '0%', maxUnavailable: 0 },
    { maxSurge: 0, maxUnavailable: '0%' },
    { maxSurge: '0%', maxUnavailable: '0%' },
  ]) {
    const result = validateDeploymentConfig(validConfig({ rollingUpdate }));
    assert.equal(result.valid, false, JSON.stringify(rollingUpdate));
    assert(result.errors.some((error) => error.path === '$.rollingUpdate' && error.code === 'kubernetes'));
  }
});

test('rejects open-ended network peers and ingress without a Service', () => {
  const result = validateDeploymentConfig(
    validConfig({
      service: { enabled: false, port: 80 },
      ingress: { enabled: true, host: 'app.example.invalid', tls: { enabled: false } },
      networkPolicy: {
        enabled: true,
        ingressFrom: [{}],
        egress: { dns: true, https: false, sameNamespace: false },
      },
    })
  );

  assert.equal(result.valid, false);
  assert(result.errors.some((error) => error.path === '$.ingress.enabled'));
  assert(result.errors.some((error) => error.path === '$.networkPolicy.ingressFrom[0]'));
});

test('throws a structured validation error', () => {
  assert.throws(
    () => assertValidDeploymentConfig({ schemaVersion: '2' }),
    (error) => error instanceof DeploymentValidationError && error.errors.length > 0
  );
});
