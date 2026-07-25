import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  containsSecretMaterial,
  DeploymentV2ValidationError,
  assertValidDeploymentSpecV2,
  isSecretLikeKey,
  normalizeDeploymentSpecV2,
  validateDeploymentPatchV2,
  validateDeploymentSpecV2,
} from '@monox/deploy-schema';
import { discoverWorkspaces, findWorkspaceRoot } from '@monox/workspaces';

export const MONOX_CONFIG_SCHEMA_VERSION = '2';

const idPattern = /^[a-z][a-z0-9-]{0,62}$/;
const recipePattern = /^(?:[a-z][a-z0-9-]{0,62}|@[a-z0-9][a-z0-9-]*\/[a-z][a-z0-9-]*)$/;

const axes = Object.freeze({
  provider: ['generic', 'aws', 'gcp'],
  provisioner: ['none', 'pulumi'],
  transport: ['local', 'ssh', 'aws-ssm', 'gcp-iap', 'coolify-api', 'kubernetes-api'],
  runtime: ['pm2', 'docker', 'coolify', 'kubernetes', 'static'],
});

const allowed = Object.freeze({
  root: [
    '$schema',
    'schemaVersion',
    'project',
    'boundaries',
    'workloadProfiles',
    'environments',
    'targets',
    'addons',
  ],
  project: ['name', 'workspaceGlobs', 'defaultEnvironment'],
  environment: ['production', 'protected', 'bindings'],
  binding: ['target', 'selector'],
  selector: ['workloads', 'kinds', 'profiles', 'locations', 'variants'],
  target: [
    'provider',
    'provisioner',
    'transport',
    'runtime',
    'bindings',
    'region',
    'projectRef',
    'serverRef',
    'clusterRef',
    'ttlHours',
  ],
  targetBindings: ['namespace', 'registry', 'domain', 'identityRef', 'secretStoreRef'],
  addon: ['recipe', 'enabled', 'mode', 'environments', 'config', 'secretRefs'],
});

export class MonoXConfigValidationError extends TypeError {
  constructor(errors) {
    super(
      `Invalid MonoX v2 project configuration:\n${errors
        .map((error) => `- ${error.path}: ${error.message}`)
        .join('\n')}`
    );
    this.name = 'MonoXConfigValidationError';
    this.errors = errors;
  }
}

export class TargetBindingError extends TypeError {
  constructor(workload, environment, matches) {
    const suffix = matches.length === 0 ? 'no targets' : `multiple targets: ${matches.join(', ')}`;
    super(`Workload ${workload} in ${environment} matches ${suffix}`);
    this.name = 'TargetBindingError';
    this.workload = workload;
    this.environment = environment;
    this.matches = matches;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function addError(errors, pathName, message, code = 'invalid') {
  errors.push({ path: pathName, message, code });
}

function strictObject(errors, pathName, value, keys, required = []) {
  if (!object(value)) {
    addError(errors, pathName, 'must be an object', 'type');
    return false;
  }
  const supported = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!supported.has(key)) addError(errors, `${pathName}.${key}`, 'is not a supported property', 'unknown');
  }
  for (const key of required) {
    if (value[key] === undefined) addError(errors, `${pathName}.${key}`, 'is required', 'required');
  }
  return true;
}

function checkString(errors, pathName, value, pattern, required = true) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || value.length === 0) {
    addError(errors, pathName, 'must be a non-empty string', 'type');
    return;
  }
  if (pattern && !pattern.test(value)) addError(errors, pathName, 'has an invalid format', 'format');
  if (containsSecretMaterial(value))
    addError(errors, pathName, 'must not contain credential material', 'security');
}

function checkBoolean(errors, pathName, value, required = true) {
  if (value === undefined && !required) return;
  if (typeof value !== 'boolean') addError(errors, pathName, 'must be a boolean', 'type');
}

function checkInteger(errors, pathName, value, minimum, maximum, required = true) {
  if (value === undefined && !required) return;
  if (!Number.isInteger(value)) addError(errors, pathName, 'must be an integer', 'type');
  else if (value < minimum || value > maximum)
    addError(errors, pathName, `must be between ${minimum} and ${maximum}`, 'range');
}

