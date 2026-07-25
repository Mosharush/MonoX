import { readFileSync } from 'node:fs';

import { containsSecretMaterial, isSecretLikeKey } from './security.mjs';

export const DEPLOYMENT_SCHEMA_VERSION_V2 = '2';
export const deploymentSchemaV2 = JSON.parse(
  readFileSync(new URL('../schema/v2/deployment.schema.json', import.meta.url), 'utf8')
);

const idPattern = /^[a-z][a-z0-9-]{0,62}$/;
const frameworkPattern = /^[a-z][a-z0-9.-]{0,62}$/;
const envPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quantityPattern = /^(?:[1-9][0-9]*(?:m|Ki|Mi|Gi|Ti)?|0\.[0-9]+)$/;

const enums = Object.freeze({
  kind: ['service', 'worker', 'cron', 'job', 'model', 'static'],
  buildStrategy: ['dockerfile', 'buildpack', 'static', 'none'],
  language: ['javascript', 'typescript', 'python', 'php', 'go'],
  exposure: ['none', 'internal', 'public'],
  protocol: ['TCP', 'UDP'],
  pathType: ['Exact', 'Prefix', 'ImplementationSpecific'],
  probeType: ['http', 'tcp', 'exec'],
  storageType: ['ephemeral', 'persistent', 'secret', 'config'],
  scalingMode: ['none', 'hpa', 'keda'],
  metricType: [
    'cpu',
    'memory',
    'rps',
    'rabbitmq',
    'sqs',
    'pubsub',
    'redis',
    'kafka',
    'nats',
    'external',
    'keda',
  ],
});

const allowed = Object.freeze({
  root: [
    '$schema',
    'schemaVersion',
    'enabled',
    'id',
    'kind',
    'profile',
    'suspended',
    'labels',
    'build',
    'runtime',
    'network',
    'probes',
    'env',
    'resources',
    'storage',
    'identity',
    'telemetry',
    'lifecycle',
    'scaling',
    'variants',
    'environments',
    'adapterOverrides',
  ],
  build: ['strategy', 'context', 'dockerfile', 'script', 'output', 'image'],
  image: ['repository', 'tag', 'digest'],
  runtime: ['language', 'framework', 'command', 'workingDirectory', 'cron', 'tuning'],
  network: ['exposure', 'ports', 'routes'],
  port: ['name', 'containerPort', 'servicePort', 'protocol'],
  route: ['host', 'path', 'pathType', 'tlsSecretRef'],
  probes: ['startup', 'readiness', 'liveness'],
  probe: [
    'type',
    'path',
    'port',
    'command',
    'delaySeconds',
    'periodSeconds',
    'timeoutSeconds',
    'failureThreshold',
    'successThreshold',
  ],
  env: ['values', 'secretRefs'],
  secretRef: ['name', 'provider', 'key', 'target', 'optional'],
  resources: ['requests', 'limits', 'accelerators'],
  resourceQuantity: ['cpu', 'memory', 'ephemeralStorage'],
  accelerator: ['type', 'count', 'model'],
  storage: ['name', 'type', 'mountPath', 'size', 'className', 'readOnly', 'sourceRef'],
  identity: ['serviceAccount', 'providerRoleRef', 'workloadIdentity', 'automountServiceAccountToken'],
  telemetry: ['metrics', 'traces', 'logs'],
  telemetrySignal: ['enabled'],
  telemetryMetrics: ['enabled', 'path', 'port'],
  lifecycle: ['terminationGracePeriodSeconds', 'preStopCommand', 'drain'],
  drain: ['enabled', 'timeoutSeconds'],
  scaling: [
    'mode',
    'minReplicas',
    'maxReplicas',
    'pollingInterval',
    'cooldownPeriod',
    'metrics',
    'behavior',
    'fallback',
  ],
  metric: [
    'type',
    'target',
    'sourceRef',
    'query',
    'route',
    'queue',
    'topic',
    'stream',
    'consumerGroup',
    'metricName',
    'scaler',
    'metadata',
    'authenticationRef',
  ],
  behavior: ['scaleUpStabilizationSeconds', 'scaleDownStabilizationSeconds'],
  fallback: ['replicas', 'failureThreshold'],
  adapterOverrides: ['kubernetes', 'pm2', 'coolify', 'static'],
  kubernetesOverride: ['namespace', 'serviceAccountName', 'nodeSelector', 'tolerations'],
  toleration: ['key', 'operator', 'value', 'effect'],
  pm2Override: ['instances', 'execMode'],
  coolifyOverride: ['serverId', 'destinationId', 'domain'],
  staticOverride: ['bucket', 'cdn'],
});

