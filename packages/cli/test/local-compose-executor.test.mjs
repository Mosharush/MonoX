import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createLocalCloudapter } from '../../cloudapter-local/src/index.mjs';
import { createLocalComposeExecutor } from '../src/local-compose-executor.mjs';

function deployment(probe = { type: 'http', path: '/readyz', port: 'http' }) {
  return {
    schemaVersion: '2',
    enabled: true,
    id: 'api',
    kind: 'service',
    build: { strategy: 'none' },
    runtime: { language: 'typescript', command: ['node', 'server.mjs'] },
    network: {
      exposure: 'internal',
      ports: [{ name: 'http', containerPort: 3000, servicePort: 80 }],
      routes: [],
    },
    probes: { readiness: probe, liveness: { type: 'tcp', port: 'http' } },
  };
}

function adapterContext(probe) {
  return {
    projectRoot: '/project',
    config: { project: { name: 'example' } },
    environment: 'development',
    target: {
      id: 'local-docker',
      provider: 'generic',
      provisioner: 'none',
      transport: 'local',
      runtime: 'docker',
    },
    workloads: [{ deployment: deployment(probe) }],
    sourceDigest: 'sha256:source',
    targetStateDigest: 'sha256:state',
  };
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monox-compose-executor-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'infra', 'local'), { recursive: true });
  await writeFile(
    path.join(root, 'infra', 'local', 'docker-compose.yml'),
    'services:\n  api:\n    image: example.invalid/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
  );
  return root;
}

function spawnHarness(responses) {
  const queue = [...responses];
  const calls = [];
  const spawn = (executable, args, options) => {
    const response = queue.shift();
    if (!response) throw new Error(`Unexpected spawn: ${executable} ${args.join(' ')}`);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      calls.at(-1).killedWith = signal;
    };
    calls.push({ executable, args, options, killedWith: undefined });
    queueMicrotask(() => {
      if (response.error) {
        child.emit('error', response.error);
        return;
      }
      if (response.stdout) child.stdout.write(response.stdout);
      if (response.stderr) child.stderr.write(response.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', response.code ?? 0, response.signal ?? null);
    });
    return child;
  };
  return { spawn, calls, remaining: () => queue.length };
}

test('applies only planned argv actions and gates readiness without a shell', async (context) => {
  const root = await fixture(context);
  const processes = spawnHarness([{ stdout: 'api\n' }, {}]);
  const probeResults = [false, true];
  let sleeps = 0;
  const executor = createLocalComposeExecutor({
    projectRoot: root,
    spawn: processes.spawn,
    probeHttp: async ({ port, path: pathname, timeoutMs }) => {
      assert.equal(port, 3000);
      assert.equal(pathname, '/readyz');
      assert.equal(timeoutMs, 5000);
      return probeResults.shift();
    },
    sleep: async () => {
      sleeps += 1;
    },
  });
  const adapter = createLocalCloudapter();
  const input = adapterContext({
    type: 'http',
    path: '/readyz',
    port: 'http',
    failureThreshold: 3,
  });
  input.projectRoot = root;
  input.local = executor;
  const plan = await adapter.plan(input);

  assert.equal(plan.actions[1].args.includes('--remove-orphans'), false);
  const receipt = await adapter.apply(plan, input);
  assert.equal(receipt.result.status, 'applied');
  assert.equal(receipt.result.actions.at(-1).healthy, true);
  assert.equal(sleeps, 1);
  assert.deepEqual(
    processes.calls.map((call) => call.args),
    [
      [
        'compose',
        '--project-name',
        'example-development',
        '-f',
        'infra/local/docker-compose.yml',
        'config',
        '--services',
      ],
      [
        'compose',
        '--project-name',
        'example-development',
        '-f',
        'infra/local/docker-compose.yml',
        'up',
        '--detach',
        'api',
      ],
    ]
  );
  assert.ok(processes.calls.every((call) => call.options.shell === false));
});

test('supports TCP and exec readiness probes with injected probe and spawn functions', async (context) => {
  const root = await fixture(context);
  const tcpPlan = await createLocalCloudapter().plan(
    adapterContext({ type: 'tcp', port: 'http', failureThreshold: 1 })
  );
  let tcpRequests = 0;
  const tcpExecutor = createLocalComposeExecutor({
    projectRoot: root,
    spawn: spawnHarness([]).spawn,
    probeTcp: async ({ port, timeoutMs }) => {
      tcpRequests += 1;
      assert.equal(port, 3000);
      assert.equal(timeoutMs, 5000);
      return true;
    },
  });
  const tcpAction = tcpPlan.actions.find((action) => action.operation === 'health-check');
  assert.equal((await tcpExecutor.execute(tcpAction, { plan: tcpPlan })).healthy, true);
  assert.equal(tcpRequests, 1);

  const execPlan = await createLocalCloudapter().plan(
    adapterContext({ type: 'exec', command: ['node', '--version'], failureThreshold: 1 })
  );
  const processes = spawnHarness([{}]);
  const execExecutor = createLocalComposeExecutor({ projectRoot: root, spawn: processes.spawn });
  const execAction = execPlan.actions.find((action) => action.operation === 'health-check');
  assert.equal((await execExecutor.execute(execAction, { plan: execPlan })).healthy, true);
  assert.deepEqual(processes.calls[0].args, [
    'compose',
    '--project-name',
    'example-development',
    '-f',
    'infra/local/docker-compose.yml',
    'exec',
    '--no-TTY',
    'api',
    'node',
    '--version',
  ]);
  assert.equal(processes.calls[0].options.shell, false);
});