function checkStringArray(errors, pathName, value, options = {}) {
  if (value === undefined && options.required === false) return;
  if (!Array.isArray(value)) {
    addError(errors, pathName, 'must be an array', 'type');
    return;
  }
  if (options.minItems && value.length < options.minItems)
    addError(errors, pathName, `must contain at least ${options.minItems} item(s)`, 'length');
  const seen = new Set();
  value.forEach((item, index) => {
    checkString(errors, `${pathName}[${index}]`, item, options.pattern);
    if (seen.has(item)) addError(errors, `${pathName}[${index}]`, 'must be unique', 'duplicate');
    seen.add(item);
  });
}

function checkStringMap(errors, pathName, value, options = {}) {
  if (value === undefined && options.required === false) return;
  if (!object(value)) {
    addError(errors, pathName, 'must be an object containing string values', 'type');
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    checkString(errors, `${pathName}.${key}`, item);
    if (options.rejectSecrets && isSecretLikeKey(key))
      addError(errors, `${pathName}.${key}`, 'secret-like values must use secretRefs', 'security');
  }
}

function validateSelector(errors, selector, pathName) {
  if (!strictObject(errors, pathName, selector, allowed.selector)) return;
  checkStringArray(errors, `${pathName}.workloads`, selector.workloads, { required: false });
  checkStringArray(errors, `${pathName}.kinds`, selector.kinds, {
    required: false,
    pattern: /^(?:service|worker|cron|job|model|static)$/,
  });
  checkStringArray(errors, `${pathName}.profiles`, selector.profiles, {
    required: false,
    pattern: idPattern,
  });
  checkStringArray(errors, `${pathName}.locations`, selector.locations, { required: false });
  checkStringArray(errors, `${pathName}.variants`, selector.variants, { required: false });
}

function validateEnvironment(errors, environment, pathName, targets) {
  if (!strictObject(errors, pathName, environment, allowed.environment, ['bindings'])) return;
  checkBoolean(errors, `${pathName}.production`, environment.production, false);
  checkBoolean(errors, `${pathName}.protected`, environment.protected, false);
  if (environment.production && environment.protected !== true)
    addError(errors, `${pathName}.protected`, 'must be true for a production environment', 'security');
  if (!Array.isArray(environment.bindings) || environment.bindings.length === 0) {
    addError(errors, `${pathName}.bindings`, 'must contain at least one target binding', 'required');
    return;
  }
  environment.bindings.forEach((binding, index) => {
    const bindingPath = `${pathName}.bindings[${index}]`;
    if (!strictObject(errors, bindingPath, binding, allowed.binding, ['target', 'selector'])) return;
    checkString(errors, `${bindingPath}.target`, binding.target, idPattern);
    validateSelector(errors, binding.selector, `${bindingPath}.selector`);
    if (typeof binding.target === 'string' && !Object.hasOwn(targets, binding.target))
      addError(errors, `${bindingPath}.target`, 'references an unknown target', 'reference');
  });
}

function validateTarget(errors, target, pathName) {
  if (
    !strictObject(errors, pathName, target, allowed.target, [
      'provider',
      'provisioner',
      'transport',
      'runtime',
    ])
  )
    return;
  for (const [axis, values] of Object.entries(axes)) {
    if (!values.includes(target[axis]))
      addError(errors, `${pathName}.${axis}`, `must be one of: ${values.join(', ')}`, 'enum');
  }
  if (target.bindings !== undefined) {
    if (strictObject(errors, `${pathName}.bindings`, target.bindings, allowed.targetBindings)) {
      for (const key of allowed.targetBindings)
        checkString(errors, `${pathName}.bindings.${key}`, target.bindings[key], undefined, false);
    }
  }
  for (const key of ['region', 'projectRef', 'serverRef', 'clusterRef'])
    checkString(errors, `${pathName}.${key}`, target[key], undefined, false);
  checkInteger(errors, `${pathName}.ttlHours`, target.ttlHours, 1, 720, false);
  if (target.provider === 'aws' && target.transport === 'gcp-iap')
    addError(errors, `${pathName}.transport`, 'gcp-iap cannot be used with aws', 'conflict');
  if (target.provider === 'gcp' && target.transport === 'aws-ssm')
    addError(errors, `${pathName}.transport`, 'aws-ssm cannot be used with gcp', 'conflict');
  if (target.transport === 'coolify-api' && target.runtime !== 'coolify')
    addError(errors, `${pathName}.runtime`, 'must be coolify for coolify-api transport', 'conflict');
  if (target.transport === 'kubernetes-api' && target.runtime !== 'kubernetes')
    addError(errors, `${pathName}.runtime`, 'must be kubernetes for kubernetes-api transport', 'conflict');
  if (target.transport === 'aws-ssm' && target.provider !== 'aws')
    addError(errors, `${pathName}.provider`, 'must be aws for aws-ssm transport', 'conflict');
  if (target.transport === 'gcp-iap' && target.provider !== 'gcp')
    addError(errors, `${pathName}.provider`, 'must be gcp for gcp-iap transport', 'conflict');
  if (target.provisioner === 'pulumi' && !['aws', 'gcp'].includes(target.provider))
    addError(errors, `${pathName}.provider`, 'Pulumi targets must use aws or gcp', 'conflict');
}

