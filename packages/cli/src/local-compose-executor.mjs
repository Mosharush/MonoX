import { spawn as spawnProcess } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const COMPOSE_FILE = 'infra/local/docker-compose.yml';
const ADDON_COMPOSE_FILE = 'infra/docker/addons.compose.yaml';
const allowedComposeFiles = new Set([COMPOSE_FILE, ADDON_COMPOSE_FILE]);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROBE_ATTEMPTS = 60;
const MAX_PROBE_DELAY_MS = 30_000;
const MAX_PROBE_INTERVAL_MS = 30_000;
const MAX_PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_WINDOW_MS = 120_000;
const serviceNamePattern = /^[a-z][a-z0-9_.-]{0,127}$/;
const projectNamePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function boundedInteger(value, fallback, minimum, maximum) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, minimum), maximum);
}

function serviceNames(plan) {
  const workloadNames = (plan?.workloads ?? []).map((workload) => workload.deployment?.id);
  const names = [...(plan?.metadata?.ownedComposeServices ?? workloadNames)].sort();
  if (names.length === 0) throw new TypeError('A local Compose plan must own at least one workload');
  if (new Set(names).size !== names.length) throw new TypeError('Local Compose workload ids must be unique');
  for (const name of names) {
    if (typeof name !== 'string' || !serviceNamePattern.test(name))
      throw new TypeError(`Invalid local Compose service name: ${String(name)}`);
  }
  for (const workload of workloadNames) {
    if (!names.includes(workload))
      throw new TypeError(`Local Compose plan does not own workload service: ${String(workload)}`);
  }
  return names;
}

function composeFilesForPlan(plan) {
  const files = plan?.metadata?.composeFiles ?? [COMPOSE_FILE];
  if (!Array.isArray(files) || files.length === 0 || files[0] !== COMPOSE_FILE)
    throw new TypeError(`Local Compose plans must start with ${COMPOSE_FILE}`);
  if (new Set(files).size !== files.length || files.some((file) => !allowedComposeFiles.has(file)))
    throw new TypeError('Local Compose plan contains an unsupported Compose file');
  return files;
}

