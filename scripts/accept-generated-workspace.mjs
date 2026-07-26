import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 1024 * 1024;

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--root', '--workspace'].includes(key) || !value) {
      throw new TypeError('Usage: accept-generated-workspace --root <path> --workspace <name>');
    }
    options[key.slice(2)] = value;
  }
  if (!options.root || !options.workspace) {
    throw new TypeError('Both --root and --workspace are required');
  }
  return options;
}

async function loadManifest(root, workspace) {
  for (const parent of ['apps', 'packages']) {
    const file = path.join(root, parent, workspace, 'package.json');
    try {
      return { file, manifest: JSON.parse(await readFile(file, 'utf8')) };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new TypeError(`Generated workspace was not found: ${workspace}`);
}

function syntheticEnvironment(deployment) {
  const env = { ...process.env };
  for (const reference of deployment.env?.secretRefs ?? []) {
    env[reference.target] = `synthetic-${reference.name}-acceptance-only`;
  }
  return env;
}

function collectOutput(child) {
  let output = '';
  const collect = (chunk) => {
    output += String(chunk);
    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
      output = output.slice(-MAX_OUTPUT_BYTES);
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return () => output;
}

function exitPromise(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopProcessGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') child.kill('SIGTERM');
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await delay(100);
  }
  if (process.platform === 'win32') child.kill('SIGKILL');
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

async function waitForHttp(deployment, child, getOutput) {
  const probe = deployment.probes?.readiness ?? deployment.probes?.liveness;
  if (probe?.type !== 'http') throw new TypeError('A network workload requires an HTTP readiness probe');
  const declaredPort = deployment.network?.ports?.find((port) => port.name === probe.port);
  const port = Number.isInteger(probe.port)
    ? probe.port
    : (declaredPort?.containerPort ?? declaredPort?.servicePort);
  if (!Number.isInteger(port)) throw new TypeError(`Could not resolve HTTP probe port ${String(probe.port)}`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Generated workload exited before readiness\n${getOutput()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${probe.path}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status >= 200 && response.status < 400) return;
    } catch {
      // Readiness is retried until the bounded deadline.
    }
    await delay(500);
  }
  throw new Error(`Generated workload did not become ready\n${getOutput()}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(options.root);
  const { manifest } = await loadManifest(root, options.workspace);
  if (!manifest.deployment) {
    process.stdout.write(`runtime=not-applicable workspace=${manifest.name}\n`);
    return;
  }
  if (typeof manifest.scripts?.start !== 'string') {
    throw new TypeError(`Deployable workspace has no start script: ${manifest.name}`);
  }

  const child = spawn('npx', ['--yes', 'npm@12.0.1', 'run', 'start', '--workspace', manifest.name], {
    cwd: root,
    env: syntheticEnvironment(manifest.deployment),
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const getOutput = collectOutput(child);
  const exited = exitPromise(child);
  try {
    if (['cron', 'job'].includes(manifest.deployment.kind)) {
      const result = await Promise.race([exited, delay(30_000).then(() => ({ timeout: true }))]);
      if (result.timeout) throw new Error(`Generated one-shot workload did not exit\n${getOutput()}`);
      if (result.code !== 0) throw new Error(`Generated one-shot workload failed\n${getOutput()}`);
    } else if (manifest.deployment.kind === 'worker') {
      await delay(2_000);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Generated worker exited during its start check\n${getOutput()}`);
      }
    } else {
      await waitForHttp(manifest.deployment, child, getOutput);
    }
    process.stdout.write(`runtime=passed workspace=${manifest.name} kind=${manifest.deployment.kind}\n`);
  } finally {
    await stopProcessGroup(child);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