function validateAddon(errors, addon, pathName, environments) {
  if (!strictObject(errors, pathName, addon, allowed.addon, ['recipe', 'enabled', 'mode'])) return;
  checkString(errors, `${pathName}.recipe`, addon.recipe, recipePattern);
  checkBoolean(errors, `${pathName}.enabled`, addon.enabled);
  if (!['bundled', 'managed', 'external'].includes(addon.mode))
    addError(errors, `${pathName}.mode`, 'must be bundled, managed, or external', 'enum');
  checkStringArray(errors, `${pathName}.environments`, addon.environments, {
    required: false,
    pattern: idPattern,
  });
  for (const environment of addon.environments ?? []) {
    if (!Object.hasOwn(environments, environment))
      addError(
        errors,
        `${pathName}.environments`,
        `references unknown environment ${environment}`,
        'reference'
      );
  }
  checkStringMap(errors, `${pathName}.config`, addon.config, {
    required: false,
    rejectSecrets: true,
  });
  checkStringArray(errors, `${pathName}.secretRefs`, addon.secretRefs, {
    required: false,
    pattern: idPattern,
  });
}

export function validateMonoXConfigV2(input) {
  const value = clone(input);
  const errors = [];
  if (
    !strictObject(errors, '$', value, allowed.root, [
      'schemaVersion',
      'project',
      'boundaries',
      'workloadProfiles',
      'environments',
      'targets',
      'addons',
    ])
  )
    return { valid: false, errors, value };
  if (value.schemaVersion !== MONOX_CONFIG_SCHEMA_VERSION)
    addError(errors, '$.schemaVersion', `must equal ${MONOX_CONFIG_SCHEMA_VERSION}`, 'version');
  if (strictObject(errors, '$.project', value.project, allowed.project, ['name', 'workspaceGlobs'])) {
    checkString(errors, '$.project.name', value.project.name, idPattern);
    checkStringArray(errors, '$.project.workspaceGlobs', value.project.workspaceGlobs, { minItems: 1 });
    checkString(errors, '$.project.defaultEnvironment', value.project.defaultEnvironment, idPattern, false);
  }
  if (!object(value.boundaries)) addError(errors, '$.boundaries', 'must be an object', 'type');
  else {
    for (const [name, dependencies] of Object.entries(value.boundaries)) {
      checkString(errors, `$.boundaries.${name}`, name, idPattern);
      checkStringArray(errors, `$.boundaries.${name}`, dependencies);
    }
  }
  if (!object(value.workloadProfiles)) addError(errors, '$.workloadProfiles', 'must be an object', 'type');
  else {
    for (const [name, profile] of Object.entries(value.workloadProfiles)) {
      checkString(errors, `$.workloadProfiles.${name}`, name, idPattern);
      const result = validateDeploymentPatchV2(profile);
      for (const issue of result.errors)
        addError(errors, `$.workloadProfiles.${name}${issue.path.slice(1)}`, issue.message, issue.code);
    }
  }
  if (!object(value.targets) || Object.keys(value.targets).length === 0)
    addError(errors, '$.targets', 'must contain at least one target', 'required');
  else {
    for (const [name, target] of Object.entries(value.targets)) {
      checkString(errors, `$.targets.${name}`, name, idPattern);
      validateTarget(errors, target, `$.targets.${name}`);
    }
  }
  if (!object(value.environments) || Object.keys(value.environments).length === 0)
    addError(errors, '$.environments', 'must contain at least one environment', 'required');
  else {
    for (const [name, environment] of Object.entries(value.environments)) {
      checkString(errors, `$.environments.${name}`, name, idPattern);
      validateEnvironment(errors, environment, `$.environments.${name}`, value.targets ?? {});
    }
  }
  if (
    value.project?.defaultEnvironment &&
    !Object.hasOwn(value.environments ?? {}, value.project.defaultEnvironment)
  )
    addError(errors, '$.project.defaultEnvironment', 'references an unknown environment', 'reference');
  if (!object(value.addons)) addError(errors, '$.addons', 'must be an object', 'type');
  else {
    for (const [name, addon] of Object.entries(value.addons)) {
      checkString(errors, `$.addons.${name}`, name, idPattern);
      validateAddon(errors, addon, `$.addons.${name}`, value.environments ?? {});
    }
  }
  return { valid: errors.length === 0, errors, value };
}

