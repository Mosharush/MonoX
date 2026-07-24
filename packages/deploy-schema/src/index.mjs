import { readFileSync } from 'node:fs';

export const DEPLOYMENT_SCHEMA_VERSION = '1';
export const deploymentSchema = JSON.parse(
  readFileSync(new URL('../schema/v1/deployment.schema.json', import.meta.url), 'utf8')
);

const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const dnsSubdomainPattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const imageRepositoryPattern = /^[a-z0-9][a-z0-9._/-]*$/;
const imageTagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quantityCpuPattern = /^(?:[1-9][0-9]*m|0\.[0-9]+|[1-9][0-9]*(?:\.[0-9]+)?)$/;
const quantityMemoryPattern = /^[1-9][0-9]*(?:Ki|Mi|Gi|Ti)$/;
const percentagePattern = /^(?:100|[1-9]?[0-9])%$/;
const secretLikeNamePattern = /(?:^|_)(?:api_?key|credential|password|private_?key|secret|token)(?:$|_)/i;

const allowed = {
  root: new Set([
    '$schema',
    'schemaVersion',
    'name',
    'namespace',
    'createNamespace',
    'labels',
    'annotations',
    'replicas',
    'revisionHistoryLimit',
    'terminationGracePeriodSeconds',
    'image',
    'container',
    'serviceAccount',
    'service',
    'ingress',
    'probes',
    'resources',
    'rollingUpdate',
    'podDisruptionBudget',
    'topologySpread',
    'networkPolicy',
    'autoscaling',
    'podSecurity',
  ]),
  image: new Set(['repository', 'tag', 'pullPolicy', 'pullSecrets']),
  container: new Set(['port', 'command', 'args', 'env', 'envFromSecrets', 'writableTmp']),
  env: new Set(['name', 'value']),
  serviceAccount: new Set(['create', 'name', 'annotations']),
  service: new Set(['enabled', 'type', 'port', 'annotations']),
  ingress: new Set(['enabled', 'className', 'host', 'path', 'pathType', 'annotations', 'tls']),
  tls: new Set(['enabled', 'secretName']),
  probes: new Set(['startup', 'readiness', 'liveness']),
  probe: new Set([
    'path',
    'initialDelaySeconds',
    'periodSeconds',
    'timeoutSeconds',
    'failureThreshold',
    'successThreshold',
  ]),
  resources: new Set(['requests', 'limits']),
  resourcePair: new Set(['cpu', 'memory']),
  rollingUpdate: new Set(['maxSurge', 'maxUnavailable']),
  podDisruptionBudget: new Set(['enabled', 'minAvailable', 'maxUnavailable']),
  topologySpread: new Set(['enabled', 'maxSkew', 'whenUnsatisfiable', 'topologyKeys']),
  networkPolicy: new Set(['enabled', 'ingressFrom', 'egress']),
  networkPeer: new Set(['namespaceLabels', 'podLabels']),
  egress: new Set(['dns', 'https', 'sameNamespace']),
  autoscaling: new Set(['mode', 'minReplicas', 'maxReplicas', 'cpuUtilization', 'memoryUtilization', 'keda']),
  keda: new Set(['pollingInterval', 'cooldownPeriod', 'triggers']),
  kedaTrigger: new Set(['type', 'metadata', 'authenticationRef']),
  podSecurity: new Set(['runAsUser', 'runAsGroup', 'fsGroup', 'readOnlyRootFilesystem']),
};

