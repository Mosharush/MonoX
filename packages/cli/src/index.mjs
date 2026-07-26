import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { affectedFromGit } from '@monox/affected';
import { createCoolifyCloudapter } from '@monox/cloudapter-coolify';
import { createKubernetesCloudapter } from '@monox/cloudapter-kubernetes';
import { createLocalCloudapter } from '@monox/cloudapter-local';
import { createPm2Cloudapter } from '@monox/cloudapter-pm2';
import { createStaticCloudapter } from '@monox/cloudapter-static';
import { createAwsProviderCloudapter } from '@monox/provider-aws';
import { createGcpProviderCloudapter } from '@monox/provider-gcp';

import {
  assertCloudapter,
  assertFreshPlan,
  deterministicDigest,
  redactSecrets,
} from '@monox/cloudapter-core';
import { discoverDeploymentWorkspaces, loadMonoXConfig, resolveProjectDeployments } from '@monox/config';
import { createLocalComposeExecutor } from './local-compose-executor.mjs';
import { migrateDeployment } from './migration.mjs';

const booleanFlags = new Set([
  'all',
  'affected',
  'json',
  'yes',
  'write',
  'redact-identifiers',
  'include-untracked',
]);

export function usage() {
  return [
    'Usage:',
    '  monox validate [--root <path>]',
    '  monox config explain <package> --env <environment> [--target <target>]',
    '  monox doctor --env <environment> [--target <target>]',
    '  monox plan --env <environment> --all|--select <ids>|--affected [--target <target>] [--output <file>]',
    '  monox render --env <environment> --target <target> --all|--select <ids>|--affected --output-dir <dir>',
    '  monox deploy --env <environment> --all|--select <ids>|--affected [--target <target>]',
    '  monox apply --plan <file>',
    '  monox status --env <environment> --target <target>',
    '  monox rollback --env <environment> --target <target> --revision <revision>',
    '  monox destroy --env <environment> --target <target> --confirm <project/environment/target>',
    '  monox cloud plan|setup|status|destroy --env <environment> --target <target>',
    '  monox migrate deployment --from monox-v1|legacy-production --input <file>|--root <path> [--output <file>] [--redact-identifiers] [--include-untracked] [--write]',
  ].join('\n');
}

export function parseArguments(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const separator = argument.indexOf('=');
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (!name) throw new TypeError('Empty option name');
    if (Object.hasOwn(flags, name)) throw new TypeError(`Option --${name} can be provided only once`);
    if (separator !== -1) {
      const value = argument.slice(separator + 1);
      if (!value) throw new TypeError(`--${name} requires a value`);
      flags[name] = value;
    } else if (booleanFlags.has(name)) flags[name] = true;
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new TypeError(`--${name} requires a value`);
      flags[name] = value;
      index += 1;
    }
  }
  return { positional, flags };
}

function requiredFlag(flags, name) {
  if (typeof flags[name] !== 'string' || !flags[name]) throw new TypeError(`--${name} is required`);
  return flags[name];
}

function assertAllowedFlags(flags, allowed) {
  const supported = new Set(allowed);
  const unknown = Object.keys(flags).filter((name) => !supported.has(name));
  if (unknown.length)
    throw new TypeError(`Unknown option(s): ${unknown.map((name) => `--${name}`).join(', ')}`);
}

function jsonWrite(stream, value) {
  stream.write(`${JSON.stringify(redactSecrets(value), null, 2)}\n`);
}

async function writeJson(file, value, io, options = {}) {
  const resolved = path.resolve(io.cwd, file);
  await io.mkdir(path.dirname(resolved), { recursive: true });
  await io.writeFile(resolved, `${JSON.stringify(redactSecrets(value), null, 2)}\n`, {
    encoding: 'utf8',
    flag: options.exclusive ? 'wx' : 'w',
  });
  return resolved;
}

function registryCandidate(registry, key) {
  if (!registry) return undefined;
  if (registry instanceof Map) return registry.get(key);
  return registry[key];
}

function builtInAdapter(target, scope) {
  if (scope === 'cloud' && target.provisioner === 'pulumi') {
    if (target.provider === 'aws') return createAwsProviderCloudapter();
    if (target.provider === 'gcp') return createGcpProviderCloudapter();
  }
  if (target.runtime === 'coolify' || target.transport === 'coolify-api') return createCoolifyCloudapter();
  if (target.runtime === 'kubernetes' || target.transport === 'kubernetes-api')
    return createKubernetesCloudapter();
  if (target.runtime === 'pm2') return createPm2Cloudapter();
  if (target.runtime === 'docker' && target.transport === 'local') return createLocalCloudapter();
  if (target.runtime === 'static') return createStaticCloudapter();
  return undefined;
}

