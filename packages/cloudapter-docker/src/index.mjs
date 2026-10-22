import {
  PlanOnlyCloudapter,
  assertCloudapter,
  assertFreshPlan,
  createPlan,
  deterministicDigest,
} from '@monox/cloudapter-core';
import { assertValidDeploymentSpecV2 } from '@monox/deploy-schema';

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const composeName = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const literal = (value) => String(value).replaceAll('$', () => '$$');
const ordered = (value) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

function imageReference(deployment) {
  const image = deployment.build.image;
  if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*$/.test(image.repository))
    throw new TypeError(`${deployment.id} requires an immutable image for Docker Compose`);
  if (image.digest) return `${image.repository}@${image.digest}`;
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(image.tag) || image.tag.toLowerCase() === 'latest')
    throw new TypeError(`${deployment.id} requires an immutable image tag or digest`);
  return `${image.repository}:${image.tag}`;
}

function environment(deployment) {
  const values = Object.fromEntries(
    Object.entries(deployment.env.values).map(([key, value]) => [key, literal(value)])
  );
  for (const reference of deployment.env.secretRefs) {
    const name = reference.target ?? reference.name.replaceAll('-', '_').toUpperCase();
    if (!envName.test(name))
      throw new TypeError(`${deployment.id}: invalid secret environment target ${name}`);
    if (Object.hasOwn(values, name))
      throw new TypeError(`${deployment.id}: duplicate environment target ${name}`);
    values[name] = reference.optional ? `\${${name}:-}` : `\${${name}:?required}`;
  }
  return ordered(values);
}

function healthcheck(deployment) {
  const probe = deployment.probes.readiness ?? deployment.probes.liveness;
  if (!probe) return undefined;
  let test;
  if (probe.type === 'exec') test = ['CMD', ...probe.command.map(literal)];
  else {
    const port =
      typeof probe.port === 'string'
        ? deployment.network.ports.find((item) => item.name === probe.port)?.containerPort
        : (probe.port ?? deployment.network.ports[0]?.containerPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new TypeError(`${deployment.id}: healthcheck port cannot be resolved`);
    test =
      probe.type === 'tcp'
        ? ['CMD', 'nc', '-z', '127.0.0.1', String(port)]
        : [
            'CMD',
            'wget',
            '--no-verbose',
            '--tries=1',
            '--spider',
            literal(`http://127.0.0.1:${port}${probe.path}`),
          ];
  }
  return {
    test,
    interval: `${probe.periodSeconds ?? 10}s`,
    timeout: `${probe.timeoutSeconds ?? 3}s`,
    retries: probe.failureThreshold ?? 3,
    start_period: `${probe.delaySeconds ?? 0}s`,
  };
}

function memoryBytes(value) {
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  const unit = value.slice(-2);
  const bytes = units[unit] ? Number(value.slice(0, -2)) * units[unit] : Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new TypeError('Docker memory must resolve to positive whole bytes');
  return String(bytes);
}

function cpuCount(value) {
  const result = value.endsWith('m') ? Number(value.slice(0, -1)) / 1000 : Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new TypeError('Docker CPU limit must be positive');
  return result;
}

function storage(deployment, namedVolumes) {
  const mounts = [],
    tmpfs = [],
    paths = new Set();
  for (const volume of deployment.storage) {
    if (paths.has(volume.mountPath)) throw new TypeError(`${deployment.id}: duplicate storage mount path`);
    paths.add(volume.mountPath);
    if (volume.type === 'ephemeral') {
      if (volume.readOnly)
        throw new TypeError(`${deployment.id}: read-only ephemeral storage is unsupported`);
      tmpfs.push(literal(volume.mountPath));
    } else if (volume.type === 'persistent') {
      if (volume.className)
        throw new TypeError(`${deployment.id}: Docker Compose does not resolve storage classes`);
      const name = `${deployment.id}-${volume.name}`;
      namedVolumes[name] = volume.sourceRef ? { external: true, name: volume.sourceRef } : {};
      mounts.push({
        type: 'volume',
        source: name,
        target: literal(volume.mountPath),
        read_only: volume.readOnly ?? false,
      });
    } else {
      if (volume.readOnly === false)
        throw new TypeError(`${deployment.id}: config and secret file mounts must be read-only`);
      const reference = `MONOX_FILE_${volume.sourceRef.replaceAll('-', '_').toUpperCase()}`;
      if (!envName.test(reference)) throw new TypeError(`${deployment.id}: invalid file reference`);
      mounts.push({
        type: 'bind',
        source: `\${${reference}:?required}`,
        target: literal(volume.mountPath),
        read_only: true,
        bind: { create_host_path: false },
      });
    }
  }
  return {
    ...(mounts.length ? { volumes: mounts.sort((a, b) => a.target.localeCompare(b.target)) } : {}),
    ...(tmpfs.length ? { tmpfs: tmpfs.sort() } : {}),
  };
}

/** Pure rendering. Input paths and secret values are never read from the host or process environment. */
export function renderDockerCompose(workloads, { name = 'monox', mode = 'docker', domain } = {}) {
  if (!composeName.test(name))
    throw new TypeError('Compose project name must use lowercase letters, digits, hyphens or underscores');
  if (!['docker', 'coolify'].includes(mode)) throw new TypeError('Compose mode must be docker or coolify');
  if (!Array.isArray(workloads) || workloads.length === 0)
    throw new TypeError('Docker Compose requires selected workloads');
  const deployments = workloads
    .map((workload) => assertValidDeploymentSpecV2(workload.deployment ?? workload))
    .sort((a, b) => a.id.localeCompare(b.id));
  const services = {},
    volumes = {};
  for (const deployment of deployments) {
    if (!deployment.enabled || deployment.suspended)
      throw new TypeError(`${deployment.id}: disabled or suspended workloads cannot be rendered for startup`);
    if (Object.hasOwn(services, deployment.id))
      throw new TypeError(`Duplicate Compose service ${deployment.id}`);
    if (
      deployment.scaling.mode !== 'none' ||
      deployment.scaling.minReplicas !== 1 ||
      deployment.scaling.maxReplicas !== 1
    )
      throw new TypeError(`${deployment.id}: this Compose renderer supports one fixed replica only`);
    if (deployment.resources.accelerators.length)
      throw new TypeError(`${deployment.id}: accelerator allocation requires a separate adapter`);
    if (deployment.runtime.cron || deployment.lifecycle.preStopCommand.length)
      throw new TypeError(`${deployment.id}: cron and pre-stop hooks require a separate runtime adapter`);
    const route =
      deployment.network.exposure === 'public'
        ? (deployment.adapterOverrides.coolify?.domain ?? deployment.network.routes[0]?.host ?? domain)
        : undefined;
    const labels = ordered({
      ...deployment.labels,
      ...(mode === 'coolify'
        ? { 'coolify.managed': 'true', ...(route ? { 'coolify.domain': route } : {}) }
        : {}),
    });
    services[deployment.id] = {
      image: imageReference(deployment),
      command: deployment.runtime.command.map(literal),
      ...(deployment.runtime.workingDirectory
        ? { working_dir: literal(deployment.runtime.workingDirectory) }
        : {}),
      init: true,
      restart: 'unless-stopped',
      environment: environment(deployment),
      expose: deployment.network.ports.map(
        (port) => `${port.containerPort}${port.protocol === 'UDP' ? '/udp' : ''}`
      ),
      healthcheck: healthcheck(deployment),
      cpus: cpuCount(deployment.resources.limits.cpu),
      mem_limit: memoryBytes(deployment.resources.limits.memory),
      mem_reservation: memoryBytes(deployment.resources.requests.memory),
      stop_grace_period: `${deployment.lifecycle.terminationGracePeriodSeconds}s`,
      ...storage(deployment, volumes),
      ...(Object.keys(labels).length
        ? { labels: Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, literal(value)])) }
        : {}),
    };
  }
  return { name, services, ...(Object.keys(volumes).length ? { volumes: ordered(volumes) } : {}) };
}