export const deploymentV2AllowedProperties = Object.freeze(
  Object.fromEntries(
    Object.entries(allowed).map(([name, properties]) => [name, Object.freeze([...properties])])
  )
);

const defaults = Object.freeze({
  suspended: false,
  labels: {},
  network: { exposure: 'none', ports: [], routes: [] },
  probes: {},
  env: { values: {}, secretRefs: [] },
  resources: {
    requests: { cpu: '100m', memory: '128Mi' },
    limits: { cpu: '500m', memory: '512Mi' },
    accelerators: [],
  },
  storage: [],
  identity: { automountServiceAccountToken: false },
  telemetry: {
    metrics: { enabled: false, path: '/metrics' },
    traces: { enabled: false },
    logs: { enabled: true },
  },
  lifecycle: {
    terminationGracePeriodSeconds: 60,
    preStopCommand: [],
    drain: { enabled: false, timeoutSeconds: 30 },
  },
  scaling: { mode: 'none', minReplicas: 1, maxReplicas: 1, metrics: [] },
  variants: {},
  environments: {},
  adapterOverrides: {},
});

export class DeploymentV2ValidationError extends TypeError {
  constructor(errors) {
    super(
      `Invalid deployment v2 configuration:\n${errors
        .map((error) => `- ${error.path}: ${error.message}`)
        .join('\n')}`
    );
    this.name = 'DeploymentV2ValidationError';
    this.errors = errors;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function withoutNullObjectEntries(value) {
  if (Array.isArray(value)) return value.map((item) => clone(item));
  if (!object(value)) return clone(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, withoutNullObjectEntries(item)])
  );
}

function defaultsMerge(value, fallback) {
  if (!object(fallback)) return value === undefined ? clone(fallback) : clone(value);
  const result = object(value) ? clone(value) : {};
  for (const [key, defaultValue] of Object.entries(fallback)) {
    result[key] = defaultsMerge(result[key], defaultValue);
  }
  return result;
}

function error(errors, path, message, code = 'invalid') {
  errors.push({ path, message, code });
}

function strictObject(errors, path, value, keys, required = []) {
  if (!object(value)) {
    error(errors, path, 'must be an object', 'type');
    return false;
  }
  const supported = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!supported.has(key)) error(errors, `${path}.${key}`, 'is not a supported property', 'unknown');
  }
  for (const key of required) {
    if (value[key] === undefined) error(errors, `${path}.${key}`, 'is required', 'required');
  }
  return true;
}

function string(errors, path, value, pattern, required = true) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || value.length === 0) {
    error(errors, path, 'must be a non-empty string', 'type');
    return;
  }
  if (pattern && !pattern.test(value)) error(errors, path, 'has an invalid format', 'format');
  if (containsSecretMaterial(value)) {
    error(errors, path, 'must not contain credential material', 'security');
  }
}

function boolean(errors, path, value, required = true) {
  if (value === undefined && !required) return;
  if (typeof value !== 'boolean') error(errors, path, 'must be a boolean', 'type');
}

function integer(errors, path, value, minimum, maximum = Number.MAX_SAFE_INTEGER, required = true) {
  if (value === undefined && !required) return;
  if (!Number.isInteger(value)) error(errors, path, 'must be an integer', 'type');
  else if (value < minimum || value > maximum)
    error(errors, path, `must be between ${minimum} and ${maximum}`, 'range');
}

function enumeration(errors, path, value, values, required = true) {
  if (value === undefined && !required) return;
  if (!values.includes(value)) error(errors, path, `must be one of: ${values.join(', ')}`, 'enum');
}

function stringArray(errors, path, value, options = {}) {
  if (value === undefined && options.required === false) return;
  if (!Array.isArray(value)) {
    error(errors, path, 'must be an array', 'type');
    return;
  }
  if (options.minItems && value.length < options.minItems)
    error(errors, path, `must contain at least ${options.minItems} item(s)`, 'length');
  value.forEach((item, index) => string(errors, `${path}[${index}]`, item));
}