async function adapterFor(target, options, scope = 'delivery') {
  if (typeof options.resolveAdapter === 'function') {
    const resolved = await options.resolveAdapter(target);
    if (resolved) return assertCloudapter(resolved);
  }
  for (const key of [target.id, `${target.provider}:${target.runtime}`, target.runtime]) {
    const candidate = registryCandidate(options.adapters, key);
    if (candidate)
      return assertCloudapter(typeof candidate === 'function' ? await candidate(target) : candidate);
  }
  const builtIn = builtInAdapter(target, scope);
  if (builtIn) return assertCloudapter(builtIn);
  throw new TypeError(
    `No ${scope} adapter is available for target ${target.id} ` +
      `(${target.provider}/${target.provisioner}/${target.transport}/${target.runtime})`
  );
}

function requireSelector(flags) {
  const selectors = ['all', 'select', 'affected'].filter((name) => flags[name] !== undefined);
  if (selectors.length !== 1)
    throw new TypeError('Exactly one workload selector is required: --all, --select, or --affected');
  return selectors[0];
}

async function selectWorkloads(workloads, flags, options, root) {
  const selector = requireSelector(flags);
  if (selector === 'all') return workloads;
  let selected;
  if (selector === 'affected') {
    if (typeof options.resolveAffected === 'function')
      selected = new Set(await options.resolveAffected({ root, base: flags.base, head: flags.head }));
    else {
      const affected = await affectedFromGit({
        root,
        base: flags.base ?? 'origin/main',
        head: flags.head ?? 'HEAD',
      });
      selected = new Set(affected.workspaces);
    }
  } else
    selected = new Set(
      String(flags.select)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    );
  if (selected.size === 0) throw new TypeError('The workload selector is empty');
  const result = workloads.filter(
    (workload) =>
      selected.has(workload.deployment.id) ||
      selected.has(workload.workspace.name) ||
      selected.has(workload.workspace.location)
  );
  const matched = new Set(
    result.flatMap((workload) => [
      workload.deployment.id,
      workload.workspace.name,
      workload.workspace.location,
    ])
  );
  const missing = [...selected].filter((item) => !matched.has(item));
  if (missing.length) throw new TypeError(`Unknown selected workload(s): ${missing.join(', ')}`);
  return result;
}

function groupByTarget(workloads) {
  const groups = new Map();
  for (const workload of workloads) {
    const current = groups.get(workload.target.id) ?? [];
    current.push(workload);
    groups.set(workload.target.id, current);
  }
  return groups;
}

const fallbackSourceIgnoredDirectories = new Set([
  '.git',
  '.monox',
  '.nx',
  '.venv',
  '.yarn',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
]);

function normalizeSourcePath(value) {
  return value.split(path.sep).join('/');
}

async function fallbackSourceFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && fallbackSourceIgnoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await fallbackSourceFiles(root, absolute)));
    else files.push(normalizeSourcePath(path.relative(root, absolute)));
  }
  return files;
}

function gitSourceFiles(root) {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate', '--', '.'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) return undefined;
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((file) => normalizeSourcePath(file))
    .filter((file) => file !== '.monox' && !file.startsWith('.monox/'));
}

function gitHead(root) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unborn-or-not-a-repository';
}

async function updateSourceHash(hash, root, relative) {
  const absolute = path.resolve(root, relative);
  const entry = await lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  hash.update(`${relative}\0`);
  if (!entry) {
    hash.update('deleted\0');
    return;
  }
  hash.update(`${entry.mode & 0o777}\0`);
  if (entry.isSymbolicLink()) {
    hash.update('symlink\0');
    hash.update(await readlink(absolute));
    hash.update('\0');
    return;
  }
  if (!entry.isFile()) throw new TypeError(`Source entry is not a regular file: ${relative}`);
  hash.update('file\0');
  hash.update(await readFile(absolute));
  hash.update('\0');
}

