import assert from 'node:assert/strict';
import test from 'node:test';

import { createDockerCloudapter, renderDockerCompose } from '../src/index.mjs';

function workload(id = 'api') {
  return {
    deployment: {
      schemaVersion: '2',
      enabled: true,
      id,
      kind: 'service',
      build: {
        strategy: 'dockerfile',
        dockerfile: 'Dockerfile',
        image: { repository: `registry.invalid/example/${id}`, tag: '0.2.0' },
      },
      runtime: { language: 'javascript', command: ['node', 'server.mjs'], workingDirectory: '/app' },
      network: { exposure: 'internal', ports: [{ name: 'http', containerPort: 3000 }], routes: [] },
      probes: {
        readiness: {
          type: 'exec',
          command: ['node', '-e', 'fetch("http://127.0.0.1:3000/healthz").then(r=>process.exit(r.ok?0:1))'],
          delaySeconds: 5,
        },
        liveness: { type: 'tcp', port: 'http' },
      },
      env: {
        values: { NODE_ENV: 'production', LITERAL: '$unchanged' },
        secretRefs: [{ name: 'app-secret', target: 'APP_SECRET' }],
      },
      storage: [{ name: 'state', type: 'persistent', size: '1Gi', mountPath: '/data' }],
    },
  };
}

function context() {
  return {
    config: { project: { name: 'example' } },
    environment: 'preview',
    target: { id: 'remote', runtime: 'docker', transport: 'ssh', provider: 'generic', provisioner: 'none' },
    sourceDigest: 'sha256:source',
    targetStateDigest: 'sha256:state',
    workloads: [workload()],
  };
}

test('renders deterministic Compose with real probes, immutable images and persisted storage', () => {
  const input = workload();
  const compose = renderDockerCompose([input], { name: 'example-preview' });
  assert.deepEqual(compose, renderDockerCompose([input], { name: 'example-preview' }));
  const api = compose.services.api;
  assert.equal(api.image, 'registry.invalid/example/api:0.2.0');
  assert.equal(api.working_dir, '/app');
  assert.equal(api.environment.APP_SECRET, '${APP_SECRET:?required}');
  assert.equal(api.environment.LITERAL, '$$unchanged');
  assert.equal(api.ports, undefined);
  assert.deepEqual(api.expose, ['3000']);
  assert.equal(api.healthcheck.test[0], 'CMD');
  assert.equal(api.healthcheck.start_period, '5s');
  assert.equal(api.mem_limit, '536870912');
  assert.equal(api.cpus, 0.5);
  assert.deepEqual(compose.volumes, { 'api-state': {} });
  assert.deepEqual(api.volumes, [{ type: 'volume', source: 'api-state', target: '/data', read_only: false }]);
  assert.equal(input.deployment.env.values.LITERAL, '$unchanged');
});

test('read-only existing file bindings never include secret values or create missing directories', () => {
  const input = workload('gateway');
  input.deployment.storage = [
    {
      name: 'auth',
      type: 'secret',
      sourceRef: 'gateway-auth',
      mountPath: '/etc/gateway/auth',
      readOnly: true,
    },
    { name: 'config', type: 'config', sourceRef: 'gateway-config', mountPath: '/etc/gateway/config' },
    { name: 'scratch', type: 'ephemeral', mountPath: '/tmp' },
  ];
  const service = renderDockerCompose([input]).services.gateway;
  assert.deepEqual(service.volumes[0], {
    type: 'bind',
    source: '${MONOX_FILE_GATEWAY_AUTH:?required}',
    target: '/etc/gateway/auth',
    read_only: true,
    bind: { create_host_path: false },
  });
  assert.equal(service.volumes[1].source, '${MONOX_FILE_GATEWAY_CONFIG:?required}');
  assert.deepEqual(service.tmpfs, ['/tmp']);
  input.deployment.storage[0].readOnly = false;
  assert.throws(() => renderDockerCompose([input]), /must be read-only/);
});

test('external persistent volumes remain externally owned and service-local names avoid collisions', () => {
  const api = workload(),
    jobs = workload('jobs');
  jobs.deployment.storage[0].sourceRef = 'existing-state';
  const compose = renderDockerCompose([jobs, api]);
  assert.deepEqual(Object.keys(compose.services), ['api', 'jobs']);
  assert.deepEqual(compose.volumes, {
    'api-state': {},
    'jobs-state': { external: true, name: 'existing-state' },
  });
});