function stringMap(errors, path, value, options = {}) {
  if (value === undefined && options.required === false) return;
  if (!object(value)) {
    error(errors, path, 'must be an object containing string values', 'type');
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    string(errors, `${path}.${key}`, item);
    if (options.environment && !envPattern.test(key))
      error(errors, `${path}.${key}`, 'has an invalid environment variable name', 'format');
    if (options.rejectSecretNames && isSecretLikeKey(key))
      error(errors, `${path}.${key}`, 'secret-like values must use env.secretRefs', 'security');
  }
}

function validateBuild(errors, value, path, partial) {
  if (!strictObject(errors, path, value, allowed.build, partial ? [] : ['strategy'])) return;
  enumeration(errors, `${path}.strategy`, value.strategy, enums.buildStrategy, !partial);
  for (const key of ['context', 'dockerfile', 'output'])
    string(errors, `${path}.${key}`, value[key], undefined, false);
  string(errors, `${path}.script`, value.script, /^[A-Za-z0-9:_-]+$/, false);
  if (value.image !== undefined) {
    if (strictObject(errors, `${path}.image`, value.image, allowed.image)) {
      string(errors, `${path}.image.repository`, value.image.repository);
      string(errors, `${path}.image.tag`, value.image.tag, undefined, false);
      string(errors, `${path}.image.digest`, value.image.digest, /^sha256:[a-f0-9]{64}$/, false);
      if (value.image.tag === undefined && value.image.digest === undefined)
        error(errors, `${path}.image`, 'must define tag or digest', 'required');
      if (String(value.image.tag).toLowerCase() === 'latest')
        error(errors, `${path}.image.tag`, 'must be immutable and cannot be latest', 'security');
    }
  }
  if (value.strategy === 'dockerfile' && !partial && !value.dockerfile)
    error(errors, `${path}.dockerfile`, 'is required for dockerfile builds', 'required');
  if (value.strategy === 'static' && !partial && !value.output)
    error(errors, `${path}.output`, 'is required for static builds', 'required');
}

function validateRuntime(errors, value, path, partial) {
  if (!strictObject(errors, path, value, allowed.runtime, partial ? [] : ['language', 'command'])) return;
  enumeration(errors, `${path}.language`, value.language, enums.language, !partial);
  string(errors, `${path}.framework`, value.framework, frameworkPattern, false);
  if (value.command !== undefined || !partial)
    stringArray(errors, `${path}.command`, value.command, { minItems: partial ? 0 : 1 });
  string(errors, `${path}.workingDirectory`, value.workingDirectory, undefined, false);
  string(errors, `${path}.cron`, value.cron, undefined, false);
  stringMap(errors, `${path}.tuning`, value.tuning, { required: false });
}