const defaults = {
  createNamespace: true,
  labels: {},
  annotations: {},
  replicas: 1,
  revisionHistoryLimit: 3,
  terminationGracePeriodSeconds: 60,
  image: {
    pullPolicy: 'IfNotPresent',
    pullSecrets: [],
  },
  container: {
    command: [],
    args: [],
    env: [],
    envFromSecrets: [],
    writableTmp: true,
  },
  serviceAccount: {
    create: true,
    annotations: {},
  },
  service: {
    type: 'ClusterIP',
    annotations: {},
  },
  ingress: {
    enabled: false,
    path: '/',
    pathType: 'Prefix',
    annotations: {},
    tls: {
      enabled: false,
    },
  },
  probes: {
    startup: {
      initialDelaySeconds: 0,
      periodSeconds: 10,
      timeoutSeconds: 3,
      failureThreshold: 30,
      successThreshold: 1,
    },
    readiness: {
      initialDelaySeconds: 0,
      periodSeconds: 10,
      timeoutSeconds: 3,
      failureThreshold: 3,
      successThreshold: 1,
    },
    liveness: {
      initialDelaySeconds: 0,
      periodSeconds: 30,
      timeoutSeconds: 3,
      failureThreshold: 3,
      successThreshold: 1,
    },
  },
  rollingUpdate: {
    maxSurge: '25%',
    maxUnavailable: 0,
  },
  podDisruptionBudget: {
    enabled: true,
  },
  topologySpread: {
    enabled: true,
    maxSkew: 1,
    whenUnsatisfiable: 'ScheduleAnyway',
    topologyKeys: ['topology.kubernetes.io/zone', 'kubernetes.io/hostname'],
  },
  podSecurity: {
    runAsUser: 10001,
    runAsGroup: 10001,
    fsGroup: 10001,
    readOnlyRootFilesystem: true,
  },
};

export class DeploymentValidationError extends TypeError {
  constructor(errors) {
    super(
      `Invalid deployment configuration:\n${errors.map((error) => `- ${error.path}: ${error.message}`).join('\n')}`
    );
    this.name = 'DeploymentValidationError';
    this.errors = errors;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function mergeDefaults(value, fallback) {
  if (!isObject(fallback)) return value === undefined ? clone(fallback) : value;
  const result = isObject(value) ? clone(value) : {};
  for (const [key, defaultValue] of Object.entries(fallback)) {
    result[key] = mergeDefaults(result[key], defaultValue);
  }
  return result;
}

export function normalizeDeploymentConfig(input) {
  const normalized = mergeDefaults(input, defaults);
  if (normalized.autoscaling?.mode === 'keda') {
    normalized.autoscaling.keda = mergeDefaults(normalized.autoscaling.keda, {
      pollingInterval: 30,
      cooldownPeriod: 300,
    });
  }
  if (
    isObject(normalized.podDisruptionBudget) &&
    normalized.podDisruptionBudget.enabled &&
    normalized.podDisruptionBudget.minAvailable === undefined &&
    normalized.podDisruptionBudget.maxUnavailable === undefined
  ) {
    normalized.podDisruptionBudget.minAvailable = 1;
  }
  if (isObject(normalized.serviceAccount) && !normalized.serviceAccount.name && normalized.name) {
    normalized.serviceAccount.name = normalized.name;
  }
  return normalized;
}

function addError(errors, path, message, code = 'invalid') {
  errors.push({ path, message, code });
}

function checkObject(errors, path, value, allowedKeys, required = []) {
  if (!isObject(value)) {
    addError(errors, path, 'must be an object', 'type');
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) addError(errors, `${path}.${key}`, 'is not a supported property', 'unknown');
  }
  for (const key of required) {
    if (value[key] === undefined) addError(errors, `${path}.${key}`, 'is required', 'required');
  }
  return true;
}

function checkBoolean(errors, path, value) {
  if (typeof value !== 'boolean') addError(errors, path, 'must be a boolean', 'type');
}

function checkInteger(errors, path, value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value)) addError(errors, path, 'must be an integer', 'type');
  else if (value < minimum || value > maximum)
    addError(errors, path, `must be between ${minimum} and ${maximum}`, 'range');
}

