import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNoopCloudapter } from '../../cloudapter-core/src/index.mjs';
import { run } from '../src/index.mjs';

function output() {
  let value = '';
  return { stream: { write: (chunk) => (value += chunk) }, read: () => value };
}

function noExternalExecution() {
  return {
    resolveAdapter: (target) =>
      createNoopCloudapter({
        id: `noop-${target.runtime}`,
        reason: 'test adapter does not change external state',
      }),
  };
}

function projectConfig() {
  return {
    schemaVersion: '2',
    project: { name: 'example', workspaceGlobs: ['apps/*'], defaultEnvironment: 'local' },
    boundaries: { apps: [] },
    workloadProfiles: {},
    environments: {
      local: { bindings: [{ target: 'local-docker', selector: { workloads: ['*'] } }] },
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
        provisioner: 'none',
        transport: 'kubernetes-api',
        runtime: 'kubernetes',
        bindings: { identityRef: 'ci-identity' },
      },
    },
    addons: {},
  };
}

function packageManifest() {
  return {
    name: '@example/api',
    deployment: {
      schemaVersion: '2',
      enabled: true,
      id: 'api',
      kind: 'service',
      build: { strategy: 'dockerfile', context: '.', dockerfile: 'Dockerfile' },
      runtime: { language: 'typescript', command: ['node', 'dist/server.mjs'] },
      network: {
        exposure: 'internal',
        ports: [{ name: 'http', containerPort: 3000 }],
        routes: [],
      },
      probes: {
        readiness: { type: 'http', path: '/readyz', port: 'http' },
        liveness: { type: 'http', path: '/healthz', port: 'http' },
      },
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
        accelerators: [],
      },
      scaling: { mode: 'none', minReplicas: 1, maxReplicas: 1, metrics: [] },
      variants: {},
      environments: {},
    },
  };
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monox-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'apps', 'api'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
  await writeFile(path.join(root, 'monox.config.json'), JSON.stringify(projectConfig()));
  await writeFile(path.join(root, 'apps', 'api', 'package.json'), JSON.stringify(packageManifest()));
  return root;
}

test('validates and explains a v2 project', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const validation = await run(['validate'], { cwd: root, stdout: stdout.stream });
  assert.equal(validation.valid, true);
  assert.equal(validation.deployments, 1);
  const explanation = await run(['config', 'explain', '@example/api', '--env', 'local'], {
    cwd: root,
    stdout: stdout.stream,
  });
  assert.equal(explanation.workloads[0].deployment.id, 'api');
  assert.match(stdout.read(), /secure-defaults/);
});

test('plans and deploys through an explicitly injected safe no-op adapter', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const planFile = path.join(root, 'plan.json');
  const planned = await run(
    ['plan', '--env', 'local', '--all', '--output', planFile],
    { cwd: root, stdout: stdout.stream },
    noExternalExecution()
  );
  assert.equal(planned.plans.length, 1);
  const persisted = JSON.parse(await readFile(planFile, 'utf8'));
  assert.equal(persisted.kind, 'MonoXPlan');

  const deployed = await run(
    ['deploy', '--env', 'local', '--all'],
    { cwd: root, stdout: stdout.stream },
    noExternalExecution()
  );
  assert.equal(deployed.receipts[0].result.status, 'noop');
  assert.equal(deployed.receipts[0].result.changed, false);
  assert.match(deployed.receiptFiles[0], /^\.monox\/receipts\/local\/local-docker\//);
  assert.equal(
    JSON.parse(await readFile(path.join(root, deployed.receiptFiles[0]), 'utf8')).kind,
    'MonoXReceipt'
  );

  const applied = await run(
    ['apply', '--plan', planFile],
    { cwd: root, stdout: stdout.stream },
    noExternalExecution()
  );
  assert.equal(applied.receipt.result.changed, false);
  assert.match(applied.receiptFile, /^\.monox\/receipts\/local\/local-docker\//);
});

test('requires exact destructive confirmation and CI identity for production', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  await assert.rejects(
    () =>
      run(['destroy', '--env', 'local', '--target', 'local-docker', '--confirm', 'wrong'], {
        cwd: root,
        stdout: stdout.stream,
      }),
    /exactly equal example\/local\/local-docker/
  );
  await assert.rejects(
    () =>
      run(
        ['deploy', '--env', 'production', '--all'],
        { cwd: root, stdout: stdout.stream },
        noExternalExecution()
      ),
    /CI=true/
  );
  const deployed = await run(
    ['deploy', '--env', 'production', '--all'],
    { cwd: root, stdout: stdout.stream, env: { CI: 'true' } },
    noExternalExecution()
  );
  assert.equal(deployed.receipts[0].result.status, 'noop');
});