async function sourceTreeDigest(root, { exclude = [] } = {}) {
  const canonicalRoot = await realpath(root).catch(() => path.resolve(root));
  const exclusionPaths = await Promise.all(
    exclude.map(async (file) => {
      const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
      return realpath(absolute).catch(() => path.resolve(absolute));
    })
  );
  const exclusions = new Set(
    exclusionPaths.map((file) => normalizeSourcePath(path.relative(canonicalRoot, file)))
  );
  const fromGit = gitSourceFiles(canonicalRoot);
  const files = [...new Set(fromGit ?? (await fallbackSourceFiles(canonicalRoot)))].sort();
  const hash = createHash('sha256');
  hash.update(`monox-source-v1\0${gitHead(canonicalRoot)}\0`);
  for (const file of files) {
    if (exclusions.has(file)) continue;
    await updateSourceHash(hash, canonicalRoot, file);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function executionContext(project, target, workloads, adapter, options = {}) {
  const local =
    adapter.id === 'local' && target.transport === 'local' && target.runtime === 'docker'
      ? (options.runtimeOptions?.local ??
        (options.runtimeOptions?.createLocalComposeExecutor ?? createLocalComposeExecutor)({
          projectRoot: project.root,
          ...(options.runtimeOptions?.localComposeDependencies ?? {}),
        }))
      : undefined;
  const base = {
    projectRoot: project.root,
    config: project.config,
    environment: project.environment,
    target,
    workloads,
    ...(local ? { local } : {}),
  };
  const treeDigest = await sourceTreeDigest(project.root, { exclude: options.sourceExclusions ?? [] });
  const sourceDigest = deterministicDigest({
    config: project.config,
    environment: project.environment,
    target,
    workloads,
    treeDigest,
  });
  const status = await adapter.status({ ...base, sourceDigest });
  const targetStateDigest = deterministicDigest(redactSecrets(status));
  return { ...base, sourceDigest, targetStateDigest };
}

function productionGate(config, environment, target, env) {
  const selected = config.environments[environment];
  if (!selected?.production) return;
  if (!selected.protected) throw new TypeError(`Production environment ${environment} must be protected`);
  if (env.CI !== 'true') throw new TypeError('Production state changes require CI=true');
  if (!target.bindings?.identityRef)
    throw new TypeError('Production state changes require target.bindings.identityRef');
}

async function planGroups(project, workloads, options, scope = 'delivery', contextOptions = {}) {
  const plans = [];
  for (const [targetId, selected] of groupByTarget(workloads)) {
    const target = { id: targetId, ...project.config.targets[targetId] };
    const adapter = await adapterFor(target, options, scope);
    const context = await executionContext(project, target, selected, adapter, {
      ...contextOptions,
      runtimeOptions: options,
    });
    const validation = await adapter.validate(context);
    if (validation?.valid === false)
      throw new TypeError(
        `Adapter ${adapter.id} rejected the context:\n${(validation.errors ?? []).join('\n')}`
      );
    const plan = await adapter.plan(context);
    if (plan?.kind !== 'MonoXPlan') throw new TypeError(`Adapter ${adapter.id} returned an invalid plan`);
    plans.push({ adapter, context, plan });
  }
  return plans;
}

async function loadProject(flags, io) {
  const environment = requiredFlag(flags, 'env');
  return resolveProjectDeployments({
    root: flags.root ? path.resolve(io.cwd, flags.root) : io.cwd,
    environment,
    targetId: flags.target,
  });
}

async function validateCommand(flags, io) {
  const root = flags.root ? path.resolve(io.cwd, flags.root) : io.cwd;
  const loaded = await loadMonoXConfig(root);
  const discovered = await discoverDeploymentWorkspaces(root);
  const environmentResults = [];
  for (const environment of Object.keys(loaded.config.environments).sort()) {
    const resolved = await resolveProjectDeployments({ root, environment });
    environmentResults.push({ environment, workloads: resolved.workloads.length });
  }
  return {
    valid: true,
    config: loaded.file,
    deployments: discovered.deployments.length,
    environments: environmentResults,
  };
}

async function explainCommand(positional, flags, io) {
  if (positional[1] !== 'explain' || !positional[2]) throw new TypeError(usage());
  const project = await loadProject(flags, io);
  const candidate = positional[2];
  const matches = project.workloads.filter(
    (workload) =>
      workload.deployment.id === candidate ||
      workload.workspace.name === candidate ||
      workload.workspace.location === candidate
  );
  if (matches.length === 0) throw new TypeError(`Unknown deployable package: ${candidate}`);
  return {
    resolutionOrder: [
      'secure-defaults',
      'workload-profile',
      'package-base',
      'package-environment',
      'variant',
      'variant-environment',
      'target-binding',
    ],
    workloads: matches,
  };
}

async function doctorCommand(flags, io, options) {
  const project = await loadProject(flags, io);
  const results = [];
  for (const [targetId, workloads] of groupByTarget(project.workloads)) {
    const target = { id: targetId, ...project.config.targets[targetId] };
    const adapter = await adapterFor(target, options);
    const context = await executionContext(project, target, workloads, adapter, {
      runtimeOptions: options,
    });
    results.push({ target: targetId, adapter: adapter.id, ...(await adapter.doctor(context)) });
  }
  return { ok: results.every((result) => result.ok !== false), results };
}

async function planCommand(flags, io, options) {
  const project = await loadProject(flags, io);
  const workloads = await selectWorkloads(project.workloads, flags, options, project.root);
  if (workloads.length === 0) throw new TypeError('No workloads matched the selected target');
  const groups = await planGroups(project, workloads, options);
  const result = groups.map(({ plan }) => plan);
  if (flags.output)
    return {
      plans: result,
      output: await writeJson(flags.output, result.length === 1 ? result[0] : result, io, {
        exclusive: true,
      }),
    };
  return { plans: result };
}

function safeArtifactPath(outputDirectory, artifactPath) {
  const root = path.resolve(outputDirectory);
  const destination = path.resolve(root, artifactPath);
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`))
    throw new TypeError(`Artifact escapes output directory: ${artifactPath}`);
  return destination;
}

function stateSegment(value) {
  return String(value)
    .replaceAll(/[^a-zA-Z0-9._-]/g, '-')
    .replaceAll(/-+/g, '-')
    .slice(0, 120);
}

async function withTargetLock(project, target, io, operation) {
  const parent = path.join(project.root, '.monox', 'locks');
  const lock = path.join(parent, `${stateSegment(project.environment)}--${stateSegment(target.id)}.lock`);
  await io.mkdir(parent, { recursive: true });
  try {
    await io.mkdir(lock);
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new TypeError(
        `A state-changing operation already holds the lock for ${project.environment}/${target.id}`
      );
    throw error;
  }
  try {
    await io.writeFile(
      path.join(lock, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
    return await operation();
  } finally {
    await io.rm(lock, { recursive: true, force: true });
  }
}

async function persistReceipt(project, receipt, io) {
  if (receipt?.kind !== 'MonoXReceipt' || typeof receipt.digest !== 'string')
    throw new TypeError('Adapter returned an invalid MonoXReceipt');
  const directory = path.join(
    project.root,
    '.monox',
    'receipts',
    stateSegment(receipt.environment ?? project.environment),
    stateSegment(receipt.target?.id ?? 'unknown-target')
  );
  const timestamp = stateSegment(receipt.createdAt ?? new Date().toISOString());
  const operation = stateSegment(receipt.operation ?? 'apply');
  const digest = receipt.digest.replace(/^sha256:/, '').slice(0, 16);
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const file = path.join(directory, `${timestamp}-${operation}-${digest}${suffix}.json`);
    try {
      const written = await writeJson(file, receipt, io, { exclusive: true });
      return normalizeSourcePath(path.relative(project.root, written));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new TypeError('Could not reserve a unique receipt path after 100 attempts');
}

async function mutateWithReceipt(project, target, io, operation) {
  return withTargetLock(project, target, io, async () => {
    const receipt = await operation();
    const receiptFile = await persistReceipt(project, receipt, io);
    return { receipt, receiptFile };
  });
}

async function renderCommand(flags, io, options) {
  requiredFlag(flags, 'target');
  const outputDirectory = path.resolve(io.cwd, requiredFlag(flags, 'output-dir'));
  const existingOutput = await lstat(outputDirectory).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existingOutput) throw new TypeError(`Output directory already exists: ${outputDirectory}`);
  const project = await loadProject(flags, io);
  const workloads = await selectWorkloads(project.workloads, flags, options, project.root);
  if (workloads.length === 0) throw new TypeError('No workloads matched the selected target');
  const groups = await planGroups(project, workloads, options);
  const rendered = [];
  const files = [];
  const destinations = new Set();
  for (const group of groups) {
    const result = await group.adapter.render(group.plan, group.context);
    const artifacts = result?.artifacts ?? [];
    for (const artifact of artifacts) {
      const artifactPath = artifact.path ?? artifact.name;
      if (typeof artifactPath !== 'string' || !artifactPath || typeof artifact.content !== 'string')
        throw new TypeError(`Adapter ${group.adapter.id} returned an invalid artifact`);
      const destination = safeArtifactPath(outputDirectory, artifactPath);
      if (destinations.has(destination)) throw new TypeError(`Duplicate rendered artifact: ${artifactPath}`);
      destinations.add(destination);
      files.push({ artifactPath, content: artifact.content });
    }
    rendered.push({
      target: group.context.target.id,
      planDigest: group.plan.digest,
      ...result,
      artifacts: artifacts.map(({ content, ...artifact }) => {
        void content;
        return artifact;
      }),
    });
  }
  await io.mkdir(path.dirname(outputDirectory), { recursive: true });
  const staging = await io.mkdtemp(
    path.join(path.dirname(outputDirectory), `.${path.basename(outputDirectory) || 'monox-render'}.tmp-`)
  );
  try {
    for (const file of files) {
      const destination = safeArtifactPath(staging, file.artifactPath);
      await io.mkdir(path.dirname(destination), { recursive: true });
      await io.writeFile(destination, file.content, { encoding: 'utf8', flag: 'wx' });
    }
    await io.rename(staging, outputDirectory);
  } catch (error) {
    await io.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { outputDirectory, rendered };
}

async function deployCommand(flags, io, options) {
  const project = await loadProject(flags, io);
  const workloads = await selectWorkloads(project.workloads, flags, options, project.root);
  if (workloads.length === 0) throw new TypeError('No workloads matched the selected target');
  if (groupByTarget(workloads).size !== 1)
    throw new TypeError(
      'State-changing deploy supports exactly one target per invocation; pass --target and run each target independently'
    );
  const groups = await planGroups(project, workloads, options);
  const group = groups[0];
  productionGate(project.config, project.environment, group.context.target, io.env);
  const applied = await mutateWithReceipt(project, group.context.target, io, () =>
    group.adapter.apply(group.plan, group.context)
  );
  return { receipts: [applied.receipt], receiptFiles: [applied.receiptFile] };
}

async function applyCommand(flags, io, options) {
  const planFile = path.resolve(io.cwd, requiredFlag(flags, 'plan'));
  const plan = JSON.parse(await io.readFile(planFile, 'utf8'));
  if (plan?.kind !== 'MonoXPlan') throw new TypeError(`${planFile} is not a MonoXPlan`);
  const project = await resolveProjectDeployments({
    root: flags.root ? path.resolve(io.cwd, flags.root) : io.cwd,
    environment: plan.environment,
    targetId: plan.target?.id,
  });
  const plannedWorkloads = new Set(
    (plan.workloads ?? []).map(
      (workload) =>
        `${workload.workspace?.name ?? ''}\u0000${workload.variant ?? ''}\u0000${workload.deployment?.id ?? ''}`
    )
  );
  const selectedWorkloads = project.workloads.filter((workload) =>
    plannedWorkloads.has(
      `${workload.workspace.name}\u0000${workload.variant ?? ''}\u0000${workload.deployment.id}`
    )
  );
  if (selectedWorkloads.length !== plannedWorkloads.size)
    throw new TypeError('Plan references workloads that no longer resolve in this project');
  const target = { id: plan.target.id, ...project.config.targets[plan.target.id] };
  const adapter = await adapterFor(target, options);
  const context = await executionContext(project, target, selectedWorkloads, adapter, {
    sourceExclusions: [planFile],
    runtimeOptions: options,
  });
  assertFreshPlan(plan, {
    adapter,
    sourceDigest: context.sourceDigest,
    targetStateDigest: context.targetStateDigest,
  });
  productionGate(project.config, project.environment, target, io.env);
  return mutateWithReceipt(project, target, io, () => adapter.apply(plan, context));
}

async function statusCommand(flags, io, options) {
  const targetId = requiredFlag(flags, 'target');
  const project = await loadProject(flags, io);
  const target = { id: targetId, ...project.config.targets[targetId] };
  const adapter = await adapterFor(target, options);
  const context = await executionContext(project, target, project.workloads, adapter, {
    runtimeOptions: options,
  });
  return { status: await adapter.status(context) };
}

async function rollbackCommand(flags, io, options) {
  const targetId = requiredFlag(flags, 'target');
  const revision = requiredFlag(flags, 'revision');
  const project = await loadProject(flags, io);
  const target = { id: targetId, ...project.config.targets[targetId] };
  const adapter = await adapterFor(target, options);
  const context = await executionContext(project, target, project.workloads, adapter, {
    runtimeOptions: options,
  });
  productionGate(project.config, project.environment, target, io.env);
  return mutateWithReceipt(project, target, io, () => adapter.rollback({ revision }, context));
}

async function destroyCommand(flags, io, options, operation = 'destroy', scope = 'delivery') {
  const targetId = requiredFlag(flags, 'target');
  const project = await loadProject(flags, io);
  const target = { id: targetId, ...project.config.targets[targetId] };
  const expected = `${project.config.project.name}/${project.environment}/${target.id}`;
  if (requiredFlag(flags, 'confirm') !== expected)
    throw new TypeError(`Destructive confirmation must exactly equal ${expected}`);
  const adapter = await adapterFor(target, options, scope);
  const context = await executionContext(project, target, project.workloads, adapter, {
    runtimeOptions: options,
  });
  productionGate(project.config, project.environment, target, io.env);
  return mutateWithReceipt(project, target, io, () =>
    adapter.destroy({ operation, confirm: expected }, context)
  );
}

async function cloudCommand(positional, flags, io, options) {
  const action = positional[1];
  if (!['plan', 'setup', 'status', 'destroy'].includes(action)) throw new TypeError(usage());
  const targetId = requiredFlag(flags, 'target');
  if (action === 'destroy') return destroyCommand(flags, io, options, 'cloud-destroy', 'cloud');
  const project = await loadProject(flags, io);
  const target = { id: targetId, ...project.config.targets[targetId] };
  const adapter = await adapterFor(target, options, 'cloud');
  const context = await executionContext(project, target, project.workloads, adapter, {
    runtimeOptions: options,
  });
  if (action === 'status') return { status: await adapter.status(context) };
  const validation = await adapter.validate({ ...context, scope: 'cloud' });
  if (validation?.valid === false)
    throw new TypeError(
      `Adapter ${adapter.id} rejected the context:\n${(validation.errors ?? []).join('\n')}`
    );
  const plan = await adapter.plan({ ...context, scope: 'cloud' });
  if (plan?.kind !== 'MonoXPlan') throw new TypeError(`Adapter ${adapter.id} returned an invalid plan`);
  if (action === 'plan') return { plan };
  assertFreshPlan(plan, {
    adapter,
    sourceDigest: context.sourceDigest,
    targetStateDigest: context.targetStateDigest,
  });
  productionGate(project.config, project.environment, target, io.env);
  return mutateWithReceipt(project, target, io, () => adapter.apply(plan, { ...context, scope: 'cloud' }));
}

async function findDeploymentManifestsFromFilesystem(root, directory = root) {
  const ignored = new Set(['.git', '.yarn', 'coverage', 'dist', 'node_modules']);
  const manifests = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) manifests.push(...(await findDeploymentManifestsFromFilesystem(root, absolute)));
    else if (entry.isFile() && entry.name === 'package.json') {
      const manifest = JSON.parse(await readFile(absolute, 'utf8'));
      if (manifest.deployment && typeof manifest.deployment === 'object')
        manifests.push({ file: absolute, relative: path.relative(root, absolute), manifest });
    }
  }
  return manifests.sort((left, right) => left.relative.localeCompare(right.relative));
}

async function findTrackedDeploymentManifests(root) {
  const canonicalRoot = await realpath(root);
  const repository = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (repository.status !== 0) {
    throw new TypeError(
      'Tracked migration scan requires an accessible Git repository; pass --include-untracked for the explicit filesystem fallback'
    );
  }
  const repositoryRoot = path.resolve(repository.stdout.trim());
  const relativeRoot = path.relative(repositoryRoot, canonicalRoot).split(path.sep).join('/');
  if (relativeRoot.startsWith('..')) throw new TypeError(`${canonicalRoot} is outside its Git repository`);
  const prefix = relativeRoot ? `${relativeRoot}/` : '';
  const listed = spawnSync(
    'git',
    [
      '-C',
      repositoryRoot,
      'ls-files',
      '-z',
      '--',
      `${prefix}package.json`,
      `:(glob)${prefix}**/package.json`,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  if (listed.status !== 0)
    throw new TypeError(`Cannot list tracked package manifests: ${listed.stderr.trim() || 'git failed'}`);
  const manifests = [];
  for (const tracked of listed.stdout.split('\0').filter(Boolean).sort()) {
    const file = path.resolve(repositoryRoot, tracked);
    if (file !== canonicalRoot && !file.startsWith(`${canonicalRoot}${path.sep}`)) continue;
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    if (manifest.deployment && typeof manifest.deployment === 'object')
      manifests.push({ file, relative: path.relative(canonicalRoot, file), manifest });
  }
  return manifests;
}

async function findDeploymentManifests(root, { includeUntracked = false } = {}) {
  return includeUntracked
    ? findDeploymentManifestsFromFilesystem(root)
    : findTrackedDeploymentManifests(root);
}

function sanitizeMigrationFragment(fragment, { full = false } = {}) {
  const sanitized = structuredClone(fragment);
  if (sanitized.labels) sanitized.labels = {};
  if (sanitized.build) {
    delete sanitized.build.image;
    delete sanitized.build.script;
    if (sanitized.build.context) sanitized.build.context = '.';
    if (sanitized.build.dockerfile) sanitized.build.dockerfile = 'Dockerfile';
    if (sanitized.build.output) sanitized.build.output = 'dist';
  }
  if (sanitized.runtime) {
    delete sanitized.runtime.framework;
    delete sanitized.runtime.workingDirectory;
    delete sanitized.runtime.tuning;
    if (sanitized.runtime.command)
      sanitized.runtime.command =
        sanitized.runtime.language === 'python' ? ['python', '-m', 'app'] : ['node', '.'];
  }
  for (const route of sanitized.network?.routes ?? []) {
    delete route.host;
    delete route.tlsSecretRef;
    route.path = '/';
  }
  for (const [name, probe] of Object.entries(sanitized.probes ?? {})) {
    if (probe.path) probe.path = name === 'readiness' ? '/readyz' : '/healthz';
    if (probe.command) probe.command = ['true'];
  }
  if (sanitized.env) sanitized.env = { values: {}, secretRefs: [] };
  if (sanitized.identity) sanitized.identity = { automountServiceAccountToken: false };
  if (sanitized.storage) sanitized.storage = [];
  if (sanitized.adapterOverrides) sanitized.adapterOverrides = {};
  if (sanitized.lifecycle?.preStopCommand) sanitized.lifecycle.preStopCommand = [];
  if (sanitized.resources?.accelerators)
    sanitized.resources.accelerators = sanitized.resources.accelerators.map((accelerator) => ({
      type: accelerator.type,
      count: accelerator.count,
    }));
  if (sanitized.telemetry?.metrics?.path) sanitized.telemetry.metrics.path = '/metrics';
  for (const [metricIndex, metric] of (sanitized.scaling?.metrics ?? []).entries()) {
    if (metric.sourceRef) metric.sourceRef = `metric-source-${metricIndex + 1}`;
    if (metric.authenticationRef) metric.authenticationRef = `metric-auth-${metricIndex + 1}`;
    for (const key of ['query', 'route', 'queue', 'topic', 'stream', 'consumerGroup', 'metricName']) {
      if (metric[key]) metric[key] = 'example';
    }
    if (metric.metadata) metric.metadata = {};
  }
  sanitized.environments = Object.fromEntries(
    Object.values(sanitized.environments ?? {}).map((patch, environmentIndex) => [
      `environment-${String(environmentIndex + 1).padStart(3, '0')}`,
      sanitizeMigrationFragment(patch),
    ])
  );
  if (!full) {
    for (const key of ['schemaVersion', 'enabled', 'id', 'kind', 'profile', 'variants'])
      delete sanitized[key];
  }
  return sanitized;
}

function sanitizeMigrationReport(report, index) {
  const sanitized = structuredClone(report);
  const workload = `workload-${String(index + 1).padStart(3, '0')}`;
  sanitized.output = sanitizeMigrationFragment(sanitized.output, { full: true });
  sanitized.output.id = workload;
  sanitized.output.variants = Object.fromEntries(
    Object.values(report.output.variants ?? {}).map((variant, variantIndex) => [
      `variant-${String(variantIndex + 1).padStart(3, '0')}`,
      sanitizeMigrationFragment(variant),
    ])
  );
  sanitized.inputSummary.keys = [];
  sanitized.manualReview = sanitized.manualReview.map((finding) => ({
    ...finding,
    path: '$.[redacted]',
  }));
  return sanitized;
}

async function migrateCommand(positional, flags, io) {
  if (positional[1] !== 'deployment') throw new TypeError(usage());
  const from = requiredFlag(flags, 'from');
  const hasInput = typeof flags.input === 'string';
  const hasRoot = typeof flags.root === 'string';
  if (hasInput === hasRoot) throw new TypeError('Exactly one of --input or --root is required');
  if (flags.write && !hasRoot) throw new TypeError('--write is supported only with --root');
  if (hasInput && flags['include-untracked'])
    throw new TypeError('--include-untracked is supported only with --root');
  if (flags.write && flags['redact-identifiers'])
    throw new TypeError('--write cannot be combined with --redact-identifiers');

  if (hasInput) {
    const inputFile = path.resolve(io.cwd, flags.input);
    const input = JSON.parse(await io.readFile(inputFile, 'utf8'));
    const fullReport = migrateDeployment(input, { from });
    const report = flags['redact-identifiers'] ? sanitizeMigrationReport(fullReport, 0) : fullReport;
    if (flags.output) return { report, output: await writeJson(flags.output, report, io) };
    return { report };
  }

  const migrationRoot = path.resolve(io.cwd, flags.root);
  const manifests = await findDeploymentManifests(migrationRoot, {
    includeUntracked: flags['include-untracked'] === true,
  });
  const entries = manifests.map((item, index) => {
    const fullReport = migrateDeployment(item.manifest.deployment, {
      from,
      id: item.manifest.name,
    });
    return {
      file: flags['redact-identifiers']
        ? `workspace-${String(index + 1).padStart(3, '0')}/package.json`
        : item.relative,
      report: flags['redact-identifiers'] ? sanitizeMigrationReport(fullReport, index) : fullReport,
      source: item,
    };
  });
  const manualReviewCount = entries.reduce((count, entry) => count + entry.report.manualReview.length, 0);
  const aggregate = {
    schemaVersion: '1',
    kind: 'MonoXMigrationInventory',
    sourceFormat: from,
    root: flags['redact-identifiers'] ? '[REDACTED]' : migrationRoot,
    summary: {
      deploymentBlocks: entries.length,
      readyToWrite: entries.filter((entry) => entry.report.manualReview.length === 0).length,
      manualReview: manualReviewCount,
      redactedIdentifiers: Boolean(flags['redact-identifiers']),
      trackedOnly: flags['include-untracked'] !== true,
    },
    entries: entries.map(({ file, report }) => ({ file, report })),
  };
  if (flags.write) {
    if (manualReviewCount > 0)
      throw new TypeError(
        `Migration write refused: ${manualReviewCount} manual-review or security finding(s) remain`
      );
    for (const entry of entries) {
      const manifest = structuredClone(entry.source.manifest);
      manifest.deployment = entry.report.output;
      await io.writeFile(entry.source.file, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'w',
      });
    }
    aggregate.summary.written = entries.length;
  }
  if (flags.output) return { report: aggregate, output: await writeJson(flags.output, aggregate, io) };
  return { report: aggregate };
}

export async function run(argv, overrides = {}, options = {}) {
  const io = {
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    readFile: overrides.readFile ?? readFile,
    writeFile: overrides.writeFile ?? writeFile,
    mkdir: overrides.mkdir ?? mkdir,
    mkdtemp: overrides.mkdtemp ?? mkdtemp,
    rename: overrides.rename ?? rename,
    rm: overrides.rm ?? rm,
  };
  const { positional, flags } = parseArguments(argv);
  const command = positional[0];
  let result;
  if (command === 'validate') {
    assertAllowedFlags(flags, ['root', 'json']);
    result = await validateCommand(flags, io);
  } else if (command === 'config') {
    assertAllowedFlags(flags, ['env', 'target', 'root', 'json']);
    result = await explainCommand(positional, flags, io);
  } else if (command === 'doctor') {
    assertAllowedFlags(flags, ['env', 'target', 'root', 'json']);
    result = await doctorCommand(flags, io, options);
  } else if (command === 'plan') {
    assertAllowedFlags(flags, [
      'env',
      'target',
      'root',
      'all',
      'select',
      'affected',
      'base',
      'head',
      'output',
      'json',
    ]);
    result = await planCommand(flags, io, options);
  } else if (command === 'render') {
    assertAllowedFlags(flags, [
      'env',
      'target',
      'root',
      'all',
      'select',
      'affected',
      'base',
      'head',
      'output-dir',
      'json',
    ]);
    result = await renderCommand(flags, io, options);
  } else if (command === 'deploy') {
    assertAllowedFlags(flags, ['env', 'target', 'root', 'all', 'select', 'affected', 'base', 'head', 'json']);
    result = await deployCommand(flags, io, options);
  } else if (command === 'apply') {
    assertAllowedFlags(flags, ['plan', 'root', 'json']);
    result = await applyCommand(flags, io, options);
  } else if (command === 'status') {
    assertAllowedFlags(flags, ['env', 'target', 'root', 'json']);
    result = await statusCommand(flags, io, options);
  } else if (command === 'rollback') {
    assertAllowedFlags(flags, ['env', 'target', 'root', 'revision', 'json']);
    result = await rollbackCommand(flags, io, options);
  } else if (command === 'destroy') {
    assertAllowedFlags(flags, ['env', 'target', 'root', 'confirm', 'json']);
    result = await destroyCommand(flags, io, options);
  } else if (command === 'cloud') {
    assertAllowedFlags(flags, ['env', 'target', 'root', 'confirm', 'json']);
    result = await cloudCommand(positional, flags, io, options);
  } else if (command === 'migrate') {
    assertAllowedFlags(flags, [
      'from',
      'input',
      'root',
      'output',
      'redact-identifiers',
      'include-untracked',
      'write',
      'json',
    ]);
    result = await migrateCommand(positional, flags, io);
  } else throw new TypeError(usage());
  jsonWrite(io.stdout, result);
  return result;
}

export { migrateDeployment, migrateLegacyDeployment, migrateV1Deployment } from './migration.mjs';
export { createLocalComposeExecutor } from './local-compose-executor.mjs';
