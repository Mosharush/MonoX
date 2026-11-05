import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { changedPathsFromGit } from '@monox/affected';
import { discoverWorkspaces } from '@monox/workspaces';

export const TASK_GRAPH_SCHEMA_VERSION = '1';
export const DEFAULT_GRAPH_FILE = 'monox.tasks.json';
export const DEFAULT_CACHE_DIRECTORY = path.join('.monox', 'cache', 'tasks');
export const FULL_GATE_SCRIPT = 'check';

const documentKeys = new Set(['$schema', 'schemaVersion', 'tasks']);
const taskKeys = new Set(['dependsOn', 'inputs', 'outputs', 'env', 'cache']);
const taskNamePattern = /^[A-Za-z0-9:_-]{1,64}$/;
const dependencyPattern = /^\^?[A-Za-z0-9:_-]{1,64}$/;
const envNamePattern = /^[A-Z_][A-Z0-9_]*$/;
const segmentPattern = /^[A-Za-z0-9._@*-]+$/;
const ignoredDirectories = new Set(['.git', '.monox', 'node_modules']);
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function cacheKeyFor(material) {
  return sha256(canonicalJson(material));
}

function normalizeRelative(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function contained(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function repoRelative(root, value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  if (!contained(root, absolute)) return null;
  const relative = normalizeRelative(path.relative(root, absolute));
  return relative === '' ? null : relative;
}

export function matchGlob(glob, relativePath) {
  return matchParts(glob.split('/'), relativePath.split('/'));
}

function matchParts(globs, parts) {
  if (globs.length === 0) return parts.length === 0;
  if (globs[0] === '**') {
    if (matchParts(globs.slice(1), parts)) return true;
    if (parts.length === 0) return false;
    return matchParts(globs, parts.slice(1));
  }
  if (parts.length === 0) return false;
  if (!matchSegment(globs[0], parts[0])) return false;
  return matchParts(globs.slice(1), parts.slice(1));
}

function matchSegment(pattern, segment) {
  let expression = '^';
  for (const char of pattern) {
    expression += char === '*' ? '[^/]*' : char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${expression}$`, 'u').test(segment);
}

function validateGlob(glob) {
  if (typeof glob !== 'string' || glob.length === 0 || glob.length > 256) return 'must be a non-empty string';
  if (glob.includes('\\') || path.isAbsolute(glob)) return 'must be a workspace-relative posix glob';
  const segments = glob.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return 'must not contain empty, current, or parent segments';
  }
  for (const segment of segments) {
    if (segment === '**') continue;
    if (!segmentPattern.test(segment) || segment.includes('**')) return 'has an unsupported pattern';
  }
  return null;
}

function pushError(errors, message) {
  if (!errors.includes(message)) errors.push(message);
}

export function inspectTaskGraph(value) {
  const errors = [];
  if (!isObject(value)) {
    return { fatal: true, errors: ['task graph must be an object'], tasks: null };
  }
  for (const key of Object.keys(value)) {
    if (!documentKeys.has(key)) pushError(errors, `${key} is not a supported task-graph property`);
  }
  if (value.$schema !== undefined && (typeof value.$schema !== 'string' || value.$schema.length === 0)) {
    pushError(errors, '$schema must be a non-empty string');
  }
  if (value.schemaVersion !== TASK_GRAPH_SCHEMA_VERSION) {
    pushError(errors, 'schemaVersion must be 1');
  }
  if (!isObject(value.tasks) || Object.keys(value.tasks).length === 0) {
    pushError(errors, 'tasks must be an object with at least one task');
    return { fatal: true, errors, tasks: null };
  }

  const tasks = new Map();
  for (const name of Object.keys(value.tasks).sort()) {
    if (!taskNamePattern.test(name)) pushError(errors, `task name ${name} is invalid`);
    const definition = value.tasks[name];
    if (!isObject(definition)) {
      pushError(errors, `task ${name} must be an object`);
      continue;
    }
    for (const key of Object.keys(definition)) {
      if (!taskKeys.has(key)) pushError(errors, `task ${name}.${key} is not a supported property`);
    }
    const dependsOn = readStringList(errors, name, 'dependsOn', definition.dependsOn, false);
    const inputs = readStringList(errors, name, 'inputs', definition.inputs, true);
    const outputs = readStringList(errors, name, 'outputs', definition.outputs ?? [], false);
    const env = readStringList(errors, name, 'env', definition.env ?? [], false);
    if (definition.cache !== undefined && typeof definition.cache !== 'boolean') {
      pushError(errors, `task ${name}.cache must be a boolean`);
    }
    for (const glob of [...inputs, ...outputs]) {
      const problem = validateGlob(glob);
      if (problem) pushError(errors, `task ${name} glob ${glob} ${problem}`);
    }
    for (const pattern of inputs) {
      if (outputs.includes(pattern)) {
        pushError(errors, `task ${name} declares ${pattern} as both an input and an output`);
      }
    }
    for (const dependency of dependsOn) {
      if (!dependencyPattern.test(dependency)) {
        pushError(errors, `task ${name} dependsOn ${dependency} is invalid`);
        continue;
      }
      const target = dependency.startsWith('^') ? dependency.slice(1) : dependency;
      if (!Object.hasOwn(value.tasks, target)) {
        pushError(errors, `task ${name} dependsOn ${dependency} is not a defined task`);
      }
    }
    for (const variable of env) {
      if (!envNamePattern.test(variable)) pushError(errors, `task ${name} env ${variable} is invalid`);
    }
    tasks.set(name, {
      dependsOn,
      inputs,
      outputs,
      env,
      cache: definition.cache !== false,
    });
  }

  const fatal =
    errors.some(
      (error) =>
        error === 'schemaVersion must be 1' ||
        error.includes('is not a supported task-graph property') ||
        error === 'tasks must be an object with at least one task'
    ) || tasks.size === 0;
  return { fatal, errors, tasks: fatal ? null : tasks };
}

function readStringList(errors, task, field, value, required) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) {
    pushError(errors, `task ${task}.${field} must be an array`);
    return [];
  }
  if (required && value.length === 0)
    pushError(errors, `task ${task}.${field} must declare at least one glob`);
  const seen = new Set();
  const items = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      pushError(errors, `task ${task}.${field}[${index}] must be a non-empty string`);
      return;
    }
    if (seen.has(item)) pushError(errors, `task ${task}.${field} ${item} is duplicated`);
    seen.add(item);
    items.push(item);
  });
  return items;
}

function internalDependencyNames(workspace, names) {
  const declared = {};
  for (const field of dependencyFields) Object.assign(declared, workspace.manifest[field]);
  return Object.keys(declared)
    .filter((name) => names.has(name) && name !== workspace.name)
    .sort();
}

function findCycle(ids, dependencies) {
  const state = new Map();
  const stack = [];
  function visit(id) {
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (state.get(dependency) === 'visiting') {
        return [...stack.slice(stack.indexOf(dependency)), dependency];
      }
      if (!state.has(dependency)) {
        const found = visit(dependency);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  }
  for (const id of ids) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

function topologicalIds(ids, dependencies) {
  const indegree = new Map(ids.map((id) => [id, (dependencies.get(id) ?? []).length]));
  const dependents = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const dependency of dependencies.get(id) ?? []) dependents.get(dependency)?.push(id);
  }
  for (const list of dependents.values()) list.sort();
  const ready = ids.filter((id) => indegree.get(id) === 0).sort();
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  return ordered.length === ids.length ? ordered : null;
}

async function walkWorkspace(root, location) {
  const directory = path.join(root, location);
  const files = [];
  const symlinks = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelative(path.relative(root, absolute));
      if (entry.isSymbolicLink()) {
        symlinks.push(relative);
        continue;
      }
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push({ absolute, relative });
    }
  }
  await walk(directory);
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  symlinks.sort();
  return { files, symlinks };
}

async function inputRecords(root, location, globs, files) {
  const records = [];
  for (const glob of globs) {
    const matches = files.filter((file) => matchGlob(glob, workspaceRelative(location, file.relative)));
    if (matches.length === 0) {
      records.push({ glob, path: null, sha256: null });
      continue;
    }
    for (const match of matches) {
      records.push({ glob, path: match.relative, sha256: sha256(await readFile(match.absolute)) });
    }
  }
  return records;
}

function workspaceRelative(location, repoPath) {
  const prefix = `${normalizeRelative(location)}/`;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath;
}

function matchingChanged(location, globs, changedPaths) {
  const prefix = `${normalizeRelative(location)}/`;
  return changedPaths
    .filter(
      (changed) =>
        changed.startsWith(prefix) && globs.some((glob) => matchGlob(glob, changed.slice(prefix.length)))
    )
    .sort();
}

function pathCovered(nodes, changed) {
  for (const node of nodes.values()) {
    const prefix = `${node.location}/`;
    if (!changed.startsWith(prefix)) continue;
    const relative = changed.slice(prefix.length);
    if (node.inputGlobs.some((glob) => matchGlob(glob, relative))) return true;
    if (node.outputGlobs.some((glob) => matchGlob(glob, relative))) return true;
  }
  return false;
}

function hashEnv(name, env) {
  const value = env[name];
  return sha256(value === undefined ? '\0unset' : String(value));
}

async function readCache(cacheDirectory, material) {
  const cacheKey = cacheKeyFor(material);
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) return { hit: false, cacheKey, incomplete: true, outputs: [] };
  const directory = path.join(cacheDirectory, cacheKey);
  let text;
  try {
    text = await readFile(path.join(directory, 'manifest.json'), 'utf8');
  } catch (error) {
    return { hit: false, cacheKey, incomplete: error.code !== 'ENOENT', outputs: [] };
  }
  try {
    const manifest = JSON.parse(text);
    if (
      !isObject(manifest) ||
      manifest.schemaVersion !== TASK_GRAPH_SCHEMA_VERSION ||
      manifest.cacheKey !== cacheKey ||
      canonicalJson(manifest.keyMaterial) !== canonicalJson(material) ||
      !Array.isArray(manifest.outputs)
    ) {
      return { hit: false, cacheKey, incomplete: true, outputs: [] };
    }
    for (const relative of manifest.outputs) {
      if (typeof relative !== 'string' || relative.length === 0 || relative.split('/').includes('..')) {
        return { hit: false, cacheKey, incomplete: true, outputs: [] };
      }
      await access(path.join(directory, 'outputs', ...relative.split('/')));
    }
    return { hit: true, cacheKey, incomplete: false, outputs: manifest.outputs };
  } catch {
    return { hit: false, cacheKey, incomplete: true, outputs: [] };
  }
}

async function classifySelected(cacheDirectory, node, material, changedInputs, dependencyRuns, selectAll) {
  const parts = [];
  if (selectAll && changedInputs.length === 0 && dependencyRuns.length === 0) parts.push('selected by --all');
  if (changedInputs.length > 0) parts.push(`declared input changed: ${changedInputs.join(', ')}`);
  if (dependencyRuns.length > 0) parts.push(`dependency ${dependencyRuns.join(', ')} will run`);
  if (!node.cache) {
    parts.push('cache is disabled for this task');
    return { status: 'run', reason: parts.join('; '), cachedOutputs: [] };
  }
  const cached = await readCache(cacheDirectory, material);
  if (cached.hit) {
    parts.push(`local cache hit ${cached.cacheKey.slice(0, 12)}`);
    return { status: 'restore', reason: parts.join('; '), cachedOutputs: cached.outputs };
  }
  parts.push(
    cached.incomplete ? 'local cache entry is incomplete' : 'no local cache entry for the current inputs'
  );
  return { status: 'run', reason: parts.join('; '), cachedOutputs: [] };
}

function fullPlan(root, cacheDirectory, reason) {
  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    failOpen: true,
    execution: 'full',
    reason,
    cache: { mode: 'local', remote: false, dir: displayCacheDir(root, cacheDirectory) },
    tasks: [
      {
        id: '#repository',
        workspace: null,
        task: FULL_GATE_SCRIPT,
        location: '',
        script: null,
        dependencies: [],
        status: 'run',
        reason: `fail-open: ${reason}; run the full gate`,
        cache: false,
        cacheKey: null,
        keyMaterial: null,
        inputs: [],
        changedInputs: [],
        outputGlobs: [],
        cachedOutputs: [],
        env: [],
      },
    ],
  };
}

function failOpenTasks(nodes, order, reason) {
  return order.map((id) => {
    const node = nodes.get(id);
    return {
      ...publicNode(node),
      status: 'run',
      reason: `fail-open: ${reason}`,
      cache: false,
      cacheKey: null,
      keyMaterial: null,
      inputs: [],
      changedInputs: [],
      cachedOutputs: [],
      env: [],
    };
  });
}

function publicNode(node) {
  return {
    id: node.id,
    workspace: node.workspace,
    task: node.task,
    location: node.location,
    script: node.script,
    dependencies: node.dependencies,
    outputGlobs: node.outputGlobs,
  };
}

function displayCacheDir(root, cacheDirectory) {
  const relative = normalizeRelative(path.relative(root, cacheDirectory));
  return relative.startsWith('..') ? cacheDirectory : relative;
}

function detail(errors) {
  return [...new Set(errors)].sort().join('; ');
}

export async function planTaskGraph({
  root,
  workspaces,
  graph,
  changedPaths = [],
  selectAll = false,
  cacheDir,
  env = process.env,
  comparisonFailOpen = false,
  comparisonError = null,
} = {}) {
  const resolvedRoot = root ? path.resolve(root) : (await discoverWorkspaces()).root;
  const discovery = workspaces ? { root: resolvedRoot, workspaces } : await discoverWorkspaces(resolvedRoot);
  const cacheDirectory = cacheDir
    ? path.resolve(discovery.root, cacheDir)
    : path.join(discovery.root, DEFAULT_CACHE_DIRECTORY);
  const inspected = inspectTaskGraph(graph);
  if (inspected.fatal) return fullPlan(discovery.root, cacheDirectory, detail(inspected.errors));

  const names = new Set(discovery.workspaces.map((workspace) => workspace.name));
  const nodes = new Map();
  const dependencies = new Map();
  const errors = [...inspected.errors];

  for (const workspace of [...discovery.workspaces].sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const location = normalizeRelative(workspace.location);
    for (const [taskName, definition] of inspected.tasks) {
      const script = workspace.manifest.scripts?.[taskName];
      if (typeof script !== 'string') continue;
      const id = `${workspace.name}#${taskName}`;
      const edges = [];
      for (const dependency of definition.dependsOn) {
        const upstream = dependency.startsWith('^');
        const target = upstream ? dependency.slice(1) : dependency;
        if (upstream) {
          for (const dependencyName of internalDependencyNames(workspace, names)) {
            const dependencyId = `${dependencyName}#${target}`;
            const dependencyWorkspace = discovery.workspaces.find((item) => item.name === dependencyName);
            if (typeof dependencyWorkspace?.manifest.scripts?.[target] === 'string') edges.push(dependencyId);
          }
        } else if (typeof script === 'string') {
          const dependencyId = `${workspace.name}#${target}`;
          if (typeof workspace.manifest.scripts?.[target] !== 'string') {
            pushError(errors, `${id} depends on ${dependencyId}, which has no ${target} script`);
          } else edges.push(dependencyId);
        }
      }
      nodes.set(id, {
        id,
        workspace: workspace.name,
        task: taskName,
        location,
        script,
        dependencies: [...new Set(edges)].sort(),
        inputGlobs: definition.inputs,
        outputGlobs: definition.outputs,
        envNames: definition.env,
        cache: definition.cache,
        definition: {
          cache: definition.cache,
          dependsOn: definition.dependsOn,
          env: definition.env,
          inputs: definition.inputs,
          outputs: definition.outputs,
        },
      });
      dependencies.set(id, [...new Set(edges)].sort());
    }
  }

  for (const [taskName] of inspected.tasks) {
    const matched = [...nodes.values()].some((node) => node.task === taskName);
    if (!matched) pushError(errors, `task ${taskName} matches no workspace script`);
  }

  const walked = new Map();
  for (const node of nodes.values()) {
    if (walked.has(node.location)) continue;
    walked.set(node.location, await walkWorkspace(discovery.root, node.location));
  }
  for (const node of nodes.values()) {
    const listing = walked.get(node.location);
    for (const symlink of listing.symlinks) {
      const relative = workspaceRelative(node.location, symlink);
      if (node.inputGlobs.some((glob) => matchGlob(glob, relative))) {
        pushError(errors, `${node.id} input matches symlink ${symlink}`);
      }
    }
    const overlap = listing.files
      .map((file) => file.relative)
      .filter((relative) => {
        const local = workspaceRelative(node.location, relative);
        return (
          node.inputGlobs.some((glob) => matchGlob(glob, local)) &&
          node.outputGlobs.some((glob) => matchGlob(glob, local))
        );
      });
    for (const relative of overlap) pushError(errors, `${node.id} input and output both match ${relative}`);
  }

  const ids = [...nodes.keys()].sort();
  const cycle = findCycle(ids, dependencies);
  if (cycle) pushError(errors, `cycle: ${cycle.join(' -> ')}`);
  const ordered = topologicalIds(ids, dependencies) ?? ids;

  if (errors.length > 0 || nodes.size === 0) {
    if (nodes.size === 0) return fullPlan(discovery.root, cacheDirectory, detail(errors));
    return {
      schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
      failOpen: true,
      execution: 'all-tasks',
      reason: detail(errors),
      cache: { mode: 'local', remote: false, dir: displayCacheDir(discovery.root, cacheDirectory) },
      tasks: failOpenTasks(nodes, ordered, detail(errors)),
    };
  }

  if (comparisonFailOpen) {
    const reason = `git comparison failed (${comparisonError ?? 'unknown error'}); running every task`;
    return {
      schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
      failOpen: true,
      execution: 'all-tasks',
      reason,
      cache: { mode: 'local', remote: false, dir: displayCacheDir(discovery.root, cacheDirectory) },
      tasks: failOpenTasks(nodes, ordered, reason),
    };
  }

  const normalizedChanges = [];
  const outside = [];
  for (const changed of changedPaths) {
    const relative = repoRelative(discovery.root, changed);
    if (relative === null || relative === undefined) outside.push(String(changed));
    else normalizedChanges.push(relative);
  }
  if (!selectAll && outside.length > 0) {
    const reason = `changed path is outside the repository: ${[...new Set(outside)].sort().join(', ')}`;
    return {
      schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
      failOpen: true,
      execution: 'all-tasks',
      reason,
      cache: { mode: 'local', remote: false, dir: displayCacheDir(discovery.root, cacheDirectory) },
      tasks: failOpenTasks(nodes, ordered, reason),
    };
  }

  const uncovered = selectAll
    ? []
    : [...new Set(normalizedChanges)].filter((changed) => !pathCovered(nodes, changed)).sort();
  if (uncovered.length > 0) {
    const reason = `changed path is outside declared inputs and outputs: ${uncovered.join(', ')}`;
    return {
      schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
      failOpen: true,
      execution: 'all-tasks',
      reason,
      cache: { mode: 'local', remote: false, dir: displayCacheDir(discovery.root, cacheDirectory) },
      tasks: failOpenTasks(nodes, ordered, reason),
    };
  }

  const materials = new Map();
  const records = new Map();
  for (const id of ordered) {
    const node = nodes.get(id);
    const inputs = await inputRecords(
      discovery.root,
      node.location,
      node.inputGlobs,
      walked.get(node.location).files
    );
    records.set(id, inputs);
    materials.set(id, {
      schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
      taskId: id,
      script: node.script,
      definition: node.definition,
      inputs,
      dependencies: node.dependencies.map((dependencyId) => ({
        id: dependencyId,
        cacheKey: cacheKeyFor(materials.get(dependencyId)),
      })),
      env: node.envNames.map((name) => ({ name, sha256: hashEnv(name, env) })),
    });
  }

  const planned = new Map();
  const tasks = [];
  for (const id of ordered) {
    const node = nodes.get(id);
    const material = materials.get(id);
    const cacheKey = cacheKeyFor(material);
    const changedInputs = selectAll ? [] : matchingChanged(node.location, node.inputGlobs, normalizedChanges);
    const dependencyRuns = node.dependencies.filter(
      (dependencyId) => planned.get(dependencyId).status === 'run'
    );
    const selected = selectAll || changedInputs.length > 0 || dependencyRuns.length > 0;
    let status = 'skip';
    let reason = 'no declared input changed and no dependency is selected';
    let cachedOutputs = [];
    if (selected) {
      const decision = await classifySelected(
        cacheDirectory,
        node,
        material,
        changedInputs,
        dependencyRuns,
        selectAll
      );
      status = decision.status;
      reason = decision.reason;
      cachedOutputs = decision.cachedOutputs;
    } else if (node.cache && node.outputGlobs.length > 0) {
      const cached = await readCache(cacheDirectory, material);
      if (cached.hit) {
        const missing = [];
        for (const relative of cached.outputs) {
          try {
            await access(path.join(discovery.root, ...relative.split('/')));
          } catch {
            missing.push(relative);
          }
        }
        if (missing.length > 0) {
          status = 'restore';
          cachedOutputs = cached.outputs;
          reason = `declared output is missing: ${missing.join(', ')}; local cache hit ${cached.cacheKey.slice(0, 12)}`;
        }
      }
    }
    const task = {
      ...publicNode(node),
      status,
      reason,
      cache: node.cache,
      cacheKey,
      keyMaterial: material,
      inputs: records.get(id),
      changedInputs,
      cachedOutputs,
      env: material.env,
    };
    planned.set(id, task);
    tasks.push(task);
  }

  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    failOpen: false,
    execution: 'selective',
    reason: null,
    cache: { mode: 'local', remote: false, dir: displayCacheDir(discovery.root, cacheDirectory) },
    tasks,
  };
}