function checkString(errors, path, value, options = {}) {
  if (typeof value !== 'string') {
    addError(errors, path, 'must be a string', 'type');
    return;
  }
  if (options.minLength !== undefined && value.length < options.minLength)
    addError(errors, path, `must contain at least ${options.minLength} character(s)`, 'length');
  if (options.maxLength !== undefined && value.length > options.maxLength)
    addError(errors, path, `must contain at most ${options.maxLength} character(s)`, 'length');
  if (options.pattern && !options.pattern.test(value))
    addError(errors, path, 'has an invalid format', 'format');
}

function checkDnsLabel(errors, path, value) {
  checkString(errors, path, value, { minLength: 1, maxLength: 63, pattern: dnsLabelPattern });
}

function checkStringMap(errors, path, value) {
  if (!isObject(value)) {
    addError(errors, path, 'must be an object containing string values', 'type');
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 253) addError(errors, `${path}.${key}`, 'has an invalid key', 'format');
    if (typeof item !== 'string') addError(errors, `${path}.${key}`, 'must be a string', 'type');
  }
}

function checkStringArray(errors, path, value) {
  if (!Array.isArray(value)) {
    addError(errors, path, 'must be an array', 'type');
    return;
  }
  value.forEach((item, index) => checkString(errors, `${path}[${index}]`, item));
}

function checkUniqueDnsLabels(errors, path, value) {
  if (!Array.isArray(value)) {
    addError(errors, path, 'must be an array', 'type');
    return;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    checkDnsLabel(errors, `${path}[${index}]`, item);
    if (seen.has(item)) addError(errors, `${path}[${index}]`, 'must be unique', 'duplicate');
    seen.add(item);
  });
}

function checkIntOrPercent(errors, path, value) {
  if (Number.isInteger(value) && value >= 0) return;
  if (typeof value === 'string' && percentagePattern.test(value)) return;
  addError(errors, path, 'must be a non-negative integer or a percentage from 0% to 100%', 'format');
}

function isZeroIntOrPercent(value) {
  return value === 0 || value === '0%';
}

function cpuCores(value) {
  if (typeof value !== 'string' || !quantityCpuPattern.test(value)) return null;
  return value.endsWith('m') ? Number(value.slice(0, -1)) / 1000 : Number(value);
}

function memoryBytes(value) {
  if (typeof value !== 'string' || !quantityMemoryPattern.test(value)) return null;
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  const unit = value.slice(-2);
  return Number(value.slice(0, -2)) * units[unit];
}

function checkResources(errors, resources) {
  if (!checkObject(errors, '$.resources', resources, allowed.resources, ['requests', 'limits'])) return;
  for (const group of ['requests', 'limits']) {
    const value = resources[group];
    const path = `$.resources.${group}`;
    if (!checkObject(errors, path, value, allowed.resourcePair, ['cpu', 'memory'])) continue;
    if (cpuCores(value.cpu) === null)
      addError(errors, `${path}.cpu`, 'must be a positive CPU quantity', 'format');
    if (memoryBytes(value.memory) === null)
      addError(errors, `${path}.memory`, 'must be a positive Ki, Mi, Gi, or Ti quantity', 'format');
  }
  const requestedCpu = cpuCores(resources.requests?.cpu);
  const limitedCpu = cpuCores(resources.limits?.cpu);
  const requestedMemory = memoryBytes(resources.requests?.memory);
  const limitedMemory = memoryBytes(resources.limits?.memory);
  if (requestedCpu !== null && limitedCpu !== null && requestedCpu > limitedCpu)
    addError(errors, '$.resources.requests.cpu', 'must not exceed the CPU limit', 'range');
  if (requestedMemory !== null && limitedMemory !== null && requestedMemory > limitedMemory)
    addError(errors, '$.resources.requests.memory', 'must not exceed the memory limit', 'range');
}

