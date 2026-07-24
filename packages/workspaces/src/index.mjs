import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function findWorkspaceRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    const packagePath = path.join(current, 'package.json');
    if (await exists(packagePath)) {
      const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
      if (Array.isArray(manifest.workspaces) || Array.isArray(manifest.workspaces?.packages)) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No workspace root found from ${start}`);
    current = parent;
  }
}

function workspacePatterns(manifest) {
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (!Array.isArray(patterns) || patterns.length === 0)
    throw new Error('Root package.json has no workspaces');
  return patterns;
}

async function expandPattern(root, pattern) {
  if (!pattern.endsWith('/*') || pattern.includes('**')) {
    throw new Error(`Unsupported workspace glob ${pattern}. MonoX currently supports directory/* patterns.`);
  }
  const parent = path.resolve(root, pattern.slice(0, -2));
  if (!(await exists(parent))) return [];
  const entries = await readdir(parent, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name));
}

export async function discoverWorkspaces(rootCandidate) {
  const root = rootCandidate ? path.resolve(rootCandidate) : await findWorkspaceRoot();
  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const directories = [];
  for (const pattern of workspacePatterns(rootManifest))
    directories.push(...(await expandPattern(root, pattern)));

  const workspaces = [];
  const names = new Set();
  for (const directory of directories.sort()) {
    const packagePath = path.join(directory, 'package.json');
    if (!(await exists(packagePath))) continue;
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    if (!manifest.name) throw new Error(`${path.relative(root, packagePath)} has no package name`);
    if (names.has(manifest.name)) throw new Error(`Duplicate workspace name: ${manifest.name}`);
    names.add(manifest.name);
    workspaces.push({
      name: manifest.name,
      location: path.relative(root, directory),
      directory,
      manifest,
    });
  }

  return { root, rootManifest, workspaces };
}

export function runnableWorkspaces(workspaces, script = 'dev') {
  return workspaces.filter((workspace) => typeof workspace.manifest.scripts?.[script] === 'string');
}