export function formatPlan(plan) {
  const lines = [
    `task-graph schemaVersion=${plan.schemaVersion} failOpen=${plan.failOpen} execution=${plan.execution}`,
  ];
  if (plan.reason) lines.push(`reason: ${plan.reason}`);
  lines.push(`cache: local ${plan.cache.dir}`);
  for (const task of plan.tasks) {
    lines.push(`${task.id} ${task.status} ${task.reason}`);
    if (task.cacheKey) lines.push(`  cacheKey: ${task.cacheKey}`);
    if (task.dependencies.length > 0) lines.push(`  dependsOn: ${task.dependencies.join(', ')}`);
    for (const input of task.inputs) {
      lines.push(`  input: ${input.glob} ${input.path ?? '(absent)'} ${input.sha256 ?? '-'}`);
    }
    if (task.env.length > 0) lines.push(`  env: ${task.env.map((item) => item.name).join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

async function outputFiles(root, node) {
  const listing = await walkWorkspace(root, node.location);
  return listing.files
    .map((file) => file.relative)
    .filter((relative) =>
      node.outputGlobs.some((glob) => matchGlob(glob, workspaceRelative(node.location, relative)))
    );
}

async function writeCache(root, cacheDirectory, task) {
  if (!/^[a-f0-9]{64}$/.test(task.cacheKey)) throw new Error(`Refusing to write cache key for ${task.id}`);
  const destination = path.join(cacheDirectory, task.cacheKey);
  if (!contained(cacheDirectory, destination)) throw new Error(`Cache path escaped for ${task.id}`);
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.join(destination, 'outputs'), { recursive: true });
  const outputs = await outputFiles(root, task);
  for (const relative of outputs) {
    const from = path.join(root, ...relative.split('/'));
    const to = path.join(destination, 'outputs', ...relative.split('/'));
    if (!contained(root, from) || !contained(destination, to)) {
      throw new Error(`Refusing to cache output outside ${task.id}: ${relative}`);
    }
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
  }
  const manifest = {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    taskId: task.id,
    cacheKey: task.cacheKey,
    keyMaterial: task.keyMaterial,
    outputs,
  };
  await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function restoreCache(root, cacheDirectory, task) {
  if (!/^[a-f0-9]{64}$/.test(task.cacheKey)) throw new Error(`Refusing to restore cache key for ${task.id}`);
  const source = path.join(cacheDirectory, task.cacheKey, 'outputs');
  for (const relative of task.cachedOutputs) {
    const from = path.join(source, ...relative.split('/'));
    const to = path.join(root, ...relative.split('/'));
    const workspace = path.join(root, ...task.location.split('/'));
    if (!contained(source, from) || !contained(workspace, to)) {
      throw new Error(`Refusing to restore output outside ${task.id}: ${relative}`);
    }
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
  }
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited ${code ?? 'null'}`));
    });
  });
}

