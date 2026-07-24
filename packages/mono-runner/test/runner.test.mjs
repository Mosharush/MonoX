import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArguments, selectWorkspaces } from '../src/index.mjs';

const workspaces = [
  { name: '@monox/api', manifest: { scripts: { dev: 'node .' } } },
  { name: '@monox/web', manifest: { scripts: { dev: 'node .' } } },
  { name: '@monox/shared', manifest: { scripts: { build: 'node build' } } },
];

test('parses agent-friendly selection arguments', () => {
  assert.deepEqual(parseArguments(['--select', 'api,web', '--dry-run']), {
    all: false,
    dryRun: true,
    script: 'dev',
    selected: ['api', 'web'],
  });
});

test('selects full and short workspace names', () => {
  const selected = selectWorkspaces(workspaces, parseArguments(['--select', 'api,@monox/web']));
  assert.deepEqual(
    selected.map(({ name }) => name),
    ['@monox/api', '@monox/web']
  );
});

test('rejects unknown workspaces', () => {
  assert.throws(() => selectWorkspaces(workspaces, parseArguments(['--select', 'missing'])), /Unknown/);
});