test('rejects stale plan apply after source configuration changes', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const planFile = path.join(root, 'plan.json');
  await run(
    ['plan', '--env', 'local', '--all', '--output', planFile],
    {
      cwd: root,
      stdout: stdout.stream,
    },
    noExternalExecution()
  );
  const manifest = packageManifest();
  manifest.deployment.labels = { revision: 'changed' };
  await writeFile(path.join(root, 'apps', 'api', 'package.json'), JSON.stringify(manifest));
  await assert.rejects(
    () => run(['apply', '--plan', planFile], { cwd: root, stdout: stdout.stream }, noExternalExecution()),
    /Plan is stale/
  );
});

test('rejects stale plan apply after application source changes', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const source = path.join(root, 'apps', 'api', 'server.mjs');
  const planFile = path.join(root, 'source-plan.json');
  await writeFile(source, "export const revision = 'one';\n");
  await run(
    ['plan', '--env', 'local', '--all', '--output', planFile],
    { cwd: root, stdout: stdout.stream },
    noExternalExecution()
  );
  await writeFile(source, "export const revision = 'two';\n");
  await assert.rejects(
    () => run(['apply', '--plan', planFile], { cwd: root, stdout: stdout.stream }, noExternalExecution()),
    /Plan is stale:[\s\S]*source digest changed/
  );
});

test('built-in local adapter receives the safe Compose executor without caller context wiring', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const executor = {
    status: async () => ({ status: 'stopped', changed: false }),
    execute: async (action) => ({
      operation: action.operation,
      healthy: action.operation === 'health-check' ? true : undefined,
    }),
    rollback: async () => ({ status: 'rolled-back', changed: true, ownedOnly: true }),
    destroy: async () => ({ status: 'destroyed', changed: true, ownedOnly: true }),
  };
  let factories = 0;
  const options = {
    resolveAffected: async () => ['@example/api'],
    createLocalComposeExecutor: ({ projectRoot }) => {
      factories += 1;
      assert.equal(projectRoot, root);
      return executor;
    },
  };
  const local = await run(
    ['plan', '--env', 'local', '--affected'],
    { cwd: root, stdout: stdout.stream },
    options
  );
  assert.equal(local.plans[0].adapter.id, 'local');
  const deployed = await run(
    ['deploy', '--env', 'local', '--all'],
    { cwd: root, stdout: stdout.stream },
    options
  );
  assert.equal(deployed.receipts[0].result.status, 'applied');
  assert.ok(factories >= 2);
});

test('selects PM2 before its SSH transport and rejects incomplete remote Docker composition', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const configFile = path.join(root, 'monox.config.json');
  const config = projectConfig();
  config.targets['local-docker'] = {
    provider: 'generic',
    provisioner: 'none',
    transport: 'ssh',
    runtime: 'pm2',
    serverRef: 'server-reference',
  };
  await writeFile(configFile, JSON.stringify(config));
  const pm2 = await run(['plan', '--env', 'local', '--all'], {
    cwd: root,
    stdout: stdout.stream,
  });
  assert.equal(pm2.plans[0].adapter.id, 'pm2');

  config.targets['local-docker'].runtime = 'docker';
  await writeFile(configFile, JSON.stringify(config));
  await assert.rejects(
    () => run(['plan', '--env', 'local', '--all'], { cwd: root, stdout: stdout.stream }),
    /No delivery adapter is available for target local-docker/
  );
});

test('fails before file or infrastructure changes when static delivery uses an unsupported provider', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const configFile = path.join(root, 'monox.config.json');
  const config = projectConfig();
  config.targets['local-docker'] = {
    provider: 'generic',
    provisioner: 'none',
    transport: 'local',
    runtime: 'static',
  };
  await writeFile(configFile, JSON.stringify(config));

  await assert.rejects(
    () => run(['plan', '--env', 'local', '--all'], { cwd: root, stdout: stdout.stream }),
    /Adapter static rejected the context:[\s\S]*target\.provider must be aws or gcp/
  );
});