test('bounds failed readiness retries and rejects actions absent from the signed plan', async (context) => {
  const root = await fixture(context);
  const plan = await createLocalCloudapter().plan(
    adapterContext({
      type: 'http',
      path: '/readyz',
      port: 3000,
      failureThreshold: 1000,
      periodSeconds: 3600,
      timeoutSeconds: 3600,
    })
  );
  let attempts = 0;
  let sleeps = 0;
  const executor = createLocalComposeExecutor({
    projectRoot: root,
    spawn: spawnHarness([]).spawn,
    probeHttp: async () => {
      attempts += 1;
      return false;
    },
    sleep: async (milliseconds) => {
      sleeps += 1;
      assert.equal(milliseconds, 30_000);
    },
    clock: () => 0,
  });
  const probe = plan.actions.find((action) => action.operation === 'health-check');
  const result = await executor.execute(probe, { plan });
  assert.equal(result.healthy, false);
  assert.equal(attempts, 60);
  assert.equal(sleeps, 59);
  await assert.rejects(
    () => executor.execute({ ...probe, workload: 'other' }, { plan }),
    /not present in the plan/
  );
});

test('status, rollback and destroy operate on exact owned services without deleting data', async (context) => {
  const root = await fixture(context);
  const plan = await createLocalCloudapter().plan(adapterContext());
  const processes = spawnHarness([
    { stdout: '{"Service":"api","State":"running","Health":"healthy"}\n' },
    {},
    {},
  ]);
  const executor = createLocalComposeExecutor({ projectRoot: root, spawn: processes.spawn });
  const status = await executor.status({ workloads: plan.workloads, target: plan.target });
  assert.equal(status.status, 'running');
  assert.deepEqual(status.workloads, [{ service: 'api', state: 'running', health: 'healthy' }]);

  const rollback = await executor.rollback({ plan, ownedOnly: true });
  assert.equal(rollback.ownedOnly, true);
  const destroyed = await executor.destroy({ plan, ownedOnly: true });
  assert.equal(destroyed.persistentDataRemoved, false);
  assert.deepEqual(processes.calls[1].args, [
    'compose',
    '--project-name',
    'example-development',
    '-f',
    'infra/local/docker-compose.yml',
    'stop',
    '--timeout',
    '10',
    'api',
  ]);
  assert.deepEqual(processes.calls[2].args, [
    'compose',
    '--project-name',
    'example-development',
    '-f',
    'infra/local/docker-compose.yml',
    'rm',
    '--force',
    '--stop',
    'api',
  ]);
  const allArguments = processes.calls.flatMap((call) => call.args);
  assert.equal(allArguments.includes('down'), false);
  assert.equal(allArguments.includes('--volumes'), false);
  assert.equal(allArguments.includes('--remove-orphans'), false);
});

test('includes configured local add-ons as explicit owned services and fails if their file is absent', async (context) => {
  const root = await fixture(context);
  const input = adapterContext();
  input.config.addons = {
    redis: {
      recipe: 'redis',
      enabled: true,
      mode: 'bundled',
      environments: ['development'],
    },
  };
  const plan = await createLocalCloudapter().plan(input);
  const missingExecutor = createLocalComposeExecutor({
    projectRoot: root,
    spawn: spawnHarness([]).spawn,
  });
  await assert.rejects(
    () => missingExecutor.execute(plan.actions[0], { plan }),
    /infra\/docker\/addons\.compose\.yaml/
  );

  await mkdir(path.join(root, 'infra', 'docker'), { recursive: true });
  await writeFile(
    path.join(root, 'infra', 'docker', 'addons.compose.yaml'),
    'services:\n  redis:\n    image: example.invalid/redis@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
  );
  const processes = spawnHarness([{ stdout: 'api\nredis\n' }, {}]);
  const executor = createLocalComposeExecutor({ projectRoot: root, spawn: processes.spawn });
  await executor.execute(plan.actions[0], { plan });
  await executor.execute(plan.actions[1], { plan });
  assert.deepEqual(processes.calls[1].args, [
    'compose',
    '--project-name',
    'example-development',
    '-f',
    'infra/local/docker-compose.yml',
    '-f',
    'infra/docker/addons.compose.yaml',
    'up',
    '--detach',
    'api',
    'redis',
  ]);
});

test('refuses missing or symlinked Compose files before spawning Docker', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monox-compose-missing-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const processes = spawnHarness([]);
  const executor = createLocalComposeExecutor({ projectRoot: root, spawn: processes.spawn });
  const plan = await createLocalCloudapter().plan(adapterContext());
  await assert.rejects(
    () => executor.execute(plan.actions[0], { plan }),
    /Compose file is missing or unsafe/
  );
  assert.equal(processes.calls.length, 0);
});
