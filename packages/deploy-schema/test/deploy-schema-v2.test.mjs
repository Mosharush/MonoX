import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEPLOYMENT_SCHEMA_VERSION,
  DEPLOYMENT_SCHEMA_VERSION_V2,
  assertValidDeploymentSpecV2,
  deploymentSchema,
  deploymentSchemaV2,
  deploymentV2AllowedProperties,
  deploymentV2Enums,
  validateDeploymentPatchV2,
  validateDeploymentSpecV2,
} from '../src/index.mjs';
import { generatedTypeFiles } from '../scripts/generate-types.mjs';

function workload(overrides = {}) {
  return {
    schemaVersion: '2',
    enabled: true,
    id: 'example-api',
    kind: 'service',
    build: {
      strategy: 'dockerfile',
      context: '.',
      dockerfile: 'Dockerfile',
      image: { repository: 'registry.invalid/example-api', tag: '0.2.0' },
    },
    runtime: {
      language: 'typescript',
      framework: 'fastify',
      command: ['node', 'dist/server.mjs'],
    },
    network: {
      exposure: 'public',
      ports: [{ name: 'http', containerPort: 3000, servicePort: 80 }],
      routes: [{ host: 'api.example.invalid', path: '/' }],
    },
    probes: {
      startup: { type: 'http', path: '/healthz', port: 'http' },
      readiness: { type: 'http', path: '/readyz', port: 'http' },
      liveness: { type: 'http', path: '/healthz', port: 'http' },
    },
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
      accelerators: [],
    },
    scaling: {
      mode: 'hpa',
      minReplicas: 2,
      maxReplicas: 20,
      metrics: [{ type: 'cpu', target: 70 }],
    },
    ...overrides,
  };
}

test('keeps v1 exports immutable and exposes the v2 schema separately', () => {
  assert.equal(DEPLOYMENT_SCHEMA_VERSION, '1');
  assert.equal(deploymentSchema.$id, 'urn:monox:deployment:v1');
  assert.equal(DEPLOYMENT_SCHEMA_VERSION_V2, '2');
  assert.equal(deploymentSchemaV2.$id, 'urn:monox:deployment:v2');
});

test('keeps runtime enums, required fields and generated types in schema parity', async () => {
  assert.deepEqual(deploymentV2Enums.kind, deploymentSchemaV2.properties.kind.enum);
  assert.deepEqual(
    deploymentV2Enums.buildStrategy,
    deploymentSchemaV2.properties.build.properties.strategy.enum
  );
  assert.deepEqual(
    deploymentV2Enums.language,
    deploymentSchemaV2.properties.runtime.properties.language.enum
  );
  assert.deepEqual(
    deploymentV2Enums.exposure,
    deploymentSchemaV2.properties.network.properties.exposure.enum
  );
  assert.deepEqual(deploymentV2Enums.scalingMode, deploymentSchemaV2.properties.scaling.properties.mode.enum);
  assert.deepEqual(deploymentV2Enums.metricType, deploymentSchemaV2.$defs.scalingMetric.properties.type.enum);
  assert.deepEqual(deploymentSchemaV2.required, [
    'schemaVersion',
    'enabled',
    'id',
    'kind',
    'build',
    'runtime',
  ]);
  const propertyNames = (value) => Object.keys(value.properties).sort();
  for (const [runtimeName, schemaProperties] of [
    ['root', deploymentSchemaV2],
    ['build', deploymentSchemaV2.properties.build],
    ['runtime', deploymentSchemaV2.properties.runtime],
    ['network', deploymentSchemaV2.properties.network],
    ['scaling', deploymentSchemaV2.properties.scaling],
    ['image', deploymentSchemaV2.properties.build.properties.image],
    ['adapterOverrides', deploymentSchemaV2.properties.adapterOverrides],
    ['metric', deploymentSchemaV2.$defs.scalingMetric],
  ]) {
    assert.deepEqual(
      [...deploymentV2AllowedProperties[runtimeName]].sort(),
      propertyNames(schemaProperties),
      `${runtimeName} properties differ between schema and runtime validation`
    );
  }
  for (const file of await generatedTypeFiles()) {
    assert.equal(await readFile(file.path, 'utf8'), file.content, `${file.path} is stale`);
  }
});

test('normalizes a strict provider-neutral workload with secure defaults', () => {
  const result = assertValidDeploymentSpecV2(workload());
  assert.equal(result.identity.automountServiceAccountToken, false);
  assert.equal(result.telemetry.metrics.enabled, false);
  assert.equal(result.lifecycle.terminationGracePeriodSeconds, 60);
  assert.deepEqual(result.env, { values: {}, secretRefs: [] });
});

test('supports partial RFC 7396 overlay shapes without weakening resolved validation', () => {
  for (const patch of [
    { network: { routes: [{ path: '/v2' }] } },
    { probes: { readiness: { timeoutSeconds: 5 } } },
    { scaling: { maxReplicas: 50 } },
    { telemetry: { metrics: { path: '/internal/metrics' } } },
    { lifecycle: { drain: { timeoutSeconds: 120 } } },
  ]) {
    const result = validateDeploymentPatchV2(patch);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  }
});