const stateDigest = (context) =>
  context.targetStateDigest ?? deterministicDigest({ target: context.target?.id, state: 'docker-unread' });

/** Generic remote Docker planning does not infer an SSH session, a Docker context or an executor. */
export class DockerCloudapter extends PlanOnlyCloudapter {
  constructor({ executor } = {}) {
    super({
      id: 'docker',
      version: '0.2.0',
      capabilities: ['plan', 'render', 'docker-compose', 'status'],
      executor,
    });
  }

  async validate(context) {
    const errors = [];
    if (context.target?.runtime !== 'docker') errors.push('target.runtime must be docker');
    try {
      renderDockerCompose(context.workloads, {
        name: `${context.config?.project?.name ?? 'monox'}-${context.environment}`,
      });
    } catch (error) {
      errors.push(error.message);
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings: ['Compose rendering only; remote execution requires an explicitly injected executor.'],
    };
  }

  async plan(context) {
    const validation = await this.validate(context);
    if (!validation.valid)
      throw new TypeError(`Docker plan is invalid:\n- ${validation.errors.join('\n- ')}`);
    const compose = renderDockerCompose(context.workloads, {
      name: `${context.config?.project?.name ?? 'monox'}-${context.environment}`,
    });
    return createPlan({
      adapter: this,
      project: context.config?.project,
      environment: context.environment,
      target: context.target,
      workloads: context.workloads,
      actions: [
        { operation: 'render-compose', name: compose.name, composeDigest: deterministicDigest(compose) },
      ],
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
      metadata: { executionConfigured: Boolean(this.executor), publishedPorts: false, volumesRemoved: false },
    });
  }

  async render(plan) {
    // Reconstruct from the plan's declarative secret references, never from redacted env values.
    const compose = renderDockerCompose(plan.workloads, { name: plan.actions[0].name });
    if (deterministicDigest(compose) !== plan.actions[0].composeDigest)
      throw new TypeError('Docker Compose artifact does not match the planned content');
    const content = `${JSON.stringify(compose, null, 2)}\n`;
    return {
      planDigest: plan.digest,
      artifacts: [
        {
          name: 'docker-compose.json',
          mediaType: 'application/json',
          digest: deterministicDigest({ content }),
          content,
        },
      ],
      warnings: [
        'Image builds, host port publication and external file provisioning remain explicit operator steps. Persistent volume size is not a Docker disk quota.',
      ],
    };
  }

  async apply(plan, context) {
    assertFreshPlan(plan, {
      adapter: this,
      sourceDigest: context.sourceDigest,
      targetStateDigest: stateDigest(context),
    });
    return super.apply(plan, context);
  }
}

export function createDockerCloudapter(options) {
  return assertCloudapter(new DockerCloudapter(options));
}
