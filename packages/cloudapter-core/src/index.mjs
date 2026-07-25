import { createHash } from 'node:crypto';

export const CLOUDAPTER_API_VERSION = '1';
export const PLAN_SCHEMA_VERSION = '1';
export const RECEIPT_SCHEMA_VERSION = '1';

const requiredMethods = ['doctor', 'validate', 'plan', 'render', 'apply', 'status', 'rollback', 'destroy'];
const sensitiveValue = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\b(?:glpat|sk)-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:Basic|Bearer)[\t ]+[^\s,;"']+/i,
  /\bauthorization[\t ]*(?::|=)[\t ]*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@[^\s/?#]+/i,
  /(?:^|[?&#;])(?:access[_-]?token|api[_-]?key|client[_-]?secret|credential|id[_-]?token|password|passwd|refresh[_-]?token|secret|signature|token|x-amz-(?:credential|signature)|x-goog-(?:credential|signature))=[^&#;\s]+/i,
];

const directSecretWords = new Set([
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'passwd',
  'password',
  'secret',
  'secrets',
]);
const referenceSuffixes = new Set([
  'id',
  'ids',
  'identifier',
  'identifiers',
  'name',
  'names',
  'ref',
  'refs',
  'reference',
  'references',
]);
const tokenUsageWords = new Set([
  'budget',
  'budgets',
  'completion',
  'count',
  'counts',
  'input',
  'limit',
  'limits',
  'max',
  'output',
  'prompt',
  'rate',
  'total',
  'usage',
  'used',
]);
const compactSecretKeys = new Set([
  'accesstoken',
  'apikey',
  'clientsecret',
  'privatekey',
  'serviceaccountkey',
]);

function keyWords(value) {
  return String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function containsSequence(parts, expected) {
  return parts.some((_, index) => expected.every((word, offset) => parts[index + offset] === word));
}

function isSecretReferenceKey(key) {
  const parts = keyWords(key);
  if (parts.length === 0) return false;
  if (referenceSuffixes.has(parts.at(-1))) return true;
  if (parts.at(-2) === 'from' && parts.at(-1) === 'env') return true;
  return (
    (parts.length === 2 && parts[0] === 'pull' && parts[1] === 'secrets') ||
    (parts.length === 3 && parts[0] === 'env' && parts[1] === 'from' && parts[2] === 'secrets')
  );
}

function isSecretLikeKey(key) {
  const parts = keyWords(key);
  if (parts.length === 0 || isSecretReferenceKey(key)) return false;
  if (parts.length === 1 && compactSecretKeys.has(parts[0])) return true;
  if (parts.some((part) => directSecretWords.has(part))) return true;
  if (
    containsSequence(parts, ['api', 'key']) ||
    containsSequence(parts, ['private', 'key']) ||
    containsSequence(parts, ['service', 'account', 'key'])
  )
    return true;
  if (!parts.some((part) => part === 'token' || part === 'tokens')) return false;
  const context = parts.filter((part) => part !== 'token' && part !== 'tokens');
  return context.length === 0 || !context.every((part) => tokenUsageWords.has(part));
}

function isTokenAutomountPolicy(key, value) {
  return typeof value === 'boolean' && keyWords(key).join(' ') === 'automount service account token';
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsSecretMaterial(value) {
  return typeof value === 'string' && sensitiveValue.some((pattern) => pattern.test(value));
}

function jsonValue(value, path = '$') {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite numbers`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`));
  if (!plainObject(value)) throw new TypeError(`${path} must contain only JSON values`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = jsonValue(value[key], `${path}.${key}`);
  }
  return result;
}

export function canonicalize(value) {
  return JSON.stringify(jsonValue(value));
}

export function deterministicDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

export function redactSecrets(value, key = '') {
  if (value === undefined) return undefined;
  if (key && isSecretLikeKey(key) && !isTokenAutomountPolicy(key, value)) return '[REDACTED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (containsSecretMaterial(value)) return '[REDACTED]';
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, key));
  if (!plainObject(value)) throw new TypeError('Plan data must contain only JSON values');
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([childKey, item]) => [childKey, redactSecrets(item, childKey)])
  );
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function adapterDescriptor(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('adapter is required');
  if (typeof adapter.id !== 'string' || !adapter.id) throw new TypeError('adapter.id is required');
  if (typeof adapter.version !== 'string' || !adapter.version)
    throw new TypeError('adapter.version is required');
  const descriptor = {
    id: adapter.id,
    version: adapter.version,
    apiVersion: adapter.apiVersion ?? CLOUDAPTER_API_VERSION,
    capabilities: [...(adapter.capabilities ?? [])].sort(),
  };
  return { ...descriptor, digest: deterministicDigest(descriptor) };
}

