import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { findWorkspaceRoot } from '../packages/workspaces/src/index.mjs';
import { satisfiesNodeVersionRange } from './node-version-range.mjs';

const strict = process.argv.includes('--strict');
const root = await findWorkspaceRoot();
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const checks = [];

function commandVersion(command, args = ['--version'], required = false) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  checks.push({
    name: command,
    ok: result.status === 0,
    required,
    detail: result.status === 0 ? (result.stdout || result.stderr).trim().split('\n')[0] : 'not installed',
  });
}

checks.push({
  name: 'node',
  ok: satisfiesNodeVersionRange(process.versions.node, manifest.engines.node),
  required: true,
  detail: `${process.versions.node} (requires ${manifest.engines.node})`,
});
commandVersion('yarn', ['--version'], true);
commandVersion('docker');
commandVersion('kubectl', ['version', '--client=true', '--output=yaml']);
commandVersion('helm', ['version', '--short']);
commandVersion('pulumi');

for (const check of checks) {
  const status = check.ok ? 'OK' : check.required ? 'MISSING' : 'OPTIONAL';
  console.log(`${status.padEnd(8)} ${check.name}: ${check.detail}`);
}

const failed = checks.filter((check) => !check.ok && (check.required || strict));
if (failed.length) {
  console.error(`Doctor found ${failed.length} blocking tool issue(s).`);
  process.exit(1);
}

console.log('MonoX doctor passed.');