test('Coolify routing is optional and never assigns the target domain to an internal workload', () => {
  const api = workload(),
    gateway = workload('gateway');
  gateway.deployment.network.exposure = 'public';
  const compose = renderDockerCompose([api, gateway], { mode: 'coolify', domain: 'app.example.invalid' });
  assert.equal(compose.services.api.labels['coolify.managed'], 'true');
  assert.equal(compose.services.api.labels['coolify.domain'], undefined);
  assert.equal(compose.services.gateway.labels['coolify.domain'], 'app.example.invalid');
  assert.equal(
    renderDockerCompose([gateway], { mode: 'coolify' }).services.gateway.labels['coolify.domain'],
    undefined
  );
  assert.equal(renderDockerCompose([gateway]).services.gateway.labels, undefined);
});

test('renders an explicitly generic container gateway without claiming an application language', () => {
  const gateway = workload('gateway');
  gateway.deployment.build = { strategy: 'none', image: { repository: 'nginx', tag: '1.28-alpine' } };
  gateway.deployment.runtime = { language: 'container', command: ['nginx', '-g', 'daemon off;'] };
  gateway.deployment.network.ports = [{ name: 'http', containerPort: 80 }];
  gateway.deployment.probes.readiness = { type: 'http', path: '/healthz', port: 'http' };
  const service = renderDockerCompose([gateway], { mode: 'coolify' }).services.gateway;
  assert.equal(service.image, 'nginx:1.28-alpine');
  assert.deepEqual(service.command, ['nginx', '-g', 'daemon off;']);
  assert.deepEqual(service.expose, ['80']);
  assert.equal(service.healthcheck.test.at(-1), 'http://127.0.0.1:80/healthz');
});

test('digest images, named probe ports and optional references retain their intended meanings', () => {
  const input = workload();
  input.deployment.build.image = {
    repository: 'registry.invalid/example/api',
    digest: `sha256:${'a'.repeat(64)}`,
  };
  input.deployment.probes.readiness = { type: 'http', path: '/ready', port: 'http' };
  input.deployment.env.secretRefs[0].optional = true;
  const service = renderDockerCompose([input]).services.api;
  assert.equal(service.image, `registry.invalid/example/api@sha256:${'a'.repeat(64)}`);
  assert.equal(service.healthcheck.test.at(-1), 'http://127.0.0.1:3000/ready');
  assert.equal(service.environment.APP_SECRET, '${APP_SECRET:-}');
});

test('unsupported or ambiguous deployment intents fail rather than being silently discarded', () => {
  const mutations = [
    (value) => {
      delete value.build.image;
    },
    (value) => {
      value.build.image.tag = 'latest';
    },
    (value) => {
      value.storage[0].className = 'fast';
    },
    (value) => {
      value.storage.push({ name: 'duplicate', type: 'ephemeral', mountPath: '/data' });
    },
    (value) => {
      value.scaling = { mode: 'none', minReplicas: 2, maxReplicas: 2 };
    },
    (value) => {
      value.runtime.cron = '* * * * *';
    },
    (value) => {
      value.suspended = true;
    },
    (value) => {
      value.env.secretRefs[0].target = 'BAD:-injected';
    },
  ];
  for (const mutate of mutations) {
    const input = workload();
    mutate(input.deployment);
    assert.throws(() => renderDockerCompose([input]), TypeError);
  }
  assert.throws(() => renderDockerCompose([workload(), workload()]), /Duplicate Compose/);
  assert.throws(() => renderDockerCompose([workload()], { mode: 'unknown' }), /mode/);
  assert.throws(() => renderDockerCompose([workload()], { name: '../escape' }), /project name/);
});

test('generic Docker plans render without host access, and apply fails without an executor', async () => {
  const adapter = createDockerCloudapter(),
    input = context();
  const plan = await adapter.plan(input);
  const output = await adapter.render(plan);
  assert.equal(
    JSON.parse(output.artifacts[0].content).services.api.environment.APP_SECRET,
    '${APP_SECRET:?required}'
  );
  assert.equal(
    JSON.parse(output.artifacts[0].content).services.api.image,
    'registry.invalid/example/api:0.2.0'
  );
  assert.equal(output.artifacts[0].name, 'docker-compose.json');
  assert.equal((await adapter.status(input)).status, 'plan-only');
  await assert.rejects(() => adapter.apply(plan, input), /no apply executor/);
  await assert.rejects(() => adapter.apply(plan, { ...input, sourceDigest: 'changed' }), /stale/i);
  await assert.rejects(() => adapter.destroy({}, input), /no destroy executor/);
});