export function assertCloudapter(adapter) {
  const descriptor = adapterDescriptor(adapter);
  if (descriptor.apiVersion !== CLOUDAPTER_API_VERSION)
    throw new TypeError(`Cloudapter ${descriptor.id} uses unsupported API ${descriptor.apiVersion}`);
  for (const method of requiredMethods) {
    if (typeof adapter[method] !== 'function')
      throw new TypeError(`Cloudapter ${descriptor.id} must implement ${method}()`);
  }
  return adapter;
}

function requiredString(name, value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

export function createPlan({
  adapter,
  project,
  environment,
  target,
  workloads = [],
  actions = [],
  sourceDigest,
  targetStateDigest,
  createdAt = new Date().toISOString(),
  metadata = {},
}) {
  const descriptor = adapterDescriptor(adapter);
  requiredString('environment', environment);
  if (!plainObject(target) || typeof target.id !== 'string')
    throw new TypeError('target with an id is required');
  const content = redactSecrets({
    adapter: descriptor,
    project: project ?? {},
    environment,
    target,
    workloads,
    actions,
    sourceDigest: requiredString('sourceDigest', sourceDigest),
    targetStateDigest: requiredString('targetStateDigest', targetStateDigest),
    metadata,
  });
  const digest = deterministicDigest(content);
  return deepFreeze({
    schemaVersion: PLAN_SCHEMA_VERSION,
    kind: 'MonoXPlan',
    id: digest,
    createdAt: redactSecrets(createdAt),
    ...content,
    digest,
  });
}

export class StalePlanError extends Error {
  constructor(reasons) {
    super(`Plan is stale:\n${reasons.map((reason) => `- ${reason}`).join('\n')}`);
    this.name = 'StalePlanError';
    this.reasons = reasons;
  }
}

export function assertFreshPlan(plan, { adapter, sourceDigest, targetStateDigest }) {
  if (!plainObject(plan) || plan.kind !== 'MonoXPlan') throw new TypeError('A MonoXPlan is required');
  const reasons = [];
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) reasons.push('plan schema version is unsupported');
  if (plan.id !== plan.digest) reasons.push('plan id does not match its digest');
  const descriptor = adapterDescriptor(adapter);
  if (plan.adapter?.digest !== descriptor.digest) reasons.push('adapter digest changed');
  if (plan.sourceDigest !== sourceDigest) reasons.push('source digest changed');
  if (plan.targetStateDigest !== targetStateDigest) reasons.push('target state digest changed');
  const { schemaVersion, kind, id, createdAt, digest, ...content } = plan;
  void schemaVersion;
  void kind;
  void id;
  void createdAt;
  if (digest !== deterministicDigest(content)) reasons.push('plan content digest is invalid');
  if (reasons.length) throw new StalePlanError(reasons);
  return plan;
}

export function createReceipt({
  plan,
  operation = 'apply',
  result = {},
  createdAt = new Date().toISOString(),
}) {
  if (!plainObject(plan) || plan.kind !== 'MonoXPlan' || typeof plan.digest !== 'string')
    throw new TypeError('A MonoXPlan is required');
  const content = redactSecrets({
    planDigest: plan.digest,
    adapter: plan.adapter,
    project: plan.project,
    environment: plan.environment,
    target: plan.target,
    operation,
    result,
  });
  const digest = deterministicDigest(content);
  return deepFreeze({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: 'MonoXReceipt',
    id: digest,
    createdAt: redactSecrets(createdAt),
    ...content,
    digest,
  });
}