function checkProbe(errors, name, value) {
  const path = `$.probes.${name}`;
  if (!checkObject(errors, path, value, allowed.probe, ['path'])) return;
  checkString(errors, `${path}.path`, value.path, { minLength: 1, pattern: /^\// });
  checkInteger(errors, `${path}.initialDelaySeconds`, value.initialDelaySeconds, 0, 3600);
  checkInteger(errors, `${path}.periodSeconds`, value.periodSeconds, 1, 3600);
  checkInteger(errors, `${path}.timeoutSeconds`, value.timeoutSeconds, 1, 3600);
  checkInteger(errors, `${path}.failureThreshold`, value.failureThreshold, 1, 1000);
  checkInteger(errors, `${path}.successThreshold`, value.successThreshold, 1, 1000);
  if (name !== 'readiness' && value.successThreshold !== 1)
    addError(errors, `${path}.successThreshold`, 'must be 1 for startup and liveness probes', 'kubernetes');
}

function checkNetworkPolicy(errors, value) {
  if (
    !checkObject(errors, '$.networkPolicy', value, allowed.networkPolicy, [
      'enabled',
      'ingressFrom',
      'egress',
    ])
  )
    return;
  checkBoolean(errors, '$.networkPolicy.enabled', value.enabled);
  if (!Array.isArray(value.ingressFrom))
    addError(errors, '$.networkPolicy.ingressFrom', 'must be an array', 'type');
  else {
    value.ingressFrom.forEach((peer, index) => {
      const path = `$.networkPolicy.ingressFrom[${index}]`;
      if (!checkObject(errors, path, peer, allowed.networkPeer)) return;
      const hasNamespace = isObject(peer.namespaceLabels) && Object.keys(peer.namespaceLabels).length > 0;
      const hasPod = isObject(peer.podLabels) && Object.keys(peer.podLabels).length > 0;
      if (!hasNamespace && !hasPod)
        addError(errors, path, 'must contain non-empty namespaceLabels or podLabels', 'security');
      if (peer.namespaceLabels !== undefined)
        checkStringMap(errors, `${path}.namespaceLabels`, peer.namespaceLabels);
      if (peer.podLabels !== undefined) checkStringMap(errors, `${path}.podLabels`, peer.podLabels);
    });
  }
  if (
    checkObject(errors, '$.networkPolicy.egress', value.egress, allowed.egress, [
      'dns',
      'https',
      'sameNamespace',
    ])
  ) {
    for (const key of ['dns', 'https', 'sameNamespace'])
      checkBoolean(errors, `$.networkPolicy.egress.${key}`, value.egress[key]);
  }
}

function checkAutoscaling(errors, value) {
  if (!checkObject(errors, '$.autoscaling', value, allowed.autoscaling, ['mode'])) return;
  if (!['none', 'hpa', 'keda'].includes(value.mode))
    addError(errors, '$.autoscaling.mode', 'must be none, hpa, or keda', 'enum');
  if (value.mode === 'none') return;
  const minimum = value.mode === 'hpa' ? 1 : 0;
  checkInteger(errors, '$.autoscaling.minReplicas', value.minReplicas, minimum, 100);
  checkInteger(errors, '$.autoscaling.maxReplicas', value.maxReplicas, 1, 1000);
  if (
    Number.isInteger(value.minReplicas) &&
    Number.isInteger(value.maxReplicas) &&
    value.minReplicas > value.maxReplicas
  ) {
    addError(errors, '$.autoscaling.maxReplicas', 'must be greater than or equal to minReplicas', 'range');
  }
  for (const key of ['cpuUtilization', 'memoryUtilization']) {
    if (value[key] !== undefined) checkInteger(errors, `$.autoscaling.${key}`, value[key], 1, 100);
  }
  if (value.mode === 'hpa') {
    if (value.cpuUtilization === undefined && value.memoryUtilization === undefined)
      addError(errors, '$.autoscaling', 'HPA requires cpuUtilization or memoryUtilization', 'required');
    if (value.keda !== undefined)
      addError(errors, '$.autoscaling.keda', 'is only supported in keda mode', 'conflict');
    return;
  }
  if (!checkObject(errors, '$.autoscaling.keda', value.keda, allowed.keda, ['triggers'])) return;
  checkInteger(errors, '$.autoscaling.keda.pollingInterval', value.keda.pollingInterval, 1, 3600);
  checkInteger(errors, '$.autoscaling.keda.cooldownPeriod', value.keda.cooldownPeriod, 0, 86400);
  if (!Array.isArray(value.keda.triggers) || value.keda.triggers.length === 0) {
    addError(errors, '$.autoscaling.keda.triggers', 'must contain at least one trigger', 'required');
    return;
  }
  value.keda.triggers.forEach((trigger, index) => {
    const path = `$.autoscaling.keda.triggers[${index}]`;
    if (!checkObject(errors, path, trigger, allowed.kedaTrigger, ['type', 'metadata'])) return;
    checkString(errors, `${path}.type`, trigger.type, { pattern: /^[a-z][a-z0-9-]*$/ });
    checkStringMap(errors, `${path}.metadata`, trigger.metadata);
    for (const key of Object.keys(trigger.metadata ?? {})) {
      if (secretLikeNamePattern.test(key) && !/FromEnv$/i.test(key))
        addError(
          errors,
          `${path}.metadata.${key}`,
          'must use authenticationRef or an external environment reference instead of an inline credential',
          'security'
        );
    }
    if (trigger.authenticationRef !== undefined)
      checkDnsLabel(errors, `${path}.authenticationRef`, trigger.authenticationRef);
  });
}

export function validateDeploymentConfig(input) {
  const value = normalizeDeploymentConfig(input);
  const errors = [];
  if (
    !checkObject(errors, '$', value, allowed.root, [
      'schemaVersion',
      'name',
      'namespace',
      'image',
      'container',
      'service',
      'probes',
      'resources',
      'autoscaling',
      'networkPolicy',
    ])
  ) {
    return { valid: false, errors, value };
  }

  if (value.schemaVersion !== DEPLOYMENT_SCHEMA_VERSION)
    addError(errors, '$.schemaVersion', `must equal ${DEPLOYMENT_SCHEMA_VERSION}`, 'version');
  if (value.$schema !== undefined) checkString(errors, '$.$schema', value.$schema, { minLength: 1 });
  checkDnsLabel(errors, '$.name', value.name);
  checkDnsLabel(errors, '$.namespace', value.namespace);
  checkBoolean(errors, '$.createNamespace', value.createNamespace);
  checkStringMap(errors, '$.labels', value.labels);
  checkStringMap(errors, '$.annotations', value.annotations);
  checkInteger(errors, '$.replicas', value.replicas, 0, 100);
  checkInteger(errors, '$.revisionHistoryLimit', value.revisionHistoryLimit, 0, 20);
  checkInteger(errors, '$.terminationGracePeriodSeconds', value.terminationGracePeriodSeconds, 10, 3600);

  if (checkObject(errors, '$.image', value.image, allowed.image, ['repository', 'tag'])) {
    checkString(errors, '$.image.repository', value.image.repository, {
      minLength: 1,
      maxLength: 255,
      pattern: imageRepositoryPattern,
    });
    checkString(errors, '$.image.tag', value.image.tag, {
      minLength: 1,
      maxLength: 128,
      pattern: imageTagPattern,
    });
    if (String(value.image.tag).toLowerCase() === 'latest')
      addError(errors, '$.image.tag', 'must be immutable and cannot be latest', 'security');
    if (!['Always', 'IfNotPresent', 'Never'].includes(value.image.pullPolicy))
      addError(errors, '$.image.pullPolicy', 'must be Always, IfNotPresent, or Never', 'enum');
    checkUniqueDnsLabels(errors, '$.image.pullSecrets', value.image.pullSecrets);
  }

  if (checkObject(errors, '$.container', value.container, allowed.container, ['port'])) {
    checkInteger(errors, '$.container.port', value.container.port, 1, 65535);
    checkStringArray(errors, '$.container.command', value.container.command);
    checkStringArray(errors, '$.container.args', value.container.args);
    checkBoolean(errors, '$.container.writableTmp', value.container.writableTmp);
    checkUniqueDnsLabels(errors, '$.container.envFromSecrets', value.container.envFromSecrets);
    if (!Array.isArray(value.container.env)) addError(errors, '$.container.env', 'must be an array', 'type');
    else {
      const names = new Set();
      value.container.env.forEach((entry, index) => {
        const path = `$.container.env[${index}]`;
        if (!checkObject(errors, path, entry, allowed.env, ['name', 'value'])) return;
        checkString(errors, `${path}.name`, entry.name, { pattern: envNamePattern });
        checkString(errors, `${path}.value`, entry.value);
        if (names.has(entry.name)) addError(errors, `${path}.name`, 'must be unique', 'duplicate');
        names.add(entry.name);
        if (secretLikeNamePattern.test(entry.name))
          addError(
            errors,
            `${path}.value`,
            'secret-like values must come from an externally managed Secret via envFromSecrets',
            'security'
          );
      });
    }
  }

  if (
    checkObject(errors, '$.serviceAccount', value.serviceAccount, allowed.serviceAccount, ['create', 'name'])
  ) {
    checkBoolean(errors, '$.serviceAccount.create', value.serviceAccount.create);
    checkDnsLabel(errors, '$.serviceAccount.name', value.serviceAccount.name);
    checkStringMap(errors, '$.serviceAccount.annotations', value.serviceAccount.annotations);
    if (!value.serviceAccount.create && !value.serviceAccount.name)
      addError(errors, '$.serviceAccount.name', 'is required when create is false', 'required');
    if (value.serviceAccount.name === 'default')
      addError(errors, '$.serviceAccount.name', 'cannot use the default ServiceAccount', 'security');
  }

  if (checkObject(errors, '$.service', value.service, allowed.service, ['enabled', 'port'])) {
    checkBoolean(errors, '$.service.enabled', value.service.enabled);
    if (!['ClusterIP', 'NodePort', 'LoadBalancer'].includes(value.service.type))
      addError(errors, '$.service.type', 'must be ClusterIP, NodePort, or LoadBalancer', 'enum');
    checkInteger(errors, '$.service.port', value.service.port, 1, 65535);
    checkStringMap(errors, '$.service.annotations', value.service.annotations);
  }

  if (checkObject(errors, '$.ingress', value.ingress, allowed.ingress, ['enabled', 'tls'])) {
    checkBoolean(errors, '$.ingress.enabled', value.ingress.enabled);
    if (value.ingress.className !== undefined)
      checkString(errors, '$.ingress.className', value.ingress.className, { minLength: 1 });
    if (value.ingress.host !== undefined)
      checkString(errors, '$.ingress.host', value.ingress.host, {
        minLength: 1,
        maxLength: 253,
        pattern: dnsSubdomainPattern,
      });
    checkString(errors, '$.ingress.path', value.ingress.path, { minLength: 1, pattern: /^\// });
    if (!['Exact', 'Prefix', 'ImplementationSpecific'].includes(value.ingress.pathType))
      addError(errors, '$.ingress.pathType', 'has an unsupported value', 'enum');
    checkStringMap(errors, '$.ingress.annotations', value.ingress.annotations);
    if (value.ingress.enabled && !value.service?.enabled)
      addError(errors, '$.ingress.enabled', 'requires service.enabled to be true', 'conflict');
    if (value.ingress.enabled && !value.ingress.host)
      addError(errors, '$.ingress.host', 'is required when ingress is enabled', 'required');
    if (checkObject(errors, '$.ingress.tls', value.ingress.tls, allowed.tls, ['enabled'])) {
      checkBoolean(errors, '$.ingress.tls.enabled', value.ingress.tls.enabled);
      if (value.ingress.tls.enabled && !value.ingress.tls.secretName)
        addError(errors, '$.ingress.tls.secretName', 'is required when TLS is enabled', 'required');
      if (value.ingress.tls.secretName !== undefined)
        checkDnsLabel(errors, '$.ingress.tls.secretName', value.ingress.tls.secretName);
    }
  }

  if (checkObject(errors, '$.probes', value.probes, allowed.probes, ['startup', 'readiness', 'liveness'])) {
    for (const name of ['startup', 'readiness', 'liveness']) checkProbe(errors, name, value.probes[name]);
  }
  checkResources(errors, value.resources);

  if (
    checkObject(errors, '$.rollingUpdate', value.rollingUpdate, allowed.rollingUpdate, [
      'maxSurge',
      'maxUnavailable',
    ])
  ) {
    checkIntOrPercent(errors, '$.rollingUpdate.maxSurge', value.rollingUpdate.maxSurge);
    checkIntOrPercent(errors, '$.rollingUpdate.maxUnavailable', value.rollingUpdate.maxUnavailable);
    if (
      isZeroIntOrPercent(value.rollingUpdate.maxSurge) &&
      isZeroIntOrPercent(value.rollingUpdate.maxUnavailable)
    )
      addError(errors, '$.rollingUpdate', 'maxSurge and maxUnavailable cannot both be zero', 'kubernetes');
  }

  if (
    checkObject(errors, '$.podDisruptionBudget', value.podDisruptionBudget, allowed.podDisruptionBudget, [
      'enabled',
    ])
  ) {
    checkBoolean(errors, '$.podDisruptionBudget.enabled', value.podDisruptionBudget.enabled);
    const hasMinimum = value.podDisruptionBudget.minAvailable !== undefined;
    const hasMaximum = value.podDisruptionBudget.maxUnavailable !== undefined;
    if (hasMinimum)
      checkIntOrPercent(errors, '$.podDisruptionBudget.minAvailable', value.podDisruptionBudget.minAvailable);
    if (hasMaximum)
      checkIntOrPercent(
        errors,
        '$.podDisruptionBudget.maxUnavailable',
        value.podDisruptionBudget.maxUnavailable
      );
    if (value.podDisruptionBudget.enabled && hasMinimum === hasMaximum)
      addError(
        errors,
        '$.podDisruptionBudget',
        'must set exactly one of minAvailable or maxUnavailable when enabled',
        'conflict'
      );
  }

  if (checkObject(errors, '$.topologySpread', value.topologySpread, allowed.topologySpread, ['enabled'])) {
    checkBoolean(errors, '$.topologySpread.enabled', value.topologySpread.enabled);
    checkInteger(errors, '$.topologySpread.maxSkew', value.topologySpread.maxSkew, 1, 100);
    if (!['DoNotSchedule', 'ScheduleAnyway'].includes(value.topologySpread.whenUnsatisfiable))
      addError(errors, '$.topologySpread.whenUnsatisfiable', 'has an unsupported value', 'enum');
    checkStringArray(errors, '$.topologySpread.topologyKeys', value.topologySpread.topologyKeys);
    if (
      new Set(value.topologySpread.topologyKeys ?? []).size !==
      (value.topologySpread.topologyKeys ?? []).length
    )
      addError(errors, '$.topologySpread.topologyKeys', 'must contain unique values', 'duplicate');
  }

  checkNetworkPolicy(errors, value.networkPolicy);
  checkAutoscaling(errors, value.autoscaling);

  if (checkObject(errors, '$.podSecurity', value.podSecurity, allowed.podSecurity)) {
    for (const key of ['runAsUser', 'runAsGroup', 'fsGroup'])
      checkInteger(errors, `$.podSecurity.${key}`, value.podSecurity[key], 1);
    checkBoolean(errors, '$.podSecurity.readOnlyRootFilesystem', value.podSecurity.readOnlyRootFilesystem);
  }

  return { valid: errors.length === 0, errors, value };
}

export function assertValidDeploymentConfig(input) {
  const result = validateDeploymentConfig(input);
  if (!result.valid) throw new DeploymentValidationError(result.errors);
  return result.value;
}
