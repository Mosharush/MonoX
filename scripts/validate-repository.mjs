import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { discoverWorkspaces } from '../packages/workspaces/src/index.mjs';

const privateMarkers = (process.env.MONOX_PRIVATE_MARKERS ?? '')
  .split(',')
  .map((marker) => marker.trim().toLowerCase())
  .filter((marker) => marker.length >= 3);
const publishableWorkspaces = new Set(['create-monox']);
const ignoredDirectories = new Set(['.git', '.yarn', 'coverage', 'dist', 'node_modules']);
const textExtensions = new Set([
  '',
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.sh',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

async function listTextFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTextFiles(absolute, root)));
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name)))
      files.push(path.relative(root, absolute));
  }
  return files;
}

function dependencyNames(manifest) {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  });
}

function group(location) {
  return location.split(path.sep)[0];
}

const failures = [];
const { root, workspaces } = await discoverWorkspaces();
const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));

for (const workspace of workspaces) {
  if (workspace.name !== 'create-monox' && !workspace.name.startsWith('@monox/')) {
    failures.push(`${workspace.location}: package name must use the @monox scope`);
  }
  if (publishableWorkspaces.has(workspace.name)) {
    if (workspace.manifest.private !== false) {
      failures.push(`${workspace.location}: release-reviewed packages must set private to false`);
    }
    if (workspace.manifest.license !== 'MIT') {
      failures.push(`${workspace.location}: release-reviewed packages must declare the MIT license`);
    }
    if (!workspace.manifest.files?.includes('LICENSE')) {
      failures.push(`${workspace.location}: published files must include LICENSE`);
    }
  } else if (workspace.manifest.private !== true) {
    failures.push(`${workspace.location}: workspaces stay private until an explicit release review`);
  }

  for (const dependency of dependencyNames(workspace.manifest)) {
    const target = byName.get(dependency);
    if (!target) continue;
    const sourceGroup = group(workspace.location);
    const targetGroup = group(target.location);
    if (sourceGroup === 'packages' && targetGroup === 'apps') {
      failures.push(`${workspace.name}: packages cannot depend on apps (${dependency})`);
    }
    if (sourceGroup === 'infra' && targetGroup === 'apps') {
      failures.push(`${workspace.name}: infra cannot import application code (${dependency})`);
    }
  }
}

const config = JSON.parse(await readFile(path.join(root, 'monox.config.json'), 'utf8'));
if (!Array.isArray(config.applications) || config.applications.length === 0) {
  failures.push('monox.config.json: at least one application is required');
}
if (config.deployment?.autoscaling?.minReplicas > config.deployment?.autoscaling?.maxReplicas) {
  failures.push('monox.config.json: autoscaling minReplicas cannot exceed maxReplicas');
}
if (config.deployment?.autoscaling?.mode === 'hpa' && config.deployment.autoscaling.minReplicas < 1) {
  failures.push('monox.config.json: HPA mode requires at least one replica; use KEDA for scale to zero');
}

for (const relative of await listTextFiles(root)) {
  const lower = (await readFile(path.join(root, relative), 'utf8')).toLowerCase();
  for (const marker of privateMarkers) {
    if (lower.includes(marker)) failures.push(`${relative}: contains a private-product marker`);
  }
  if (/-----begin (?:rsa |ec |openssh )?private key-----/i.test(lower)) {
    failures.push(`${relative}: contains private key material`);
  }
  if (/\b(?:ghp|github_pat|sk)-[a-z0-9_-]{20,}\b/i.test(lower)) {
    failures.push(`${relative}: contains a token-like value`);
  }
  if (/child_process\s*\.\s*exec\s*\(/.test(lower)) {
    failures.push(`${relative}: shell-string execution is not allowed`);
  }
}

if (failures.length) {
  console.error('Repository validation failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Repository validation passed for ${workspaces.length} workspaces.`);