export class NoopCloudapter {
  constructor({ id = 'noop', version = '0.2.0-alpha.1', reason = 'No external adapter is configured' } = {}) {
    this.id = id;
    this.version = version;
    this.apiVersion = CLOUDAPTER_API_VERSION;
    this.capabilities = ['plan', 'render', 'status'];
    this.reason = reason;
  }

  async doctor() {
    return {
      ok: true,
      checks: [{ id: 'external-execution', status: 'warning', message: this.reason }],
    };
  }

  async validate() {
    return { valid: true, errors: [], warnings: [this.reason] };
  }

  async plan(context) {
    const targetStateDigest = context.targetStateDigest ?? deterministicDigest({ state: 'unconfigured' });
    return createPlan({
      adapter: this,
      project: context.config?.project,
      environment: context.environment,
      target: context.target,
      workloads: context.workloads,
      actions: context.workloads.map((workload) => ({
        operation: 'noop',
        workload: workload.deployment?.id ?? workload.id,
        reason: this.reason,
      })),
      sourceDigest: context.sourceDigest,
      targetStateDigest,
      metadata: { executionConfigured: false },
    });
  }

  async render(plan) {
    return { planDigest: plan.digest, artifacts: [], warnings: [this.reason] };
  }

  async apply(plan) {
    return createReceipt({
      plan,
      result: { status: 'noop', changed: false, reason: this.reason },
    });
  }

  async status(context) {
    return {
      adapter: this.id,
      environment: context.environment,
      target: context.target?.id,
      status: 'unconfigured',
      changed: false,
      reason: this.reason,
    };
  }

  async rollback(request, context) {
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'rollback',
      result: { status: 'noop', changed: false, reason: this.reason },
    });
  }

  async destroy(request, context) {
    const plan = request.plan ?? (await this.plan(context));
    return createReceipt({
      plan,
      operation: 'destroy',
      result: { status: 'noop', changed: false, reason: this.reason },
    });
  }
}

export class PlanOnlyCloudapter {
  constructor({ id, version, capabilities = ['plan', 'render'], executor } = {}) {
    this.id = requiredString('id', id);
    this.version = requiredString('version', version);
    this.apiVersion = CLOUDAPTER_API_VERSION;
    this.capabilities = [...capabilities];
    this.executor = executor;
  }

  async doctor() {
    return {
      ok: true,
      checks: [
        {
          id: 'executor',
          status: this.executor ? 'pass' : 'warning',
          message: this.executor ? 'External executor is configured' : 'Plan and render only',
        },
      ],
    };
  }

  async validate() {
    return { valid: true, errors: [], warnings: this.executor ? [] : ['Plan and render only'] };
  }

  async plan() {
    throw new TypeError(`${this.id} must implement plan()`);
  }

  async render() {
    throw new TypeError(`${this.id} must implement render()`);
  }

  async apply(plan, context) {
    if (typeof this.executor?.apply !== 'function')
      throw new TypeError(`${this.id} has no apply executor configured`);
    return this.executor.apply(plan, context);
  }

  async status(context) {
    if (typeof this.executor?.status !== 'function')
      return { adapter: this.id, status: 'plan-only', changed: false };
    return this.executor.status(context);
  }

  async rollback(request, context) {
    if (typeof this.executor?.rollback !== 'function')
      throw new TypeError(`${this.id} has no rollback executor configured`);
    return this.executor.rollback(request, context);
  }

  async destroy(request, context) {
    if (typeof this.executor?.destroy !== 'function')
      throw new TypeError(`${this.id} has no destroy executor configured`);
    return this.executor.destroy(request, context);
  }
}

export function createNoopCloudapter(options) {
  return assertCloudapter(new NoopCloudapter(options));
}