function composeProjectNameForPlan(plan) {
  const value = plan?.metadata?.composeProjectName;
  if (typeof value !== 'string' || !projectNamePattern.test(value))
    throw new TypeError('Local Compose plan contains an invalid project name');
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertPlannedAction(action, plan) {
  if (plan?.kind !== 'MonoXPlan' || !Array.isArray(plan.actions))
    throw new TypeError('Local execution requires a MonoXPlan');
  if (!plan.actions.some((candidate) => sameJson(candidate, action)))
    throw new TypeError('Refusing to execute an action that is not present in the plan');
}

function expectedComposePrefix(plan) {
  return [
    'compose',
    '--project-name',
    composeProjectNameForPlan(plan),
    ...composeFilesForPlan(plan).flatMap((file) => ['-f', file]),
  ];
}

function expectedActionArguments(action, ownedServices, plan) {
  if (action.operation === 'validate-compose')
    return [...expectedComposePrefix(plan), 'config', '--services'];
  if (action.operation === 'start-compose')
    return [...expectedComposePrefix(plan), 'up', '--detach', ...ownedServices];
  return undefined;
}

function assertAllowlistedComposeAction(action, plan) {
  assertPlannedAction(action, plan);
  const ownedServices = serviceNames(plan);
  const expected = expectedActionArguments(action, ownedServices, plan);
  if (!expected) {
    if (action.operation === 'health-check') {
      if (!ownedServices.includes(action.workload))
        throw new TypeError(`Probe workload is not owned by this plan: ${action.workload}`);
      if (!['http', 'tcp', 'exec'].includes(action.probe?.type))
        throw new TypeError(`Unsupported local readiness probe for ${action.workload}`);
      return ownedServices;
    }
    throw new TypeError(`Local Compose operation is not allowlisted: ${String(action.operation)}`);
  }
  if (action.executable !== 'docker' || !sameJson(action.args, expected))
    throw new TypeError(`Local Compose ${action.operation} arguments do not match the safe plan contract`);
  return ownedServices;
}

function createProcessRunner({ spawn = spawnProcess, clock = () => Date.now() } = {}) {
  return async function runProcess(executable, args, options = {}) {
    if (executable !== 'docker') throw new TypeError(`Executable is not allowlisted: ${executable}`);
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string'))
      throw new TypeError('Process arguments must be a string array');
    const timeoutMs = boundedInteger(options.timeoutMs, 120_000, 1, 300_000);
    const startedAt = clock();
    return new Promise((resolve, reject) => {
      let child;
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback(value);
      };

      try {
        child = spawn(executable, args, {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish(reject, new Error('Could not start Docker', { cause: error }));
        return;
      }

      const collect = (target) => (chunk) => {
        const current = target === 'stdout' ? stdout : stderr;
        const next = `${current}${String(chunk)}`;
        if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
          child.kill('SIGTERM');
          finish(reject, new Error('Docker output exceeded the safe one MiB limit'));
          return;
        }
        if (target === 'stdout') stdout = next;
        else stderr = next;
      };
      child.stdout?.on('data', collect('stdout'));
      child.stderr?.on('data', collect('stderr'));
      child.once('error', (error) =>
        finish(reject, new Error('Docker process failed to start', { cause: error }))
      );
      child.once('close', (code, signal) => {
        const result = {
          code: Number.isInteger(code) ? code : null,
          signal: signal ?? null,
          stdout,
          stderr,
          durationMs: Math.max(0, clock() - startedAt),
        };
        if (code === 0) finish(resolve, result);
        else
          finish(
            reject,
            Object.assign(new Error(`Docker exited unsuccessfully (${code ?? signal ?? 'unknown'})`), {
              result,
            })
          );
      });
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(reject, new Error(`Docker exceeded the ${timeoutMs}ms execution timeout`));
      }, timeoutMs);
      timer.unref?.();
    });
  };
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function defaultHttpProbe({ port, path: pathname, timeoutMs, fetch = globalThis.fetch }) {
  if (typeof fetch !== 'function') throw new TypeError('HTTP readiness probes require fetch support');
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response.status >= 200 && response.status < 400;
}

function defaultTcpProbe({ port, timeoutMs, connect = net.createConnection }) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(healthy);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function resolveProbePort(action, plan) {
  if (Number.isInteger(action.probe.port)) return action.probe.port;
  const workload = plan.workloads.find((candidate) => candidate.deployment?.id === action.workload);
  const port = workload?.deployment?.network?.ports?.find(
    (candidate) => candidate.name === action.probe.port
  );
  const resolved = port?.containerPort ?? port?.servicePort;
  if (!Number.isInteger(resolved))
    throw new TypeError(`Cannot resolve readiness port ${String(action.probe.port)} for ${action.workload}`);
  return resolved;
}

function parseComposeStatus(stdout, ownedServices) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let values;
  try {
    const decoded = JSON.parse(trimmed);
    values = Array.isArray(decoded) ? decoded : [decoded];
  } catch {
    values = trimmed
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return values
    .map((entry) => ({
      service: entry.Service,
      state: entry.State ?? 'unknown',
      health: entry.Health || undefined,
    }))
    .filter((entry) => ownedServices.includes(entry.service))
    .sort((left, right) => left.service.localeCompare(right.service));
}

