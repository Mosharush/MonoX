import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverWorkspaces, findWorkspaceRoot, runnableWorkspaces } from '../src/index.mjs';

test('discovers and sorts workspaces without package-manager-specific commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monox-workspaces-'));
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['apps/*'] })
    );
    await mkdir(path.join(root, 'apps', 'web'), { recursive: true });
    await mkdir(path.join(root, 'apps', 'api'), { recursive: true });
    await writeFile(path.join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: '@test/web' }));
    await writeFile(
      path.join(root, 'apps', 'api', 'package.json'),
      JSON.stringify({ name: '@test/api', scripts: { dev: 'node .' } })
    );

    const result = await discoverWorkspaces(root);
    assert.deepEqual(
      result.workspaces.map(({ name }) => name),
      ['@test/api', '@test/web']
    );
    assert.deepEqual(
      runnableWorkspaces(result.workspaces).map(({ name }) => name),
      ['@test/api']
    );
    assert.equal(await findWorkspaceRoot(path.join(root, 'apps', 'api')), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