test('renders named adapter artifacts without overwriting existing output', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const outputDirectory = path.join(root, 'rendered');
  const renderOptions = {
    resolveAdapter: (target) => {
      const adapter = createNoopCloudapter({ id: `render-${target.runtime}` });
      adapter.render = async (plan) => {
        return {
          planDigest: plan.digest,
          artifacts: [{ name: 'plan.json', content: '{"safe":true}\n' }],
        };
      };
      return adapter;
    },
  };

  await run(
    ['render', '--env', 'local', '--target', 'local-docker', '--all', '--output-dir', outputDirectory],
    { cwd: root, stdout: stdout.stream },
    renderOptions
  );
  assert.equal(await readFile(path.join(outputDirectory, 'plan.json'), 'utf8'), '{"safe":true}\n');
  await assert.rejects(
    () =>
      run(
        ['render', '--env', 'local', '--target', 'local-docker', '--all', '--output-dir', outputDirectory],
        { cwd: root, stdout: stdout.stream },
        renderOptions
      ),
    /EEXIST|already exists/i
  );
});

test('validates every rendered artifact before creating output', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const outputDirectory = path.join(root, 'invalid-render');
  const renderOptions = {
    resolveAdapter: () => {
      const adapter = createNoopCloudapter({ id: 'invalid-render' });
      adapter.render = async (plan) => ({
        planDigest: plan.digest,
        artifacts: [
          { name: 'valid.json', content: '{}\n' },
          { name: '../escape.json', content: '{}\n' },
        ],
      });
      return adapter;
    },
  };
  await assert.rejects(
    () =>
      run(
        ['render', '--env', 'local', '--target', 'local-docker', '--all', '--output-dir', outputDirectory],
        { cwd: root, stdout: stdout.stream },
        renderOptions
      ),
    /Artifact escapes output directory/
  );
  await assert.rejects(() => readFile(path.join(outputDirectory, 'valid.json'), 'utf8'), /ENOENT/);
});

test('refuses a second state-changing operation while the target lock is held', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  await mkdir(path.join(root, '.monox', 'locks', 'local--local-docker.lock'), { recursive: true });
  await assert.rejects(
    () =>
      run(['deploy', '--env', 'local', '--all'], { cwd: root, stdout: stdout.stream }, noExternalExecution()),
    /already holds the lock/
  );
});

test('validates cloud setup before any apply call', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  let applyCalls = 0;
  const adapter = createNoopCloudapter({ id: 'invalid-cloud' });
  adapter.validate = async () => ({ valid: false, errors: ['missing protected cloud binding'] });
  adapter.apply = async (...args) => {
    applyCalls += 1;
    return createNoopCloudapter().apply(...args);
  };
  await assert.rejects(
    () =>
      run(
        ['cloud', 'setup', '--env', 'local', '--target', 'local-docker'],
        { cwd: root, stdout: stdout.stream },
        { resolveAdapter: () => adapter }
      ),
    /missing protected cloud binding/
  );
  assert.equal(applyCalls, 0);
});

test('refuses multi-target deploy before planning or applying', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const config = projectConfig();
  config.targets['secondary-docker'] = {
    provider: 'generic',
    provisioner: 'none',
    transport: 'local',
    runtime: 'docker',
  };
  config.environments.local.bindings = [
    { target: 'local-docker', selector: { workloads: ['api'] } },
    { target: 'secondary-docker', selector: { workloads: ['worker'] } },
  ];
  await writeFile(path.join(root, 'monox.config.json'), JSON.stringify(config));
  const workerDirectory = path.join(root, 'apps', 'worker');
  const worker = packageManifest();
  worker.name = '@example/worker';
  worker.deployment.id = 'worker';
  await mkdir(workerDirectory, { recursive: true });
  await writeFile(path.join(workerDirectory, 'package.json'), JSON.stringify(worker));

  await assert.rejects(
    () =>
      run(['deploy', '--env', 'local', '--all'], { cwd: root, stdout: stdout.stream }, noExternalExecution()),
    /supports exactly one target per invocation/
  );
});

test('selected plans apply against the exact immutable workload set and cannot be overwritten', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const file = path.join(root, 'apps', 'api', 'package.json');
  const manifest = packageManifest();
  manifest.deployment.variants = { canary: { labels: { track: 'canary' } } };
  await writeFile(file, JSON.stringify(manifest));
  const planFile = path.join(root, 'selected-plan.json');
  await run(
    ['plan', '--env', 'local', '--select', 'api', '--output', planFile],
    { cwd: root, stdout: stdout.stream },
    noExternalExecution()
  );
  const applied = await run(
    ['apply', '--plan', planFile],
    { cwd: root, stdout: stdout.stream },
    noExternalExecution()
  );
  assert.equal(applied.receipt.result.changed, false);
  await assert.rejects(
    () =>
      run(
        ['plan', '--env', 'local', '--select', 'api', '--output', planFile],
        { cwd: root, stdout: stdout.stream },
        noExternalExecution()
      ),
    /EEXIST|file already exists/i
  );
});