test('rejects unknown fields, inline credentials and public workers', () => {
  const result = validateDeploymentSpecV2(
    workload({
      kind: 'worker',
      unknownField: true,
      env: { values: { API_TOKEN: 'unsafe' }, secretRefs: [] },
    })
  );
  assert.equal(result.valid, false);
  assert(result.errors.some((issue) => issue.code === 'unknown'));
  assert(result.errors.some((issue) => issue.code === 'security' && issue.path.includes('API_TOKEN')));
  assert(result.errors.some((issue) => issue.path === '$.network.exposure'));
});

test('rejects credential key styles while allowing reference and tokenizer fields', () => {
  const invalid = validateDeploymentSpecV2(
    workload({
      env: {
        values: {
          apiKey: 'unsafe',
          client_secret: 'unsafe',
          accessToken: 'unsafe',
          privateKey: 'unsafe',
          serviceAccountKey: 'unsafe',
          password: 'unsafe',
        },
        secretRefs: [],
      },
    })
  );
  assert.equal(invalid.valid, false);
  for (const key of [
    'apiKey',
    'client_secret',
    'accessToken',
    'privateKey',
    'serviceAccountKey',
    'password',
  ]) {
    assert(
      invalid.errors.some((issue) => issue.code === 'security' && issue.path.endsWith(key)),
      key
    );
  }

  const references = validateDeploymentSpecV2(
    workload({
      env: {
        values: {
          tokenRef: 'runtime-token',
          secretRef: 'runtime-secret',
          credentialName: 'runtime-credential',
          tokenizer: 'cl100k_base',
          promptTokens: '1000',
        },
        secretRefs: [],
      },
    })
  );
  assert.equal(references.valid, true, JSON.stringify(references.errors));
});

test('accepts digest-bound images and rejects incomplete or malformed image references', () => {
  const digest = validateDeploymentSpecV2(
    workload({
      build: {
        strategy: 'dockerfile',
        context: '.',
        dockerfile: 'Dockerfile',
        image: {
          repository: 'registry.invalid/example-api',
          digest: `sha256:${'a'.repeat(64)}`,
        },
      },
    })
  );
  assert.equal(digest.valid, true, JSON.stringify(digest.errors));

  for (const image of [
    { repository: 'registry.invalid/example-api' },
    { repository: 'registry.invalid/example-api', digest: 'sha256:not-a-digest' },
    { tag: '0.2.0' },
  ]) {
    const result = validateDeploymentSpecV2(
      workload({
        build: { strategy: 'dockerfile', context: '.', dockerfile: 'Dockerfile', image },
      })
    );
    assert.equal(result.valid, false, JSON.stringify(image));
  }
});

test('requires external metrics for scale to zero and explicit RPS sources', () => {
  const invalid = validateDeploymentSpecV2(
    workload({
      scaling: {
        mode: 'keda',
        minReplicas: 0,
        maxReplicas: 20,
        metrics: [{ type: 'cpu', target: 70 }],
      },
    })
  );
  assert(invalid.errors.some((issue) => issue.path === '$.scaling.minReplicas'));

  const valid = validateDeploymentSpecV2(
    workload({
      scaling: {
        mode: 'keda',
        minReplicas: 0,
        maxReplicas: 20,
        pollingInterval: 15,
        cooldownPeriod: 120,
        metrics: [
          {
            type: 'rps',
            target: 40,
            sourceRef: 'platform-metrics',
            query: 'sum(rate(http_requests_total[1m]))',
          },
        ],
      },
    })
  );
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));

  const invalidTiming = validateDeploymentSpecV2(
    workload({
      scaling: {
        mode: 'keda',
        minReplicas: 0,
        maxReplicas: 20,
        pollingInterval: 0,
        cooldownPeriod: -1,
        metrics: [
          {
            type: 'external',
            target: 1,
            sourceRef: 'platform-metrics',
            metricName: 'pending_jobs',
          },
        ],
      },
    })
  );
  assert.equal(invalidTiming.errors.filter((issue) => issue.code === 'range').length, 2);
});

test('supports GPU accelerators and variant environment patches', () => {
  const result = validateDeploymentSpecV2(
    workload({
      kind: 'model',
      resources: {
        requests: { cpu: '1', memory: '2Gi', ephemeralStorage: '4Gi' },
        limits: { cpu: '4', memory: '8Gi', ephemeralStorage: '8Gi' },
        accelerators: [{ type: 'nvidia.com/gpu', count: 1, model: 'l4' }],
      },
      variants: {
        spot: {
          labels: { capacity: 'spot' },
          environments: { production: { scaling: { maxReplicas: 10 } } },
        },
      },
    })
  );
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('enforces resource bounds and treats suspension independently from normal scaling', () => {
  const invalid = validateDeploymentSpecV2(
    workload({
      resources: {
        requests: { cpu: '2', memory: '2Gi', ephemeralStorage: '4Gi' },
        limits: { cpu: '1', memory: '1Gi', ephemeralStorage: '2Gi' },
        accelerators: [],
      },
    })
  );
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.filter((issue) => issue.code === 'range').length, 3);

  const suspended = validateDeploymentSpecV2(
    workload({
      suspended: true,
      scaling: { mode: 'none', minReplicas: 0, maxReplicas: 1, metrics: [] },
    })
  );
  assert.equal(suspended.valid, true, JSON.stringify(suspended.errors));
});