function validateNetwork(errors, value, path, partial = false) {
  if (!strictObject(errors, path, value, allowed.network)) return;
  enumeration(errors, `${path}.exposure`, value.exposure, enums.exposure, false);
  if (value.ports !== undefined) {
    if (!Array.isArray(value.ports)) error(errors, `${path}.ports`, 'must be an array', 'type');
    else {
      const names = new Set();
      value.ports.forEach((port, index) => {
        const itemPath = `${path}.ports[${index}]`;
        if (!strictObject(errors, itemPath, port, allowed.port, ['name', 'containerPort'])) return;
        string(errors, `${itemPath}.name`, port.name, idPattern);
        integer(errors, `${itemPath}.containerPort`, port.containerPort, 1, 65535);
        integer(errors, `${itemPath}.servicePort`, port.servicePort, 1, 65535, false);
        enumeration(errors, `${itemPath}.protocol`, port.protocol, enums.protocol, false);
        if (names.has(port.name)) error(errors, `${itemPath}.name`, 'must be unique', 'duplicate');
        names.add(port.name);
      });
    }
  }
  if (value.routes !== undefined) {
    if (!Array.isArray(value.routes)) error(errors, `${path}.routes`, 'must be an array', 'type');
    else
      value.routes.forEach((route, index) => {
        const itemPath = `${path}.routes[${index}]`;
        if (!strictObject(errors, itemPath, route, allowed.route, ['path'])) return;
        string(errors, `${itemPath}.host`, route.host, undefined, false);
        string(errors, `${itemPath}.path`, route.path, /^\//);
        enumeration(errors, `${itemPath}.pathType`, route.pathType, enums.pathType, false);
        string(errors, `${itemPath}.tlsSecretRef`, route.tlsSecretRef, idPattern, false);
      });
  }
  if (!partial && value.exposure !== 'none' && (value.ports?.length ?? 0) === 0)
    error(errors, `${path}.ports`, 'must contain a port when the workload is exposed', 'required');
  if (!partial && value.exposure !== 'public' && (value.routes?.length ?? 0) > 0)
    error(errors, `${path}.routes`, 'routes require public exposure', 'conflict');
}

function validateProbe(errors, value, path, partial = false) {
  if (!strictObject(errors, path, value, allowed.probe, partial ? [] : ['type'])) return;
  enumeration(errors, `${path}.type`, value.type, enums.probeType, !partial);
  string(errors, `${path}.path`, value.path, /^\//, false);
  if (value.port !== undefined) {
    if (typeof value.port === 'string') string(errors, `${path}.port`, value.port, idPattern);
    else integer(errors, `${path}.port`, value.port, 1, 65535);
  }
  if (value.command !== undefined) stringArray(errors, `${path}.command`, value.command, { minItems: 1 });
  integer(errors, `${path}.delaySeconds`, value.delaySeconds, 0, 3600, false);
  integer(errors, `${path}.periodSeconds`, value.periodSeconds, 1, 3600, false);
  integer(errors, `${path}.timeoutSeconds`, value.timeoutSeconds, 1, 3600, false);
  integer(errors, `${path}.failureThreshold`, value.failureThreshold, 1, 1000, false);
  integer(errors, `${path}.successThreshold`, value.successThreshold, 1, 1000, false);
  if (!partial && value.type === 'http' && !value.path)
    error(errors, `${path}.path`, 'is required for an HTTP probe', 'required');
  if (!partial && value.type === 'tcp' && value.port === undefined)
    error(errors, `${path}.port`, 'is required for a TCP probe', 'required');
  if (!partial && value.type === 'exec' && !value.command?.length)
    error(errors, `${path}.command`, 'is required for an exec probe', 'required');
}

function validateEnv(errors, value, path) {
  if (!strictObject(errors, path, value, allowed.env)) return;
  stringMap(errors, `${path}.values`, value.values, {
    required: false,
    environment: true,
    rejectSecretNames: true,
  });
  if (value.secretRefs !== undefined) {
    if (!Array.isArray(value.secretRefs)) error(errors, `${path}.secretRefs`, 'must be an array', 'type');
    else
      value.secretRefs.forEach((reference, index) => {
        const itemPath = `${path}.secretRefs[${index}]`;
        if (!strictObject(errors, itemPath, reference, allowed.secretRef, ['name'])) return;
        string(errors, `${itemPath}.name`, reference.name, idPattern);
        for (const key of ['provider', 'key', 'target'])
          string(errors, `${itemPath}.${key}`, reference[key], undefined, false);
        boolean(errors, `${itemPath}.optional`, reference.optional, false);
      });
  }
}

function validateResourceQuantity(errors, value, path, partial) {
  if (!strictObject(errors, path, value, allowed.resourceQuantity, partial ? [] : ['cpu', 'memory'])) return;
  for (const key of allowed.resourceQuantity) {
    if (value[key] !== undefined) string(errors, `${path}.${key}`, value[key], quantityPattern);
  }
}

function quantityValue(value, resource) {
  if (typeof value !== 'string' || !quantityPattern.test(value)) return null;
  if (resource === 'cpu') return value.endsWith('m') ? Number(value.slice(0, -1)) / 1000 : Number(value);
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  const unit = value.slice(-2);
  return units[unit] ? Number(value.slice(0, -2)) * units[unit] : Number(value);
}

function validateResources(errors, value, path, partial) {
  if (!strictObject(errors, path, value, allowed.resources, partial ? [] : ['requests', 'limits'])) return;
  if (value.requests !== undefined)
    validateResourceQuantity(errors, value.requests, `${path}.requests`, partial);
  if (value.limits !== undefined) validateResourceQuantity(errors, value.limits, `${path}.limits`, partial);
  if (!partial && value.requests && value.limits) {
    for (const resource of allowed.resourceQuantity) {
      const request = quantityValue(value.requests[resource], resource);
      const limit = quantityValue(value.limits[resource], resource);
      if (request !== null && limit !== null && request > limit)
        error(errors, `${path}.requests.${resource}`, `must not exceed the ${resource} limit`, 'range');
    }
  }
  if (value.accelerators !== undefined) {
    if (!Array.isArray(value.accelerators)) error(errors, `${path}.accelerators`, 'must be an array', 'type');
    else
      value.accelerators.forEach((accelerator, index) => {
        const itemPath = `${path}.accelerators[${index}]`;
        if (!strictObject(errors, itemPath, accelerator, allowed.accelerator, ['type', 'count'])) return;
        string(errors, `${itemPath}.type`, accelerator.type, /^[a-z0-9./-]+$/);
        integer(errors, `${itemPath}.count`, accelerator.count, 1, 64);
        string(errors, `${itemPath}.model`, accelerator.model, undefined, false);
      });
  }
}

function validateStorage(errors, value, path) {
  if (!Array.isArray(value)) {
    error(errors, path, 'must be an array', 'type');
    return;
  }
  const names = new Set();
  value.forEach((volume, index) => {
    const itemPath = `${path}[${index}]`;
    if (!strictObject(errors, itemPath, volume, allowed.storage, ['name', 'type', 'mountPath'])) return;
    string(errors, `${itemPath}.name`, volume.name, idPattern);
    enumeration(errors, `${itemPath}.type`, volume.type, enums.storageType);
    string(errors, `${itemPath}.mountPath`, volume.mountPath, /^\//);
    string(errors, `${itemPath}.size`, volume.size, quantityPattern, false);
    string(errors, `${itemPath}.className`, volume.className, undefined, false);
    boolean(errors, `${itemPath}.readOnly`, volume.readOnly, false);
    string(errors, `${itemPath}.sourceRef`, volume.sourceRef, idPattern, false);
    if (['secret', 'config'].includes(volume.type) && !volume.sourceRef)
      error(errors, `${itemPath}.sourceRef`, 'is required for secret and config storage', 'required');
    if (volume.type === 'persistent' && !volume.size)
      error(errors, `${itemPath}.size`, 'is required for persistent storage', 'required');
    if (names.has(volume.name)) error(errors, `${itemPath}.name`, 'must be unique', 'duplicate');
    names.add(volume.name);
  });
}

function validateIdentity(errors, value, path) {
  if (!strictObject(errors, path, value, allowed.identity)) return;
  for (const key of ['serviceAccount', 'providerRoleRef', 'workloadIdentity'])
    string(errors, `${path}.${key}`, value[key], undefined, false);
  boolean(errors, `${path}.automountServiceAccountToken`, value.automountServiceAccountToken, false);
  if (value.automountServiceAccountToken === true)
    error(errors, `${path}.automountServiceAccountToken`, 'must remain false', 'security');
}

function validateTelemetry(errors, value, path, partial = false) {
  if (!strictObject(errors, path, value, allowed.telemetry)) return;
  if (value.metrics !== undefined) {
    if (
      strictObject(
        errors,
        `${path}.metrics`,
        value.metrics,
        allowed.telemetryMetrics,
        partial ? [] : ['enabled']
      )
    ) {
      boolean(errors, `${path}.metrics.enabled`, value.metrics.enabled, !partial);
      string(errors, `${path}.metrics.path`, value.metrics.path, /^\//, false);
      integer(errors, `${path}.metrics.port`, value.metrics.port, 1, 65535, false);
    }
  }
  for (const signal of ['traces', 'logs']) {
    if (value[signal] !== undefined) {
      if (
        strictObject(
          errors,
          `${path}.${signal}`,
          value[signal],
          allowed.telemetrySignal,
          partial ? [] : ['enabled']
        )
      )
        boolean(errors, `${path}.${signal}.enabled`, value[signal].enabled, !partial);
    }
  }
}

function validateLifecycle(errors, value, path, partial = false) {
  if (!strictObject(errors, path, value, allowed.lifecycle)) return;
  integer(
    errors,
    `${path}.terminationGracePeriodSeconds`,
    value.terminationGracePeriodSeconds,
    10,
    86400,
    false
  );
  if (value.preStopCommand !== undefined) stringArray(errors, `${path}.preStopCommand`, value.preStopCommand);
  if (value.drain !== undefined) {
    if (strictObject(errors, `${path}.drain`, value.drain, allowed.drain, partial ? [] : ['enabled'])) {
      boolean(errors, `${path}.drain.enabled`, value.drain.enabled, !partial);
      integer(errors, `${path}.drain.timeoutSeconds`, value.drain.timeoutSeconds, 1, 86400, false);
    }
  }
}

function validateMetric(errors, metric, path) {
  if (!strictObject(errors, path, metric, allowed.metric, ['type', 'target'])) return;
  enumeration(errors, `${path}.type`, metric.type, enums.metricType);
  if (typeof metric.target !== 'number' || metric.target <= 0)
    error(errors, `${path}.target`, 'must be a positive number', 'range');
  for (const key of [
    'sourceRef',
    'query',
    'route',
    'queue',
    'topic',
    'stream',
    'consumerGroup',
    'metricName',
    'scaler',
    'authenticationRef',
  ])
    string(errors, `${path}.${key}`, metric[key], undefined, false);
  stringMap(errors, `${path}.metadata`, metric.metadata, { required: false });
  if (['rps', 'rabbitmq', 'sqs', 'pubsub', 'redis', 'kafka', 'nats', 'external'].includes(metric.type)) {
    if (!metric.sourceRef)
      error(errors, `${path}.sourceRef`, `is required for ${metric.type} metrics`, 'required');
  }
  if (metric.type === 'rps' && !metric.query)
    error(errors, `${path}.query`, 'is required for RPS metrics', 'required');
  if (metric.type === 'external' && !metric.metricName)
    error(errors, `${path}.metricName`, 'is required for external metrics', 'required');
  if (metric.type === 'keda' && !metric.scaler)
    error(errors, `${path}.scaler`, 'is required for generic KEDA metrics', 'required');
  for (const key of Object.keys(metric.metadata ?? {})) {
    if (isSecretLikeKey(key))
      error(
        errors,
        `${path}.metadata.${key}`,
        'must use authenticationRef or an external reference',
        'security'
      );
  }
}

function validateScaling(errors, value, path, partial = false, suspended = false) {
  if (!strictObject(errors, path, value, allowed.scaling, partial ? [] : ['mode'])) return;
  enumeration(errors, `${path}.mode`, value.mode, enums.scalingMode, !partial);
  integer(
    errors,
    `${path}.minReplicas`,
    value.minReplicas,
    partial || suspended || value.mode === 'keda' ? 0 : 1,
    1000,
    false
  );
  integer(errors, `${path}.maxReplicas`, value.maxReplicas, 1, 1000, false);
  integer(errors, `${path}.pollingInterval`, value.pollingInterval, 1, 3600, false);
  integer(errors, `${path}.cooldownPeriod`, value.cooldownPeriod, 0, 86400, false);
  if (Number.isInteger(value.minReplicas) && Number.isInteger(value.maxReplicas)) {
    if (value.minReplicas > value.maxReplicas)
      error(errors, `${path}.maxReplicas`, 'must be at least minReplicas', 'range');
  }
  if (value.metrics !== undefined) {
    if (!Array.isArray(value.metrics)) error(errors, `${path}.metrics`, 'must be an array', 'type');
    else
      value.metrics.forEach((metric, index) => validateMetric(errors, metric, `${path}.metrics[${index}]`));
  }
  if (!partial && value.mode !== 'none' && (value.metrics?.length ?? 0) === 0)
    error(errors, `${path}.metrics`, 'must contain at least one metric when scaling is enabled', 'required');
  if (!partial && value.mode === 'hpa' && value.metrics?.some((metric) => metric.type === 'keda'))
    error(errors, `${path}.metrics`, 'generic KEDA metrics require keda mode', 'conflict');
  if (
    !partial &&
    !suspended &&
    value.minReplicas === 0 &&
    !value.metrics?.some((metric) => !['cpu', 'memory'].includes(metric.type))
  )
    error(errors, `${path}.minReplicas`, 'scale to zero requires an external metric', 'conflict');
  if (value.behavior !== undefined) {
    if (strictObject(errors, `${path}.behavior`, value.behavior, allowed.behavior)) {
      for (const key of allowed.behavior)
        integer(errors, `${path}.behavior.${key}`, value.behavior[key], 0, 86400, false);
    }
  }
  if (value.fallback !== undefined) {
    if (
      strictObject(errors, `${path}.fallback`, value.fallback, allowed.fallback, [
        'replicas',
        'failureThreshold',
      ])
    ) {
      integer(errors, `${path}.fallback.replicas`, value.fallback.replicas, 1, 1000);
      integer(errors, `${path}.fallback.failureThreshold`, value.fallback.failureThreshold, 1, 100);
    }
  }
}

function validateAdapterOverrides(errors, value, path) {
  if (!strictObject(errors, path, value, allowed.adapterOverrides)) return;
  if (value.kubernetes !== undefined) {
    const itemPath = `${path}.kubernetes`;
    if (strictObject(errors, itemPath, value.kubernetes, allowed.kubernetesOverride)) {
      string(errors, `${itemPath}.namespace`, value.kubernetes.namespace, idPattern, false);
      string(errors, `${itemPath}.serviceAccountName`, value.kubernetes.serviceAccountName, idPattern, false);
      stringMap(errors, `${itemPath}.nodeSelector`, value.kubernetes.nodeSelector, { required: false });
      if (value.kubernetes.tolerations !== undefined) {
        if (!Array.isArray(value.kubernetes.tolerations))
          error(errors, `${itemPath}.tolerations`, 'must be an array', 'type');
        else
          value.kubernetes.tolerations.forEach((toleration, index) => {
            const tolerationPath = `${itemPath}.tolerations[${index}]`;
            if (!strictObject(errors, tolerationPath, toleration, allowed.toleration, ['key'])) return;
            for (const key of allowed.toleration)
              string(errors, `${tolerationPath}.${key}`, toleration[key], undefined, key === 'key');
          });
      }
    }
  }
  if (value.pm2 !== undefined) {
    const itemPath = `${path}.pm2`;
    if (strictObject(errors, itemPath, value.pm2, allowed.pm2Override)) {
      integer(errors, `${itemPath}.instances`, value.pm2.instances, 1, 256, false);
      enumeration(errors, `${itemPath}.execMode`, value.pm2.execMode, ['fork', 'cluster'], false);
    }
  }
  if (value.coolify !== undefined) {
    const itemPath = `${path}.coolify`;
    if (strictObject(errors, itemPath, value.coolify, allowed.coolifyOverride)) {
      for (const key of allowed.coolifyOverride)
        string(errors, `${itemPath}.${key}`, value.coolify[key], undefined, false);
    }
  }
  if (value.static !== undefined) {
    const itemPath = `${path}.static`;
    if (strictObject(errors, itemPath, value.static, allowed.staticOverride)) {
      for (const key of allowed.staticOverride)
        string(errors, `${itemPath}.${key}`, value.static[key], undefined, false);
    }
  }
}

function validatePatch(errors, patch, path) {
  if (patch === null) return;
  if (!strictObject(errors, path, patch, allowed.root)) return;
  const candidate = withoutNullObjectEntries(patch);
  for (const forbidden of [
    '$schema',
    'schemaVersion',
    'enabled',
    'id',
    'kind',
    'profile',
    'variants',
    'environments',
  ]) {
    if (patch[forbidden] !== undefined)
      error(errors, `${path}.${forbidden}`, 'cannot be changed by an overlay', 'immutable');
  }
  if (candidate.build !== undefined) {
    validateBuild(errors, candidate.build, `${path}.build`, true);
    if (candidate.build?.strategy !== undefined)
      error(errors, `${path}.build.strategy`, 'cannot be changed by an overlay', 'immutable');
  }
  if (candidate.runtime !== undefined) {
    validateRuntime(errors, candidate.runtime, `${path}.runtime`, true);
    if (candidate.runtime?.language !== undefined)
      error(errors, `${path}.runtime.language`, 'cannot be changed by an overlay', 'immutable');
  }
  validateOptionalSections(errors, candidate, path, true);
}

function validateVariant(errors, patch, path) {
  if (patch === null) {
    error(errors, path, 'must be an object', 'type');
    return;
  }
  if (!strictObject(errors, path, patch, allowed.root)) return;
  const environmentPatches = patch.environments;
  const basePatch = clone(patch);
  delete basePatch.environments;
  validatePatch(errors, basePatch, path);
  if (environmentPatches !== undefined) {
    if (!object(environmentPatches)) error(errors, `${path}.environments`, 'must be an object', 'type');
    else {
      for (const [name, environmentPatch] of Object.entries(environmentPatches)) {
        string(errors, `${path}.environments.${name}`, name, idPattern);
        validatePatch(errors, environmentPatch, `${path}.environments.${name}`);
      }
    }
  }
}

function validateOptionalSections(errors, value, path, partial = false) {
  if (value.network !== undefined) validateNetwork(errors, value.network, `${path}.network`, partial);
  if (value.probes !== undefined) {
    if (strictObject(errors, `${path}.probes`, value.probes, allowed.probes)) {
      for (const name of allowed.probes)
        if (value.probes[name] !== undefined)
          validateProbe(errors, value.probes[name], `${path}.probes.${name}`, partial);
    }
  }
  if (value.env !== undefined) validateEnv(errors, value.env, `${path}.env`);
  if (value.resources !== undefined) validateResources(errors, value.resources, `${path}.resources`, partial);
  if (value.storage !== undefined) validateStorage(errors, value.storage, `${path}.storage`);
  if (value.identity !== undefined) validateIdentity(errors, value.identity, `${path}.identity`);
  if (value.telemetry !== undefined) validateTelemetry(errors, value.telemetry, `${path}.telemetry`, partial);
  if (value.lifecycle !== undefined) validateLifecycle(errors, value.lifecycle, `${path}.lifecycle`, partial);
  if (value.scaling !== undefined)
    validateScaling(errors, value.scaling, `${path}.scaling`, partial, value.suspended === true);
  if (value.adapterOverrides !== undefined)
    validateAdapterOverrides(errors, value.adapterOverrides, `${path}.adapterOverrides`);
  if (value.labels !== undefined) stringMap(errors, `${path}.labels`, value.labels);
  if (value.suspended !== undefined) boolean(errors, `${path}.suspended`, value.suspended);
}

export function normalizeDeploymentSpecV2(input) {
  return defaultsMerge(input, defaults);
}

export function validateDeploymentSpecV2(input, options = {}) {
  const normalize = options.normalize !== false;
  const value = normalize ? normalizeDeploymentSpecV2(input) : clone(input);
  const errors = [];
  if (
    !strictObject(errors, '$', value, allowed.root, [
      'schemaVersion',
      'enabled',
      'id',
      'kind',
      'build',
      'runtime',
    ])
  )
    return { valid: false, errors, value };
  if (value.schemaVersion !== DEPLOYMENT_SCHEMA_VERSION_V2)
    error(errors, '$.schemaVersion', `must equal ${DEPLOYMENT_SCHEMA_VERSION_V2}`, 'version');
  boolean(errors, '$.enabled', value.enabled);
  string(errors, '$.id', value.id, idPattern);
  enumeration(errors, '$.kind', value.kind, enums.kind);
  string(errors, '$.profile', value.profile, idPattern, false);
  validateBuild(errors, value.build, '$.build', false);
  validateRuntime(errors, value.runtime, '$.runtime', false);
  validateOptionalSections(errors, value, '$');

  if (value.kind === 'cron' && !value.runtime?.cron)
    error(errors, '$.runtime.cron', 'is required for cron workloads', 'required');
  if (value.kind === 'static' && value.build?.strategy !== 'static')
    error(errors, '$.build.strategy', 'must be static for a static workload', 'conflict');
  if (['service', 'model'].includes(value.kind) && value.network?.exposure !== 'none') {
    for (const name of ['readiness', 'liveness']) {
      if (!value.probes?.[name])
        error(errors, `$.probes.${name}`, 'is required for an exposed workload', 'required');
    }
  }
  if (['worker', 'cron', 'job'].includes(value.kind) && value.network?.exposure === 'public')
    error(errors, '$.network.exposure', `${value.kind} workloads cannot be public`, 'security');
  for (const collection of ['variants', 'environments']) {
    if (!object(value[collection])) error(errors, `$.${collection}`, 'must be an object', 'type');
    else {
      for (const [name, patch] of Object.entries(value[collection])) {
        string(errors, `$.${collection}.${name}`, name, idPattern);
        if (collection === 'variants') validateVariant(errors, patch, `$.${collection}.${name}`);
        else validatePatch(errors, patch, `$.${collection}.${name}`);
      }
    }
  }
  return { valid: errors.length === 0, errors, value };
}

export function assertValidDeploymentSpecV2(input, options) {
  const result = validateDeploymentSpecV2(input, options);
  if (!result.valid) throw new DeploymentV2ValidationError(result.errors);
  return result.value;
}

export function validateDeploymentPatchV2(input) {
  const errors = [];
  validatePatch(errors, input, '$');
  return { valid: errors.length === 0, errors, value: clone(input) };
}

export function assertValidDeploymentPatchV2(input) {
  const result = validateDeploymentPatchV2(input);
  if (!result.valid) throw new DeploymentV2ValidationError(result.errors);
  return result.value;
}

export const deploymentV2Enums = enums;