export function assertValidMonoXConfigV2(input) {
  const result = validateMonoXConfigV2(input);
  if (!result.valid) throw new MonoXConfigValidationError(result.errors);
  return result.value;
}

export function applyMergePatch(target, patch) {
  if (!object(patch)) return clone(patch);
  const result = object(target) ? clone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (object(value)) result[key] = applyMergePatch(result[key], value);
    else result[key] = clone(value);
  }
  return result;
}

function without(objectValue, keys) {
  return Object.fromEntries(Object.entries(objectValue ?? {}).filter(([key]) => !keys.includes(key)));
}

function assertIdentityUnchanged(before, after, patchPath) {
  const checks = [
    ['id', before.id, after.id],
    ['kind', before.kind, after.kind],
    ['build.strategy', before.build?.strategy, after.build?.strategy],
    ['runtime.language', before.runtime?.language, after.runtime?.language],
  ];
  const changed = checks.filter(([, initial, final]) => initial !== final).map(([name]) => name);
  if (changed.length)
    throw new DeploymentV2ValidationError(
      changed.map((name) => ({
        path: `${patchPath}.${name}`,
        message: 'cannot be changed by an overlay',
        code: 'immutable',
      }))
    );
}

export function resolveDeploymentSpecV2(rawDeployment, config, environment, variant = null) {
  if (!Object.hasOwn(config.environments, environment))
    throw new MonoXConfigValidationError([
      { path: `$.environments.${environment}`, message: 'is not configured', code: 'reference' },
    ]);
  const rawResult = validateDeploymentSpecV2(rawDeployment);
  if (!rawResult.valid) throw new DeploymentV2ValidationError(rawResult.errors);

  const initial = normalizeDeploymentSpecV2({
    schemaVersion: '2',
    enabled: rawDeployment.enabled,
    id: rawDeployment.id,
    kind: rawDeployment.kind,
    build: rawDeployment.build,
    runtime: rawDeployment.runtime,
  });
  let resolved = initial;
  if (rawDeployment.profile) {
    const profile = config.workloadProfiles[rawDeployment.profile];
    if (!profile)
      throw new MonoXConfigValidationError([
        {
          path: `$.workloadProfiles.${rawDeployment.profile}`,
          message: `is required by workload ${rawDeployment.id}`,
          code: 'reference',
        },
      ]);
    resolved = applyMergePatch(resolved, profile);
    assertIdentityUnchanged(initial, resolved, `$.workloadProfiles.${rawDeployment.profile}`);
  }
  resolved = applyMergePatch(
    resolved,
    without(rawDeployment, ['$schema', 'profile', 'variants', 'environments'])
  );
  const packageIdentity = clone(resolved);
  if (rawDeployment.environments?.[environment]) {
    resolved = applyMergePatch(resolved, rawDeployment.environments[environment]);
    assertIdentityUnchanged(packageIdentity, resolved, `$.environments.${environment}`);
  }
  if (variant !== null) {
    const variantPatch = rawDeployment.variants?.[variant];
    if (!variantPatch)
      throw new DeploymentV2ValidationError([
        {
          path: `$.variants.${variant}`,
          message: 'does not exist',
          code: 'reference',
        },
      ]);
    const variantBase = without(variantPatch, ['environments']);
    resolved = applyMergePatch(resolved, variantBase);
    assertIdentityUnchanged(packageIdentity, resolved, `$.variants.${variant}`);
    if (variantPatch.environments?.[environment]) {
      resolved = applyMergePatch(resolved, variantPatch.environments[environment]);
      assertIdentityUnchanged(packageIdentity, resolved, `$.variants.${variant}.environments.${environment}`);
    }
    resolved.id = `${resolved.id}-${variant}`;
  }
  resolved = without(resolved, ['profile', 'variants', 'environments']);
  return assertValidDeploymentSpecV2(resolved);
}