async function defaultRunTask({ root, workspace, task }) {
  await runCommand('yarn', ['workspace', workspace, 'run', task], root);
}

async function defaultFullGate({ root, script }) {
  await runCommand('yarn', ['run', script], root);
}

export async function executePlan(plan, options = {}) {
  if (plan.failOpen && plan.tasks.some((task) => task.status === 'restore' || task.status === 'skip')) {
    throw new Error('Fail-open plans cannot skip or restore tasks');
  }
  const root = path.resolve(options.root);
  const cacheDirectory = options.cacheDir
    ? path.resolve(root, options.cacheDir)
    : path.resolve(root, plan.cache.dir);
  if (plan.execution === 'full') {
    const runFullGate = options.runFullGate ?? defaultFullGate;
    await runFullGate({ root, script: options.fullGateScript ?? FULL_GATE_SCRIPT });
    return { executed: [], restored: [], fullGate: true };
  }
  const runTask = options.runTask ?? defaultRunTask;
  const executed = [];
  const restored = [];
  for (const task of plan.tasks) {
    if (task.status === 'skip') continue;
    if (task.status === 'restore') {
      await restoreCache(root, cacheDirectory, task);
      restored.push(task.id);
      continue;
    }
    if (task.status !== 'run') throw new Error(`Unknown task status ${task.status}`);
    await runTask({
      root,
      id: task.id,
      workspace: task.workspace,
      task: task.task,
      location: task.location,
      script: task.script,
    });
    executed.push(task.id);
    if (!plan.failOpen && task.cache && task.cacheKey && task.keyMaterial) {
      await writeCache(root, cacheDirectory, task);
    }
  }
  return { executed, restored, fullGate: false };
}

