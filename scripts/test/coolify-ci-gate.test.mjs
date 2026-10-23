import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_WORKFLOWS,
  candidateFromEnvironment,
  createGitHubReader,
  deploymentCandidate,
  evaluateCiGate,
  inspectCiGate,
  requiredWorkflows,
  waitForCiGate,
} from '../coolify-ci-gate.mjs';

const sha = 'a'.repeat(40);
const repositoryId = '123';
const successfulRuns = () =>
  REQUIRED_WORKFLOWS.map((workflow, index) => ({
    id: index + 1,
    run_attempt: 1,
    name: workflow.name,
    path: workflow.path,
    event: workflow.event,
    head_sha: sha,
    head_branch: 'main',
    head_repository: { id: Number(repositoryId) },
    status: 'completed',
    conclusion: 'success',
  }));
const evaluate = (runs, mainSha = sha) => evaluateCiGate({ sha, mainSha, repositoryId, runs });

test('a validated workflow configuration supports a single-CI consumer without weakening event scope', () => {
  const workflows = requiredWorkflows(JSON.stringify([REQUIRED_WORKFLOWS[0]]));
  assert.equal(
    evaluateCiGate({ sha, mainSha: sha, repositoryId, runs: successfulRuns().slice(0, 1), workflows })
      .allowed,
    true
  );
  for (const value of [
    '[]',
    '{}',
    JSON.stringify([{ name: 'CI', path: '../invalid', event: 'push' }]),
    JSON.stringify([REQUIRED_WORKFLOWS[0], REQUIRED_WORKFLOWS[0]]),
  ]) {
    assert.throws(() => requiredWorkflows(value));
  }
});

test('deployment candidate rejects PR, manual upstream, fork, branch and malformed SHA events', () => {
  const event = { action: 'completed', workflow_run: successfulRuns()[0] };
  assert.equal(deploymentCandidate(event, repositoryId), sha);
  for (const patch of [
    { event: 'pull_request' },
    { event: 'workflow_dispatch' },
    { head_branch: 'feature' },
    { head_repository: { id: 456 } },
    { head_sha: 'main' },
    { name: 'Untrusted workflow' },
    { path: '.github/workflows/other.yml' },
  ]) {
    assert.throws(() =>
      deploymentCandidate({ ...event, workflow_run: { ...event.workflow_run, ...patch } }, repositoryId)
    );
  }
  assert.throws(() => deploymentCandidate({ ...event, action: 'requested' }, repositoryId));
});

test('CodeQL completion can recover deployment only with its exact same-repository dynamic identity', () => {
  const run = { ...successfulRuns()[3], name: 'Push on main' };
  assert.equal(deploymentCandidate({ action: 'completed', workflow_run: run }, repositoryId), sha);
  for (const patch of [
    { path: '.github/workflows/other.yml' },
    { event: 'push' },
    { head_branch: 'feature' },
    { head_repository: { id: 456 } },
    { name: 'Pull request' },
  ]) {
    assert.throws(() =>
      deploymentCandidate({ action: 'completed', workflow_run: { ...run, ...patch } }, repositoryId)
    );
  }
});

test('explicit deployment retry accepts only GitHub main snapshot and still requires fresh successful gates', () => {
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha };
  assert.equal(candidateFromEnvironment(env, { inputs: { sha: 'b'.repeat(40) } }), sha);
  assert.equal(evaluate(successfulRuns(), 'b'.repeat(40)).allowed, false);
  assert.equal(evaluate(successfulRuns().slice(0, 3)).allowed, false);
  for (const patch of [
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_SHA: 'main' },
    { GITHUB_EVENT_NAME: 'push' },
  ]) {
    assert.throws(() => candidateFromEnvironment({ ...env, ...patch }, {}));
  }
  assert.equal(
    candidateFromEnvironment(
      { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY_ID: repositoryId },
      { action: 'completed', workflow_run: successfulRuns()[0] }
    ),
    sha
  );
});

test('gate requires all three push workflows and same-commit dynamic CodeQL', () => {
  assert.equal(evaluate(successfulRuns()).allowed, true);
  assert.equal(evaluate(successfulRuns().slice(0, 3)).allowed, false);
  for (const patch of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'feature' },
    { head_repository: { id: 456 } },
    { event: 'pull_request' },
  ]) {
    const runs = successfulRuns();
    runs[0] = { ...runs[0], ...patch };
    assert.equal(evaluate(runs).allowed, false);
  }
});

test('latest failing, queued, cancelled or rerunning execution defeats older success', () => {
  for (const [status, conclusion] of [
    ['completed', 'failure'],
    ['completed', 'cancelled'],
    ['completed', 'skipped'],
    ['queued', null],
    ['in_progress', null],
  ]) {
    const runs = successfulRuns();
    runs.push({ ...runs[0], id: 100, status, conclusion, run_attempt: 2 });
    assert.equal(evaluate(runs).allowed, false);
  }
  const runs = successfulRuns();
  runs[0] = { ...runs[0], run_attempt: 2, status: 'in_progress', conclusion: null };
  assert.equal(evaluate(runs).allowed, false);
  assert.equal(evaluate(successfulRuns(), 'b'.repeat(40)).allowed, false);
});

test('inspection re-fetches current attempts and reads main after the workflow checks', async () => {
  const calls = [];
  const runs = successfulRuns();
  const result = await inspectCiGate({
    sha,
    repositoryId,
    readGitHub: async (path) => {
      calls.push(path);
      if (path.startsWith('/actions/runs?')) return { total_count: 4, workflow_runs: runs };
      if (path === '/git/ref/heads/main') return { object: { sha } };
      const run = runs.find((entry) => path === `/actions/runs/${entry.id}`);
      return run.id === 1 ? { ...run, run_attempt: 2, status: 'in_progress', conclusion: null } : run;
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.pending, true);
  assert.equal(calls.at(-1), '/git/ref/heads/main');
});

test('incomplete API results and HTTP errors fail closed without exposing response bodies', async () => {
  await assert.rejects(
    () =>
      inspectCiGate({
        sha,
        repositoryId,
        readGitHub: async () => ({ total_count: 101, workflow_runs: successfulRuns() }),
      }),
    /complete workflow run set/
  );
  const read = createGitHubReader({
    repository: 'example/project',
    token: 'synthetic-token',
    fetchImpl: async () => ({ ok: false, status: 403, text: () => 'private response' }),
  });
  await assert.rejects(
    () => read('/git/ref/heads/main'),
    /^Error: GitHub gate request failed with HTTP 403\.$/
  );
});

test('bounded waiting permits eventual completion, stops for stale main and times out closed', async () => {
  let attempts = 0;
  let sleeps = 0;
  const result = await waitForCiGate({
    inspect: async () => (++attempts === 1 ? { pending: true } : evaluate(successfulRuns())),
    waitSeconds: 15,
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(sleeps, 1);
  const stale = await waitForCiGate({ inspect: async () => evaluate(successfulRuns(), 'b'.repeat(40)) });
  assert.equal(stale.allowed, false);
  await assert.rejects(
    () => waitForCiGate({ inspect: async () => ({ pending: true }), waitSeconds: 0 }),
    /Timed out/
  );
});
