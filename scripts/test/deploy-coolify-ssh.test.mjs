import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  deployFromEnvironment,
  parseDeploymentReceipt,
  runSshDeployment,
  validateDeploymentInput,
  verifyDeploymentMarker,
} from '../deploy-coolify-ssh.mjs';

const sha = 'a'.repeat(40);
const environment = () => ({
  DEPLOYMENT_COMMIT: sha,
  COOLIFY_SSH_HOST: 'deploy.example.test',
  COOLIFY_SSH_USER: 'gateway',
  COOLIFY_SSH_PRIVATE_KEY: 'synthetic-key',
  COOLIFY_SSH_KNOWN_HOSTS: 'deploy.example.test synthetic-host-key',
  GITHUB_TOKEN: 'synthetic-read-token',
  GITHUB_REPOSITORY: 'example/project',
  DEPLOYMENT_VERIFY_URL: 'https://site.example.test/deployment.json',
});

test('post-receipt supersession is accepted only when the public marker equals a different current main', async () => {
  const newer = 'b'.repeat(40);
  const options = {
    url: environment().DEPLOYMENT_VERIFY_URL,
    sha,
    attempts: 1,
    fetchImpl: async () => ({ ok: true, json: async () => ({ commit: newer }) }),
  };
  assert.equal(
    await verifyDeploymentMarker({ ...options, readCurrentMain: async () => newer }),
    'superseded'
  );
  for (const main of [sha, 'c'.repeat(40), undefined]) {
    await assert.rejects(
      () => verifyDeploymentMarker({ ...options, readCurrentMain: async () => main }),
      /did not confirm/
    );
  }
  const receipt = await deployFromEnvironment(environment(), {
    runSsh: async () => ({ status: 'deployed', sha }),
    verifyMarker: async ({ readCurrentMain }) => {
      assert.equal(await readCurrentMain(), newer);
      return 'superseded';
    },
    readCurrentMain: async () => newer,
  });
  assert.deepEqual(receipt, { status: 'stale', sha });
});

test('SSH deployment input rejects refs, option injection, missing host pin and unsafe verification URLs', () => {
  assert.equal(validateDeploymentInput(environment()).sha, sha);
  for (const patch of [
    { DEPLOYMENT_COMMIT: 'main' },
    { COOLIFY_SSH_HOST: '-oProxyCommand=bad' },
    { COOLIFY_SSH_USER: 'gateway bad' },
    { COOLIFY_SSH_KNOWN_HOSTS: '' },
    { DEPLOYMENT_VERIFY_URL: 'http://site.example.test/deployment.json' },
    { DEPLOYMENT_VERIFY_URL: 'https://user:password@site.example.test/deployment.json' },
  ]) {
    assert.throws(() => validateDeploymentInput({ ...environment(), ...patch }));
  }
});

test('gateway receipts must name the exact commit and discard arbitrary provider fields', () => {
  assert.deepEqual(
    parseDeploymentReceipt(JSON.stringify({ status: 'deployed', sha, private: 'ignored' }), sha),
    { status: 'deployed', sha }
  );
  for (const output of [
    'not json',
    JSON.stringify({ status: 'queued', sha }),
    JSON.stringify({ status: 'deployed', sha: 'b'.repeat(40) }),
  ]) {
    assert.throws(() => parseDeploymentReceipt(output, sha));
  }
});

function fakeSsh({ code = 0, output = JSON.stringify({ status: 'deployed', sha }) } = {}) {
  const captured = {};
  const spawnImpl = (command, args, options) => {
    Object.assign(captured, { command, args, options, stdin: '' });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on('data', (data) => {
      captured.stdin += data;
    });
    child.stdin.on('finish', () => {
      child.stderr.write('private remote diagnostic');
      child.stdout.write(output);
      child.emit('close', code);
    });
    return child;
  };
  return { captured, spawnImpl };
}

test('SSH sends only literal deploy and pinned host options; token travels only over stdin', async () => {
  const fake = fakeSsh();
  const receipt = await runSshDeployment({
    host: 'deploy.example.test',
    user: 'gateway',
    keyFile: '/temporary/key',
    knownHostsFile: '/temporary/known_hosts',
    sha,
    token: 'synthetic-read-token',
    spawnImpl: fake.spawnImpl,
  });
  assert.equal(receipt.status, 'deployed');
  assert.equal(fake.captured.command, 'ssh');
  assert.equal(fake.captured.args.at(-1), 'deploy');
  assert(fake.captured.args.includes('StrictHostKeyChecking=yes'));
  assert(fake.captured.args.includes('IdentitiesOnly=yes'));
  assert.equal(fake.captured.options.shell, false);
  assert(!JSON.stringify(fake.captured.args).includes('synthetic-read-token'));
  assert.deepEqual(JSON.parse(fake.captured.stdin), { sha, github_token: 'synthetic-read-token' });
  const failed = fakeSsh({ code: 1 });
  await assert.rejects(
    () =>
      runSshDeployment({
        host: 'deploy.example.test',
        user: 'gateway',
        keyFile: '/temporary/key',
        knownHostsFile: '/temporary/known_hosts',
        sha,
        token: 'synthetic-read-token',
        spawnImpl: failed.spawnImpl,
      }),
    /^Error: Deployment gateway failed; inspect its private server log\.$/
  );
});

test('public verification checks commit identity, avoids redirects/cache and sends no token', async () => {
  let calls = 0;
  await verifyDeploymentMarker({
    url: new URL(environment().DEPLOYMENT_VERIFY_URL),
    sha,
    attempts: 2,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      calls += 1;
      assert(url.searchParams.has('deployment_probe'));
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.headers.authorization, undefined);
      return { ok: true, json: async () => ({ commit: calls === 1 ? 'b'.repeat(40) : sha }) };
    },
  });
  assert.equal(calls, 2);
  await assert.rejects(
    () =>
      verifyDeploymentMarker({
        url: environment().DEPLOYMENT_VERIFY_URL,
        sha,
        attempts: 1,
        fetchImpl: async () => ({ ok: true, json: async () => ({ commit: 'b'.repeat(40) }) }),
      }),
    /did not confirm/
  );
});

test('temporary SSH credentials are private and cleaned after success or failure; stale skips marker', async () => {
  for (const status of ['deployed', 'stale', 'failure']) {
    let keyFile;
    let markerCalls = 0;
    const operation = deployFromEnvironment(environment(), {
      runSsh: async (input) => {
        keyFile = input.keyFile;
        assert.equal((await stat(input.keyFile)).mode & 0o777, 0o600);
        assert.equal((await stat(input.knownHostsFile)).mode & 0o777, 0o600);
        assert.equal((await readFile(input.keyFile, 'utf8')).trim(), 'synthetic-key');
        if (status === 'failure') throw new Error('synthetic failure');
        return { status, sha };
      },
      verifyMarker: async () => {
        markerCalls += 1;
      },
    });
    if (status === 'failure') await assert.rejects(operation, /synthetic failure/);
    else assert.equal((await operation).status, status);
    await assert.rejects(() => stat(keyFile), { code: 'ENOENT' });
    assert.equal(markerCalls, status === 'deployed' ? 1 : 0);
  }
});