export async function loadTaskGraph(file) {
  try {
    const text = await readFile(file, 'utf8');
    try {
      return { document: JSON.parse(text), error: null };
    } catch {
      return { document: null, error: 'task graph is not valid JSON' };
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { document: null, error: 'task graph file is missing' };
    return { document: null, error: 'task graph file cannot be read' };
  }
}

export async function planRepository({
  root = process.cwd(),
  graphPath = DEFAULT_GRAPH_FILE,
  base = 'origin/main',
  head = 'HEAD',
  changedPaths,
  selectAll = false,
  cacheDir,
  env = process.env,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const loaded = await loadTaskGraph(path.resolve(resolvedRoot, graphPath));
  let comparisonFailOpen = false;
  let comparisonError = null;
  let paths = changedPaths;
  if (selectAll) paths = [];
  else if (!paths) {
    const changes = changedPathsFromGit(resolvedRoot, base, head);
    paths = changes.paths;
    comparisonFailOpen = changes.failOpen;
    comparisonError = changes.error ?? null;
  }
  if (loaded.error) {
    const cacheDirectory = cacheDir
      ? path.resolve(resolvedRoot, cacheDir)
      : path.join(resolvedRoot, DEFAULT_CACHE_DIRECTORY);
    return fullPlan(resolvedRoot, cacheDirectory, loaded.error);
  }
  return planTaskGraph({
    root: resolvedRoot,
    graph: loaded.document,
    changedPaths: paths,
    selectAll,
    cacheDir,
    env,
    comparisonFailOpen,
    comparisonError,
  });
}
