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

function words(value) {
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

export function isSecretReferenceKey(key) {
  const parts = words(key);
  if (parts.length === 0) return false;
  if (referenceSuffixes.has(parts.at(-1))) return true;
  if (parts.at(-2) === 'from' && parts.at(-1) === 'env') return true;
  return (
    (parts.length === 2 && parts[0] === 'pull' && parts[1] === 'secrets') ||
    (parts.length === 3 && parts[0] === 'env' && parts[1] === 'from' && parts[2] === 'secrets')
  );
}

export function isSecretLikeKey(key) {
  const parts = words(key);
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

export const secretValuePatterns = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\b(?:glpat|sk)-[A-Za-z0-9_-]{20,}\b/,
  /^Bearer\s+\S+$/i,
]);

export function containsSecretMaterial(value) {
  return typeof value === 'string' && secretValuePatterns.some((candidate) => candidate.test(value));
}