test('migration commands emit reports and never overwrite their input', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const input = path.join(root, 'deployment-v1.json');
  const source = {
    schemaVersion: '1',
    name: 'legacy-api',
    namespace: 'example',
    image: { repository: 'registry.invalid/example/api', tag: '0.1.0' },
    container: { port: 3000, env: [{ name: 'NODE_ENV', value: 'production' }] },
    serviceAccount: { name: 'legacy-api' },
    service: { enabled: true, port: 80 },
    ingress: { enabled: false },
    probes: {
      startup: { path: '/healthz' },
      readiness: { path: '/readyz' },
      liveness: { path: '/healthz' },
    },
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    },
    autoscaling: { mode: 'hpa', minReplicas: 1, maxReplicas: 5, cpuUtilization: 70 },
  };
  await writeFile(input, JSON.stringify(source));
  const result = await run(['migrate', 'deployment', '--from', 'monox-v1', '--input', input], {
    cwd: root,
    stdout: stdout.stream,
  });
  assert.equal(result.report.output.schemaVersion, '2');
  assert.equal(result.report.manualReview.length, 0);
  assert.deepEqual(JSON.parse(await readFile(input, 'utf8')), source);
});

test('root migration inventories remain read-only and can redact public identifiers', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const before = await readFile(path.join(root, 'apps', 'api', 'package.json'), 'utf8');
  const result = await run(
    [
      'migrate',
      'deployment',
      '--from',
      'legacy-production',
      '--root',
      root,
      '--redact-identifiers',
      '--include-untracked',
    ],
    { cwd: root, stdout: stdout.stream }
  );
  assert.equal(result.report.kind, 'MonoXMigrationInventory');
  assert.equal(result.report.summary.deploymentBlocks, 1);
  assert.equal(result.report.root, '[REDACTED]');
  assert.equal(result.report.entries[0].file, 'workspace-001/package.json');
  assert.equal(result.report.entries[0].report.output.id, 'workload-001');
  assert.equal(await readFile(path.join(root, 'apps', 'api', 'package.json'), 'utf8'), before);
});

test('root migration write refuses all edits when security findings remain', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const file = path.join(root, 'apps', 'api', 'package.json');
  const manifest = packageManifest();
  manifest.deployment.password = 'unsafe-inline-value';
  await writeFile(file, JSON.stringify(manifest));
  const before = await readFile(file, 'utf8');
  await assert.rejects(
    () =>
      run(
        [
          'migrate',
          'deployment',
          '--from',
          'legacy-production',
          '--root',
          root,
          '--write',
          '--include-untracked',
        ],
        {
          cwd: root,
          stdout: stdout.stream,
        }
      ),
    /write refused/
  );
  assert.equal(await readFile(file, 'utf8'), before);
});

test('root migration inventories tracked package manifests only by default', async (context) => {
  const root = await fixture(context);
  const stdout = output();
  const repository = spawnSync('git', ['-C', root, 'init', '--quiet'], { encoding: 'utf8' });
  assert.equal(repository.status, 0, repository.stderr);
  const tracked = spawnSync(
    'git',
    ['-C', root, 'add', '--', 'package.json', 'monox.config.json', 'apps/api/package.json'],
    { encoding: 'utf8' }
  );
  assert.equal(tracked.status, 0, tracked.stderr);

  const untrackedDirectory = path.join(root, 'apps', 'untracked');
  await mkdir(untrackedDirectory, { recursive: true });
  const untrackedManifest = packageManifest();
  untrackedManifest.name = '@example/untracked';
  untrackedManifest.deployment.id = 'untracked';
  await writeFile(path.join(untrackedDirectory, 'package.json'), JSON.stringify(untrackedManifest));

  const result = await run(['migrate', 'deployment', '--from', 'legacy-production', '--root', root], {
    cwd: root,
    stdout: stdout.stream,
  });
  assert.equal(result.report.summary.deploymentBlocks, 1);
  assert.equal(result.report.summary.trackedOnly, true);
  assert.deepEqual(
    result.report.entries.map((entry) => entry.file),
    ['apps/api/package.json']
  );
});