export function createLocalComposeExecutor({
  projectRoot,
  spawn,
  fetch,
  connect,
  sleep = defaultSleep,
  clock = () => Date.now(),
  probeHttp,
  probeTcp,
  env = process.env,
} = {}) {
  if (typeof projectRoot !== 'string' || !projectRoot)
    throw new TypeError('projectRoot is required for local Compose execution');
  const root = path.resolve(projectRoot);
  const runProcess = createProcessRunner({ spawn, clock });

  async function assertComposeFile(relative) {
    if (!allowedComposeFiles.has(relative))
      throw new TypeError(`Local Compose file is not allowlisted: ${String(relative)}`);
    const composePath = path.resolve(root, relative);
    const entry = await lstat(composePath).catch((error) => {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!entry?.isFile() || entry.isSymbolicLink())
      throw new TypeError(`Local Compose file is missing or unsafe: ${relative}`);
    const canonicalRoot = await realpath(root);
    const canonicalCompose = await realpath(composePath);
    if (!canonicalCompose.startsWith(`${canonicalRoot}${path.sep}`))
      throw new TypeError(`Local Compose file escapes the project: ${relative}`);
    return canonicalCompose;
  }

  async function compose(files, projectName, args, options = {}) {
    if (typeof projectName !== 'string' || !projectNamePattern.test(projectName))
      throw new TypeError('Local Compose project name is invalid');
    await Promise.all(files.map((file) => assertComposeFile(file)));
    return runProcess(
      'docker',
      ['compose', '--project-name', projectName, ...files.flatMap((file) => ['-f', file]), ...args],
      {
        cwd: root,
        env,
        timeoutMs: options.timeoutMs,
      }
    );
  }

  async function singleProbe(action, plan, timeoutMs) {
    const port = action.probe.type === 'exec' ? undefined : resolveProbePort(action, plan);
    if (action.probe.type === 'http') {
      const perform =
        probeHttp ?? ((request) => defaultHttpProbe({ ...request, fetch: fetch ?? globalThis.fetch }));
      return Boolean(await perform({ workload: action.workload, port, path: action.probe.path, timeoutMs }));
    }
    if (action.probe.type === 'tcp') {
      const perform =
        probeTcp ?? ((request) => defaultTcpProbe({ ...request, connect: connect ?? net.createConnection }));
      return Boolean(await perform({ workload: action.workload, port, timeoutMs }));
    }
    const result = await compose(
      composeFilesForPlan(plan),
      composeProjectNameForPlan(plan),
      ['exec', '--no-TTY', action.workload, ...action.probe.command],
      { timeoutMs }
    ).catch(() => undefined);
    return result?.code === 0;
  }

  async function readiness(action, plan) {
    const delayMs = Math.min((action.probe.delaySeconds ?? 0) * 1000, MAX_PROBE_DELAY_MS);
    const intervalMs = Math.min((action.probe.periodSeconds ?? 2) * 1000, MAX_PROBE_INTERVAL_MS);
    const timeoutMs = Math.min((action.probe.timeoutSeconds ?? 5) * 1000, MAX_PROBE_TIMEOUT_MS);
    const failureThreshold = boundedInteger(action.probe.failureThreshold, 12, 1, MAX_PROBE_ATTEMPTS);
    const successThreshold = boundedInteger(action.probe.successThreshold, 1, 1, MAX_PROBE_ATTEMPTS);
    const maximumAttempts = Math.min(MAX_PROBE_ATTEMPTS, failureThreshold + successThreshold - 1);
    if (delayMs > 0) await sleep(delayMs);
    const deadline = clock() + MAX_PROBE_WINDOW_MS;
    let consecutiveSuccesses = 0;
    let failures = 0;
    let attempts = 0;
    while (attempts < maximumAttempts && failures < failureThreshold && clock() <= deadline) {
      attempts += 1;
      let healthy = false;
      try {
        healthy = await singleProbe(action, plan, timeoutMs);
      } catch {
        healthy = false;
      }
      if (healthy) {
        consecutiveSuccesses += 1;
        if (consecutiveSuccesses >= successThreshold)
          return { healthy: true, operation: action.operation, workload: action.workload, attempts };
      } else {
        failures += 1;
        consecutiveSuccesses = 0;
      }
      if (attempts < maximumAttempts && failures < failureThreshold && clock() <= deadline)
        await sleep(intervalMs);
    }
    return { healthy: false, operation: action.operation, workload: action.workload, attempts };
  }

  return {
    async doctor({ composeFiles = [COMPOSE_FILE] } = {}) {
      try {
        await Promise.all(composeFiles.map((file) => assertComposeFile(file)));
        await runProcess('docker', ['compose', 'version', '--short'], {
          cwd: root,
          env,
          timeoutMs: 10_000,
        });
        return { ok: true, composeFiles };
      } catch (error) {
        return { ok: false, composeFiles, message: error.message };
      }
    },

    async execute(action, { plan } = {}) {
      const ownedServices = assertAllowlistedComposeAction(action, plan);
      if (action.operation === 'health-check') return readiness(action, plan);
      const files = composeFilesForPlan(plan);
      const prefixLength = expectedComposePrefix(plan).length;
      const result = await compose(files, composeProjectNameForPlan(plan), action.args.slice(prefixLength));
      if (action.operation === 'validate-compose') {
        const available = result.stdout
          .split('\n')
          .map((service) => service.trim())
          .filter(Boolean);
        const missing = ownedServices.filter((service) => !available.includes(service));
        if (missing.length)
          throw new TypeError(`Compose file does not define planned service(s): ${missing.join(', ')}`);
        return { operation: action.operation, status: 'valid', services: available.sort() };
      }
      return {
        operation: action.operation,
        status: 'started',
        changed: true,
        services: ownedServices,
      };
    },

    async status({
      workloads = [],
      target,
      composeFiles = [COMPOSE_FILE],
      projectName = 'monox-local',
      ownedServices,
    } = {}) {
      const selectedServices = (ownedServices ?? workloads.map((workload) => workload.deployment?.id))
        .filter((service) => typeof service === 'string' && serviceNamePattern.test(service))
        .sort();
      if (selectedServices.length === 0)
        return { adapter: 'local', target: target?.id, status: 'empty', changed: false, workloads: [] };
      try {
        const result = await compose(
          composeFiles,
          projectName,
          ['ps', '--format', 'json', ...selectedServices],
          { timeoutMs: 15_000 }
        );
        const statuses = parseComposeStatus(result.stdout, selectedServices);
        const running = statuses.filter((item) => item.state.toLowerCase() === 'running').length;
        return {
          adapter: 'local',
          target: target?.id,
          status: running === selectedServices.length ? 'running' : running > 0 ? 'partial' : 'stopped',
          changed: false,
          workloads: statuses,
        };
      } catch (error) {
        return {
          adapter: 'local',
          target: target?.id,
          status: 'unavailable',
          changed: false,
          workloads: [],
          message: error.message,
        };
      }
    },

    async rollback({ plan, ownedOnly } = {}) {
      if (ownedOnly !== true) throw new TypeError('Local rollback must be restricted to owned workloads');
      const ownedServices = serviceNames(plan);
      await compose(
        composeFilesForPlan(plan),
        composeProjectNameForPlan(plan),
        ['stop', '--timeout', '10', ...ownedServices],
        { timeoutMs: 60_000 }
      );
      return { status: 'rolled-back', changed: true, ownedOnly: true, services: ownedServices };
    },

    async destroy({ plan, ownedOnly } = {}) {
      if (ownedOnly !== true) throw new TypeError('Local destroy must be restricted to owned workloads');
      const ownedServices = serviceNames(plan);
      await compose(
        composeFilesForPlan(plan),
        composeProjectNameForPlan(plan),
        ['rm', '--force', '--stop', ...ownedServices],
        { timeoutMs: 60_000 }
      );
      return {
        status: 'destroyed',
        changed: true,
        ownedOnly: true,
        services: ownedServices,
        persistentDataRemoved: false,
      };
    },
  };
}

export { COMPOSE_FILE };
