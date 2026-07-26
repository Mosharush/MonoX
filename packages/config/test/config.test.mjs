import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TargetBindingError,
  applyMergePatch,
  assertValidMonoXConfigV2,
  discoverDeploymentWorkspaces,
  resolveDeploymentSpecV2,
  resolveProjectDeployments,
  monoxTargetAxes,
  validateMonoXConfigV2,
} from '../src/index.mjs';

function config(overrides = {}) {
  return {
    schemaVersion: '2',
    project: {
      name: 'example',
      workspaceGlobs: ['apps/*', 'packages/*'],
      defaultEnvironment: 'local',
    },
    boundaries: { apps: ['packages'], packages: ['packages'] },
    workloadProfiles: {
      standard: {
        resources: { requests: { cpu: '200m' } },
        env: { values: { PROFILE_VALUE: 'profile' } },
      },
    },
    environments: {
      local: {
        bindings: [{ target: 'local-docker', selector: { workloads: ['*'] } }],
      },
      production: {
        production: true,
        protected: true,
        bindings: [{ target: 'production-kubernetes', selector: { workloads: ['*'] } }],
      },
    },
    targets: {
      'local-docker': {
        provider: 'generic',
        provisioner: 'none',
        transport: 'local',
        runtime: 'docker',
      },
      'production-kubernetes': {
        provider: 'gcp',
        provisioner: 'pulumi',
        transport: 'kubernetes-api',
        runtime: 'kubernetes',
        region: 'example-region',
        projectRef: 'production-project',
        bindings: {
          namespace: 'example',
          registry: 'registry.invalid/example',
          identityRef: 'runtime-identity',
          secretStoreRef: 'runtime-secrets',
        },
      },
    },
    addons: {
      redis: {
        recipe: 'redis',
        enabled: true,
        mode: 'bundled',
        environments: ['local'],
        config: { VERSION: '8' },
      },
    },
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return {
    schemaVersion: '2',
    enabled: true,
    id: 'api',
    kind: 'service',
    profile: 'standard',
    build: { strategy: 'dockerfile', context: '.', dockerfile: 'Dockerfile' },
    runtime: { language: 'typescript', command: ['node', 'dist/server.mjs'] },
    network: {
      exposure: 'public',
      ports: [{ name: 'http', containerPort: 3000 }],
      routes: [{ host: 'api.example.invalid', path: '/' }],
    },
    probes: {
      readiness: { type: 'http', path: '/readyz', port: 'http' },
      liveness: { type: 'http', path: '/healthz', port: 'http' },
    },
    env: { values: { PACKAGE_VALUE: 'package', REMOVE_ME: 'yes' }, secretRefs: [] },
    environments: {
      production: {
        env: { values: { PACKAGE_VALUE: 'production', REMOVE_ME: null } },
        scaling: { mode: 'hpa', minReplicas: 2, maxReplicas: 10, metrics: [{ type: 'cpu', target: 70 }] },
      },
    },
    variants: {
      canary: {
        labels: { track: 'canary' },
        environments: { production: { scaling: { maxReplicas: 3 } } },
      },
    },
    ...overrides,
  };
}

test('validates strict project configuration and rejects secret values', () => {
  assertValidMonoXConfigV2(config());
  const invalid = validateMonoXConfigV2(
    config({
      addons: {
        redis: {
          recipe: 'redis',
          enabled: true,
          mode: 'managed',
          config: { API_TOKEN: 'not-allowed' },
        },
      },
    })
  );
  assert.equal(invalid.valid, false);
  assert(invalid.errors.some((issue) => issue.code === 'security'));
});

test('rejects add-on credential keys in every naming style and permits references', () => {
  for (const key of [
    'apiKey',
    'api-key',
    'api_key',
    'clientSecret',
    'accessToken',
    'privateKey',
    'serviceAccountKey',
    'password',
  ]) {
    const candidate = config();
    candidate.addons.redis.config = { [key]: 'unsafe' };
    const result = validateMonoXConfigV2(candidate);
    assert(
      result.errors.some((issue) => issue.code === 'security' && issue.path.endsWith(key)),
      key
    );
  }

  const candidate = config();
  candidate.addons.redis.config = {
    tokenRef: 'runtime-token',
    secretRef: 'runtime-secret',
    credentialName: 'runtime-credential',
    tokenizer: 'cl100k_base',
    completionTokenCount: '1000',
  };
  const result = validateMonoXConfigV2(candidate);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('keeps project schema target axes and required fields in runtime parity', async () => {
  const schema = JSON.parse(
    await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('../../../schemas/v2/monox.schema.json', import.meta.url), 'utf8')
    )
  );
  assert.deepEqual(monoxTargetAxes.provider, schema.$defs.target.properties.provider.enum);
  assert.deepEqual(monoxTargetAxes.provisioner, schema.$defs.target.properties.provisioner.enum);
  assert.deepEqual(monoxTargetAxes.transport, schema.$defs.target.properties.transport.enum);
  assert.deepEqual(monoxTargetAxes.runtime, schema.$defs.target.properties.runtime.enum);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'project',
    'boundaries',
    'workloadProfiles',
    'environments',
    'targets',
    'addons',
  ]);
});

