import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_WORKFLOWS = Object.freeze([
  { name: 'CI', path: '.github/workflows/ci.yml', event: 'push' },
  { name: '0.2 release acceptance', path: '.github/workflows/release-acceptance.yml', event: 'push' },
  { name: 'Kubernetes runtime smoke', path: '.github/workflows/kubernetes-smoke.yml', event: 'push' },
  { name: 'CodeQL', path: 'dynamic/github-code-scanning/codeql', event: 'dynamic' },
]);

export function requiredWorkflows(value) {
  const workflows = value ? JSON.parse(value) : REQUIRED_WORKFLOWS;
  if (!Array.isArray(workflows) || workflows.length === 0 || workflows.length > 20) {
    throw new TypeError('Required workflows must be a nonempty bounded list.');
  }
  const paths = new Set();
  for (const workflow of workflows) {
    const validPath =
      workflow.event === 'push'
        ? /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow.path)
        : workflow.event === 'dynamic' && workflow.path === 'dynamic/github-code-scanning/codeql';
    if (
      !validPath ||
      typeof workflow.name !== 'string' ||
      !/^[A-Za-z0-9 ._-]{1,100}$/.test(workflow.name) ||
      paths.has(workflow.path)
    ) {
      throw new TypeError('Invalid or duplicated required workflow.');
    }
    paths.add(workflow.path);
  }
  return workflows;
}

export function deploymentCandidate(event, repositoryId, workflows = REQUIRED_WORKFLOWS) {
  const run = event?.workflow_run;
  if (
    event?.action !== 'completed' ||
    run?.head_branch !== 'main' ||
    String(run?.head_repository?.id) !== String(repositoryId) ||
    !workflows.some(
      (workflow) =>
        workflow.event === run?.event &&
        workflow.path === run?.path &&
        (workflow.name === run?.name || (workflow.event === 'dynamic' && run?.name === 'Push on main'))
    ) ||
    !/^[a-f0-9]{40}$/.test(run?.head_sha ?? '')
  ) {
    throw new TypeError('Deployment requires a completed allowlisted same-repository main workflow event.');
  }
  return run.head_sha;
}

export function candidateFromEnvironment(env, event, workflows = REQUIRED_WORKFLOWS) {
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    return deploymentCandidate(event, env.GITHUB_REPOSITORY_ID, workflows);
  }
  if (
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REF === 'refs/heads/main' &&
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
  ) {
    // There is no user-supplied revision input. A manual retry uses GitHub's main snapshot,
    // which must still match current main and pass every gate before deployment.
    return env.GITHUB_SHA;
  }
  throw new TypeError('Only allowlisted workflow completions or a manual retry on main are supported.');
}

export function evaluateCiGate({ sha, mainSha, repositoryId, runs, workflows = REQUIRED_WORKFLOWS }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new TypeError('Invalid deployment commit.');
  if (mainSha !== sha) return { allowed: false, pending: false, reason: 'Commit is no longer main.' };
  const selected = [];
  for (const workflow of workflows) {
    const matching = runs
      .filter(
        (run) =>
          run.path === workflow.path &&
          run.event === workflow.event &&
          run.head_branch === 'main' &&
          run.head_sha === sha &&
          String(run.head_repository?.id) === String(repositoryId)
      )
      .sort((left, right) => right.id - left.id);
    const latest = matching[0];
    if (!latest || latest.status !== 'completed') {
      return { allowed: false, pending: true, reason: `Waiting for ${workflow.name}.` };
    }
    if (latest.conclusion !== 'success') {
      return { allowed: false, pending: false, reason: `${workflow.name} did not succeed.` };
    }
    selected.push({ id: latest.id, attempt: latest.run_attempt, path: workflow.path });
  }
  return { allowed: true, pending: false, reason: 'All required workflows succeeded.', runs: selected };
}

export function createGitHubReader({
  repository,
  token,
  apiUrl = 'https://api.github.com',
  fetchImpl = fetch,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !token) {
    throw new TypeError('GitHub repository and read token are required.');
  }
  const base = new URL(apiUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new TypeError('GitHub API URL must be an HTTPS origin without credentials.');
  }
  return async (path) => {
    const response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/repos/${repository}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub gate request failed with HTTP ${response.status}.`);
    return response.json();
  };
}

export async function inspectCiGate({ sha, repositoryId, readGitHub, workflows = REQUIRED_WORKFLOWS }) {
  const response = await readGitHub(`/actions/runs?head_sha=${sha}&per_page=100`);
  if (!Array.isArray(response.workflow_runs) || response.total_count > 100) {
    throw new Error('Cannot establish the complete workflow run set for this commit.');
  }
  // List responses can lag a rerun. Read each candidate again to observe its current attempt/state.
  const latest = new Map();
  for (const run of response.workflow_runs) {
    if (!workflows.some((workflow) => workflow.path === run.path && workflow.event === run.event)) {
      continue;
    }
    if (run.head_sha !== sha || run.head_branch !== 'main') continue;
    if (String(run.head_repository?.id) !== String(repositoryId)) continue;
    if (!Number.isSafeInteger(run.id) || run.id <= 0) throw new Error('Invalid workflow run identity.');
    if (!latest.has(run.path) || latest.get(run.path).id < run.id) latest.set(run.path, run);
  }
  const runs = await Promise.all([...latest.values()].map((run) => readGitHub(`/actions/runs/${run.id}`)));
  const main = await readGitHub('/git/ref/heads/main');
  return evaluateCiGate({ sha, mainSha: main.object?.sha, repositoryId, runs, workflows });
}

export async function waitForCiGate({
  inspect,
  waitSeconds = 900,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 1200) {
    throw new TypeError('Gate wait must be between 0 and 1200 seconds.');
  }
  for (let elapsed = 0; ; elapsed += 15) {
    const result = await inspect();
    if (!result.pending) return result;
    if (elapsed >= waitSeconds) throw new Error('Timed out waiting for required main-commit workflows.');
    await sleep(Math.min(15, waitSeconds - elapsed) * 1000);
  }
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repositoryId = process.env.GITHUB_REPOSITORY_ID;
  if (!/^\d+$/.test(repositoryId ?? '')) throw new Error('GitHub repository identity is required.');
  const workflows = requiredWorkflows(process.env.COOLIFY_REQUIRED_WORKFLOWS);
  const sha = candidateFromEnvironment(process.env, event, workflows);
  const readGitHub = createGitHubReader({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL,
  });
  const result = await waitForCiGate({
    inspect: () => inspectCiGate({ sha, repositoryId, readGitHub, workflows }),
    waitSeconds: Number(process.env.COOLIFY_GATE_WAIT_SECONDS ?? 900),
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `eligible=${result.allowed}\nsha=${sha}\n`);
  }
  console.log(result.reason);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
