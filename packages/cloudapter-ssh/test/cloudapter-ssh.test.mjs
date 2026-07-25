import assert from 'node:assert/strict';
import test from 'node:test';

import { createSshCloudapter } from '../src/index.mjs';

function context() {
  return {
    config: { project: { name: 'example' } },
    environment: 'production',
    sourceDigest: 'sha256:source',
    targetStateDigest: 'sha256:state',
    target: {
      id: 'production-vm',
      provider: 'generic',
      provisioner: 'none',
      transport: 'ssh',
      runtime: 'pm2',
      serverRef: 'production-server',
      bindings: {
        identityRef: 'secret-store://ssh/production',
        secretStoreRef: 'secret-store://ssh/known-hosts',
      },
    },
    workloads: [],
    remoteActions: [{ executable: 'pm2', args: ['status', '--json'] }],
  };
}

test('requires pinned known-host data and rejects shell strings', async () => {
  const adapter = createSshCloudapter();
  const missing = context();
  delete missing.target.bindings.secretStoreRef;
  assert.equal((await adapter.validate(missing)).valid, false);

  const shell = context();
  shell.remoteActions = [{ executable: 'sh', args: ['-c', 'pm2 status'], command: 'pm2 status' }];
  assert.equal((await adapter.validate(shell)).valid, false);
});

test('renders reference-only SSH transport details', async () => {
  const adapter = createSshCloudapter();
  const input = context();
  const plan = await adapter.plan(input);
  const rendered = await adapter.render(plan);
  assert.match(rendered.artifacts[0].content, /knownHostsRef/);
  assert.match(rendered.artifacts[0].content, /strictHostKeyChecking/);
  assert.doesNotMatch(rendered.artifacts[0].content, /PRIVATE KEY/);
  await assert.rejects(() => adapter.apply(plan, input), /context\.ssh\.execute/);
});