test('implements RFC 7396 with replacement arrays and null deletion', () => {
  assert.deepEqual(
    applyMergePatch(
      { object: { keep: 1, remove: 2 }, array: [1, 2] },
      { object: { remove: null, add: 3 }, array: [4] }
    ),
    { object: { keep: 1, add: 3 }, array: [4] }
  );
});

test('resolves defaults, profile, package, environment, variant and variant environment in order', () => {
  const resolved = resolveDeploymentSpecV2(deployment(), config(), 'production', 'canary');
  assert.equal(resolved.id, 'api-canary');
  assert.equal(resolved.resources.requests.cpu, '200m');
  assert.equal(resolved.env.values.PROFILE_VALUE, 'profile');
  assert.equal(resolved.env.values.PACKAGE_VALUE, 'production');
  assert.equal(resolved.env.values.REMOVE_ME, undefined);
  assert.equal(resolved.labels.track, 'canary');
  assert.equal(resolved.scaling.maxReplicas, 3);
});

test('discovers enabled package deployment blocks and resolves one target per workload', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monox-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'apps', 'api'), { recursive: true });
  await mkdir(path.join(root, 'apps', 'disabled'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await writeFile(path.join(root, 'monox.config.json'), JSON.stringify(config()));
  await writeFile(
    path.join(root, 'apps', 'api', 'package.json'),
    JSON.stringify({ name: '@example/api', deployment: deployment() })
  );
  await writeFile(
    path.join(root, 'apps', 'disabled', 'package.json'),
    JSON.stringify({ name: '@example/disabled', deployment: deployment({ id: 'disabled', enabled: false }) })
  );

  const discovered = await discoverDeploymentWorkspaces(root);
  assert.deepEqual(
    discovered.deployments.map((item) => item.rawDeployment.id),
    ['api']
  );
  const resolved = await resolveProjectDeployments({ root, environment: 'production' });
  assert.equal(resolved.workloads.length, 2);
  assert.deepEqual(
    resolved.workloads.map((item) => item.deployment.id),
    ['api', 'api-canary']
  );
  assert(resolved.workloads.every((item) => item.target.id === 'production-kubernetes'));
});

test('fails closed when bindings overlap', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monox-config-overlap-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const overlapping = config();
  overlapping.environments.local.bindings.push({
    target: 'production-kubernetes',
    selector: { workloads: ['api'] },
  });
  await mkdir(path.join(root, 'apps', 'api'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
  await writeFile(path.join(root, 'monox.config.json'), JSON.stringify(overlapping));
  await writeFile(
    path.join(root, 'apps', 'api', 'package.json'),
    JSON.stringify({ name: '@example/api', deployment: deployment() })
  );
  await assert.rejects(() => resolveProjectDeployments({ root, environment: 'local' }), TargetBindingError);
});