function wildcard(value, pattern) {
  if (pattern === '*') return true;
  const expression = `^${pattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*')}$`;
  return new RegExp(expression).test(value);
}

function matchesAny(value, patterns) {
  return (
    patterns === undefined || patterns.length === 0 || patterns.some((pattern) => wildcard(value, pattern))
  );
}

export function matchingTargetIds(config, environment, workload) {
  const environmentConfig = config.environments[environment];
  if (!environmentConfig) return [];
  return environmentConfig.bindings
    .filter(({ selector }) => {
      const deployment = workload.deployment;
      return (
        matchesAny(deployment.id, selector.workloads) &&
        matchesAny(deployment.kind, selector.kinds) &&
        matchesAny(workload.profile ?? '', selector.profiles) &&
        matchesAny(workload.workspace.location, selector.locations) &&
        matchesAny(workload.variant ?? 'default', selector.variants)
      );
    })
    .map(({ target }) => target);
}

export function bindTarget(config, environment, workload) {
  const matches = matchingTargetIds(config, environment, workload);
  const unique = [...new Set(matches)];
  if (unique.length !== 1) throw new TargetBindingError(workload.deployment.id, environment, unique);
  return { id: unique[0], ...clone(config.targets[unique[0]]) };
}

export async function discoverDeploymentWorkspaces(rootCandidate) {
  const { root, workspaces } = await discoverWorkspaces(rootCandidate);
  const deployments = [];
  const ids = new Set();
  for (const workspace of workspaces) {
    if (workspace.manifest.deployment === undefined) continue;
    const result = validateDeploymentSpecV2(workspace.manifest.deployment);
    if (!result.valid) {
      throw new DeploymentV2ValidationError(
        result.errors.map((issue) => ({
          ...issue,
          path: `${workspace.location}/package.json:deployment${issue.path.slice(1)}`,
        }))
      );
    }
    if (!result.value.enabled) continue;
    if (ids.has(result.value.id))
      throw new DeploymentV2ValidationError([
        {
          path: `${workspace.location}/package.json:deployment.id`,
          message: `duplicates enabled deployment id ${result.value.id}`,
          code: 'duplicate',
        },
      ]);
    ids.add(result.value.id);
    deployments.push({ workspace, rawDeployment: clone(workspace.manifest.deployment) });
  }
  return { root, deployments };
}

export async function loadMonoXConfig(rootCandidate) {
  const root = rootCandidate ? path.resolve(rootCandidate) : await findWorkspaceRoot();
  const file = path.join(root, 'monox.config.json');
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new SyntaxError(`Cannot parse ${file}: ${error.message}`);
    throw error;
  }
  return { root, file, config: assertValidMonoXConfigV2(value) };
}

export async function resolveProjectDeployments({ root: rootCandidate, environment, targetId } = {}) {
  const loaded = await loadMonoXConfig(rootCandidate);
  const selectedEnvironment = environment ?? loaded.config.project.defaultEnvironment;
  if (!selectedEnvironment)
    throw new TypeError('An environment is required because project.defaultEnvironment is not configured');
  const discovered = await discoverDeploymentWorkspaces(loaded.root);
  const workloads = [];
  for (const item of discovered.deployments) {
    const variants = [null, ...Object.keys(item.rawDeployment.variants ?? {}).sort()];
    for (const variant of variants) {
      const deployment = resolveDeploymentSpecV2(
        item.rawDeployment,
        loaded.config,
        selectedEnvironment,
        variant
      );
      const wrapper = {
        workspace: {
          name: item.workspace.name,
          location: item.workspace.location,
        },
        environment: selectedEnvironment,
        variant,
        profile: item.rawDeployment.profile ?? null,
        deployment,
      };
      const target = bindTarget(loaded.config, selectedEnvironment, wrapper);
      if (!targetId || target.id === targetId) workloads.push({ ...wrapper, target });
    }
  }
  if (targetId && !Object.hasOwn(loaded.config.targets, targetId))
    throw new TypeError(`Unknown target: ${targetId}`);
  return { ...loaded, environment: selectedEnvironment, workloads };
}

export const monoxTargetAxes = axes;
