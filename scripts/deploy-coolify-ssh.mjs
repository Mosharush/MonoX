import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGitHubReader } from './coolify-ci-gate.mjs';

export function validateDeploymentInput(env) {
  const sha = env.DEPLOYMENT_COMMIT;
  const host = env.COOLIFY_SSH_HOST;
  const user = env.COOLIFY_SSH_USER;
  if (!/^[a-f0-9]{40}$/.test(sha ?? ''))
    throw new TypeError('A full lowercase deployment commit is required.');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host ?? '') || !/^[a-z_][a-z0-9_-]*$/.test(user ?? '')) {
    throw new TypeError('A valid deployment SSH host and user are required.');
  }
  if (!env.COOLIFY_SSH_PRIVATE_KEY || !env.COOLIFY_SSH_KNOWN_HOSTS || !env.GITHUB_TOKEN) {
    throw new TypeError('Deployment SSH credentials, host pin and GitHub read token are required.');
  }
  const verifyUrl = new URL(env.DEPLOYMENT_VERIFY_URL);
  if (
    verifyUrl.protocol !== 'https:' ||
    verifyUrl.username ||
    verifyUrl.password ||
    verifyUrl.search ||
    verifyUrl.hash
  ) {
    throw new TypeError('Deployment verification requires a credential-free HTTPS URL without a query.');
  }
  return { sha, host, user, verifyUrl };
}

export function parseDeploymentReceipt(output, expectedSha) {
  let receipt;
  try {
    receipt = JSON.parse(output);
  } catch {
    throw new Error('Deployment gateway returned an invalid receipt.');
  }
  if (!['deployed', 'already_deployed', 'stale'].includes(receipt?.status) || receipt.sha !== expectedSha) {
    throw new Error('Deployment gateway receipt did not match the requested commit.');
  }
  // Only these public fields reach workflow logs; discard provider metadata and arbitrary output.
  return { status: receipt.status, sha: receipt.sha };
}

export async function runSshDeployment({
  host,
  user,
  keyFile,
  knownHostsFile,
  sha,
  token,
  spawnImpl = spawn,
  timeoutMs = 1200000,
}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(
      'ssh',
      [
        '-F',
        '/dev/null',
        '-T',
        '-i',
        keyFile,
        '-o',
        'BatchMode=yes',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${knownHostsFile}`,
        '-o',
        'ConnectTimeout=15',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=4',
        `${user}@${host}`,
        'deploy',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], shell: false }
    );
    let output = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('Deployment SSH timed out; reconcile gateway state before retrying.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (Buffer.byteLength(output) > 65536) {
        child.kill('SIGTERM');
        finish(new Error('Deployment gateway response exceeded its size limit.'));
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('Could not start the deployment SSH connection.')));
    child.stdin.on('error', () =>
      finish(new Error('Deployment request could not be delivered; reconcile gateway state before retrying.'))
    );
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error('Deployment gateway failed; inspect its private server log.'));
      try {
        finish(null, parseDeploymentReceipt(output, sha));
      } catch (error) {
        finish(error);
      }
    });
    // The token is never a command argument, environment forwarding option or log field.
    child.stdin.end(`${JSON.stringify({ sha, github_token: token })}\n`);
  });
}

export async function verifyDeploymentMarker({
  url,
  sha,
  fetchImpl = fetch,
  attempts = 12,
  readCurrentMain,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = new URL(url);
    probe.searchParams.set('deployment_probe', randomUUID());
    try {
      const response = await fetchImpl(probe, {
        headers: { 'cache-control': 'no-cache', accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const commit = (await response.json()).commit;
        if (commit === sha) return 'verified';
        // The gateway verified this deployment while holding its application lock. A newer
        // deployment may acquire that lock before this extra public probe reaches the site.
        if (/^[a-f0-9]{40}$/.test(commit ?? '') && readCurrentMain && (await readCurrentMain()) === commit) {
          return 'superseded';
        }
      }
    } catch {
      /* A bounded retry handles the public route becoming ready. */
    }
    if (attempt + 1 < attempts) await sleep(5000);
  }
  throw new Error('The public deployment marker did not confirm the requested commit.');
}

export async function deployFromEnvironment(env, dependencies = {}) {
  const input = validateDeploymentInput(env);
  const directory = await mkdtemp(join(tmpdir(), 'coolify-deploy-'));
  try {
    const keyFile = join(directory, 'identity');
    const knownHostsFile = join(directory, 'known_hosts');
    await writeFile(keyFile, `${env.COOLIFY_SSH_PRIVATE_KEY.trim()}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(knownHostsFile, `${env.COOLIFY_SSH_KNOWN_HOSTS.trim()}\n`, { mode: 0o600, flag: 'wx' });
    const receipt = await (dependencies.runSsh ?? runSshDeployment)({
      ...input,
      keyFile,
      knownHostsFile,
      token: env.GITHUB_TOKEN,
    });
    if (receipt.status !== 'stale') {
      const result = await (dependencies.verifyMarker ?? verifyDeploymentMarker)({
        url: input.verifyUrl,
        sha: input.sha,
        readCurrentMain:
          dependencies.readCurrentMain ??
          (async () => {
            const read = createGitHubReader({
              repository: env.GITHUB_REPOSITORY,
              token: env.GITHUB_TOKEN,
              apiUrl: env.GITHUB_API_URL,
            });
            return (await read('/git/ref/heads/main')).object?.sha;
          }),
      });
      if (result === 'superseded') return { status: 'stale', sha: input.sha };
    }
    return receipt;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployFromEnvironment(process.env)
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch(() => {
      console.error(
        'Deployment could not be verified. Check the gateway and public commit marker before retrying.'
      );
      process.exitCode = 1;
    });
}
