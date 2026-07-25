import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { withTempDirectory } from '@monox/test-utils';

import { renderAgentContract, writeAgentContract } from '../src/index.mjs';

const contract = {
  project: 'example',
  zones: { 'apps/': ['Apps may depend on packages.'], 'packages/': ['Packages never depend on apps.'] },
  commands: { check: 'yarn check' },
  prohibited: ['Do not commit secrets.', 'Do not run unreviewed production deploys.'],
};

test('renders a deterministic source digest and explicit zones', () => {
  const first = renderAgentContract(contract);
  const second = renderAgentContract(contract);
  assert.equal(first.digest, second.digest);
  assert.match(first.markdown, /Packages never depend on apps/);
});

test('writes regular agent files and blocks traversal', async () => {
  await withTempDirectory(async (root) => {
    await writeAgentContract(root, contract, { targets: ['AGENTS.md', '.codex/AGENTS.md'] });
    assert.match(await readFile(`${root}/.codex/AGENTS.md`, 'utf8'), /Source digest/);
    await assert.rejects(() => writeAgentContract(root, contract, { targets: ['../outside.md'] }), /Unsafe/);
  });
});
