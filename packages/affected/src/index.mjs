import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { discoverWorkspaces } from '@monox/workspaces';

const rootInputs = new Set(['.yarnrc.yml', 'monox.config.json', 'package.json', 'yarn.lock']);

export function changedPathsFromGit(root, base, head = 'HEAD') {
  const result = spawnSync(
    'git',
    ['diff', '--name-only', '--no-renames', '--end-of-options', `${base}...${head}`, '--'],
    {
      cwd: root,
      encoding: 'utf8',
    }
  );
  if (result.status !== 0) {
    return { paths: [], failOpen: true, error: result.stderr.trim() || `git exited ${result.status}` };
  }
  return {
    paths: result.stdout
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
    failOpen: false,
  };
}

function internalDependencies(workspace, names) {
  const manifest = workspace.manifest;
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };
  return Object.keys(declared).filter((name) => names.has(name));
}

export function calculateAffected(workspaces, changedPaths, options = {}) {
  const names = new Set(workspaces.map(({ name }) => name));
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const all = new Set(names);
  if (options.failOpen || changedPaths.some((file) => rootInputs.has(file) || file.startsWith('schemas/'))) {
    return [...all].sort();
  }

  const affected = new Set();
  for (const file of changedPaths) {
    const normalized = file.split(path.sep).join('/');
    for (const workspace of workspaces) {
      const location = workspace.location.split(path.sep).join('/');
      if (normalized === location || normalized.startsWith(`${location}/`)) affected.add(workspace.name);
    }
    if (normalized.startsWith('scripts/') || normalized.startsWith('.github/')) {
      for (const name of names) affected.add(name);
    }
  }

  const dependents = new Map([...names].map((name) => [name, new Set()]));
  for (const workspace of workspaces) {
    for (const dependency of internalDependencies(workspace, names))
      dependents.get(dependency).add(workspace.name);
  }

  const queue = [...affected];
  while (queue.length) {
    const current = queue.shift();
    for (const dependent of dependents.get(current) ?? []) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }

  return [...affected].filter((name) => byName.has(name)).sort();
}

export async function affectedFromGit({ root, base = 'origin/main', head = 'HEAD' } = {}) {
  const discovery = await discoverWorkspaces(root);
  const changes = changedPathsFromGit(discovery.root, base, head);
  return {
    ...changes,
    base,
    head,
    workspaces: calculateAffected(discovery.workspaces, changes.paths, { failOpen: changes.failOpen }),
  };
}
