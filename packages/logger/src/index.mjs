const levels = new Map([
  ['debug', 10],
  ['info', 20],
  ['warn', 30],
  ['error', 40],
  ['silent', Number.POSITIVE_INFINITY],
]);

const sensitiveValuePatterns = [
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

function containsSecretMaterial(value) {
  return typeof value === 'string' && sensitiveValuePatterns.some((pattern) => pattern.test(value));
}

function normalizeError(error) {
  return {
    name: error.name,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

export function redact(value, options = {}, seen = new WeakSet()) {
  const replacement = options.replacement ?? '[REDACTED]';
  const sensitiveKeys = options.sensitiveKeys;
  if (value instanceof Error) return redact(normalizeError(value), options, seen);
  if (value === null || typeof value !== 'object') return containsSecretMaterial(value) ? replacement : value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, options, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      (
        sensitiveKeys
          ? sensitiveKeys.some((pattern) => pattern.test(key))
          : isSecretLikeKey(key) && !isTokenAutomountPolicy(key, entry)
      )
        ? replacement
        : redact(entry, options, seen),
    ])
  );
}

function normalizeLevel(level) {
  const value = String(level ?? 'info').toLowerCase();
  if (!levels.has(value)) throw new TypeError(`Unsupported log level: ${level}`);
  return value;
}

export function createLogger(options = {}) {
  const threshold = normalizeLevel(options.level ?? process.env.LOG_LEVEL ?? 'info');
  const sink = options.sink ?? ((record) => process.stdout.write(`${JSON.stringify(record)}\n`));
  const base = Object.freeze({ ...(options.context ?? {}) });
  const now = options.now ?? (() => new Date().toISOString());

  const logger = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (message, context = {}) => {
      if (levels.get(level) < levels.get(threshold)) return false;
      sink(
        redact(
          {
            timestamp: now(),
            level,
            message: String(message),
            ...base,
            ...(context instanceof Error ? { error: context } : context),
          },
          options
        )
      );
      return true;
    };
  }
  logger.child = (context) =>
    createLogger({ ...options, level: threshold, sink, now, context: { ...base, ...context } });
  return Object.freeze(logger);
}
