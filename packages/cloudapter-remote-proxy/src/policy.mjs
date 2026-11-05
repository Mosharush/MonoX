import { isIP, BlockList } from 'node:net';

export const REMOTE_PROXY_SCHEMA_VERSION = '1';
export const MAX_ALLOWLIST_ENTRIES = 32;
export const MAX_BODY_BYTES = 1_048_576;
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1']);

export const BLOCKED_IPV4_SUBNETS = Object.freeze([
  Object.freeze(['0.0.0.0', 8]),
  Object.freeze(['10.0.0.0', 8]),
  Object.freeze(['100.64.0.0', 10]),
  Object.freeze(['127.0.0.0', 8]),
  Object.freeze(['169.254.0.0', 16]),
  Object.freeze(['172.16.0.0', 12]),
  Object.freeze(['192.0.0.0', 24]),
  Object.freeze(['192.0.2.0', 24]),
  Object.freeze(['192.88.99.0', 24]),
  Object.freeze(['192.168.0.0', 16]),
  Object.freeze(['198.18.0.0', 15]),
  Object.freeze(['198.51.100.0', 24]),
  Object.freeze(['203.0.113.0', 24]),
  Object.freeze(['224.0.0.0', 4]),
  Object.freeze(['240.0.0.0', 4]),
]);

export const BLOCKED_IPV6_SUBNETS = Object.freeze([
  Object.freeze(['::', 128]),
  Object.freeze(['::1', 128]),
  Object.freeze(['100::', 64]),
  Object.freeze(['2001:2::', 48]),
  Object.freeze(['2001:20::', 28]),
  Object.freeze(['2001:db8::', 32]),
  Object.freeze(['2002::', 16]),
  Object.freeze(['64:ff9b:1::', 48]),
  Object.freeze(['fc00::', 7]),
  Object.freeze(['fe80::', 10]),
  Object.freeze(['fec0::', 10]),
  Object.freeze(['ff00::', 8]),
]);

const blockedAddresses = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of BLOCKED_IPV6_SUBNETS) blockedAddresses.addSubnet(network, prefix, 'ipv6');

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
]);

const BLOCKED_SUFFIXES = Object.freeze([
  '.arpa',
  '.home',
  '.internal',
  '.intranet',
  '.lan',
  '.local',
  '.localdomain',
  '.localhost',
]);

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SECRET_QUERY = new Set([
  'access_token',
  'api_key',
  'apikey',
  'client_secret',
  'id_token',
  'passwd',
  'password',
  'refresh_token',
  'secret',
  'signature',
  'token',
]);
const SECRET_MATERIAL = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\b(?:glpat|sk)-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:Basic|Bearer)[\t ]+[^\s,;"']+/i,
];
const HOP_BY_HOP = new Set([
  'connection',
  'cookie2',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'set-cookie',
  'set-cookie2',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const CREDENTIAL_HEADER =
  /(?:^|-)(?:authorization|cookie|credential|passwd|password|secret|token|api-key|apikey)(?:$|-)/i;
const CONFIG_FIELDS = new Set(['schemaVersion', 'enabled', 'listen', 'allowlist', 'credentialForwarding']);
const ALLOWLIST_FIELDS = new Set(['protocol', 'host', 'port']);
const LISTEN_FIELDS = new Set(['host', 'port']);

export const REMOTE_PROXY_POLICY = Object.freeze({
  bind: 'loopback-only',
  credentials: 'never-forwarded',
  dns: 'checked-per-request',
  privateRanges: 'denied',
  production: 'forbidden',
  protocols: Object.freeze(['http', 'https']),
  redirects: 'not-followed',
});

function frozenCopy(value) {
  return Object.freeze(structuredClone(value));
}

export function disabledRemoteProxyConfig() {
  return frozenCopy({
    schemaVersion: REMOTE_PROXY_SCHEMA_VERSION,
    enabled: false,
    listen: { host: '127.0.0.1', port: 0 },
    allowlist: [],
    credentialForwarding: 'never',
  });
}

function ipv6Groups(address) {
  const lower = address.toLowerCase();
  if (lower.includes('.')) return null;
  const halves = lower.split('::');
  if (halves.length > 2) return null;
  const expand = (part) => (part ? part.split(':') : []);
  const left = expand(halves[0]);
  const right = halves.length === 2 ? expand(halves[1]) : [];
  if (halves.length === 1) {
    if (left.length !== 8 || left.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
    return left.map((group) => group.padStart(4, '0'));
  }
  if (left.length + right.length > 7) return null;
  if ([...left, ...right].some((group) => group && !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  const middle = Array(8 - left.length - right.length).fill('0000');
  return [...left, ...middle, ...right].map((group) => (group || '0').padStart(4, '0'));
}

function compressIpv6(address) {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let index = 0; index <= groups.length; index += 1) {
    if (index < groups.length && groups[index] === '0000') {
      if (runStart === -1) runStart = index;
    } else if (runStart !== -1) {
      const length = index - runStart;
      if (length > bestLength) {
        bestStart = runStart;
        bestLength = length;
      }
      runStart = -1;
    }
  }
  const compact = groups.map((group) => group.replace(/^0+(?=[0-9a-f])/i, ''));
  if (bestLength < 2) return compact.join(':');
  return `${compact.slice(0, bestStart).join(':')}::${compact.slice(bestStart + bestLength).join(':')}`;
}

export function canonicalIp(address) {
  const bare = String(address)
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0];
  if (!bare || bare.includes('%')) return null;
  const mapped = bare.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) {
    const hex = ipv4ToHex(mapped[1]);
    if (!hex) return null;
    return compressIpv6(`::ffff:${hex}`);
  }
  const family = isIP(bare);
  if (family === 4) return bare;
  if (family === 6) return compressIpv6(bare);
  return null;
}

function ipv4ToHex(address) {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return null;
  const high = ((parts[0] << 8) | parts[1]).toString(16);
  const low = ((parts[2] << 8) | parts[3]).toString(16);
  return `${high}:${low}`;
}

function embeddedNat64(address) {
  const dotted = address.toLowerCase().match(/^64:ff9b::(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const groups = ipv6Groups(address);
  if (!groups) return null;
  if (groups.slice(0, 6).join(':') !== '0064:ff9b:0000:0000:0000:0000') return null;
  const high = Number.parseInt(groups[6], 16);
  const low = Number.parseInt(groups[7], 16);
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

export function isBlockedAddress(address) {
  const bare = String(address)
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0];
  if (!bare || address.includes('%')) return true;
  const nat64 = embeddedNat64(bare);
  if (nat64) return isBlockedAddress(nat64);
  const family = isIP(bare);
  if (family !== 4 && family !== 6) return true;
  return blockedAddresses.check(bare, family === 4 ? 'ipv4' : 'ipv6');
}

function isSpecialUseHost(host) {
  if (BLOCKED_HOSTS.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function canonicalDestinationHost(value) {
  if (typeof value !== 'string') return null;
  let host = value.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || host.includes('/') || host.includes('@') || host.includes(' ') || host.includes('*'))
    return null;
  const ip = canonicalIp(host);
  if (ip) return ip;
  if (!HOSTNAME.test(host) || isSpecialUseHost(host)) return null;
  return host;
}

function integerPort(value, { allowZero = false } = {}) {
  return Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= 65535;
}

export function validateRemoteProxyConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['remote proxy config must be an object'], value: null };
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_FIELDS.has(key)) errors.push(`unknown config field ${key}`);
  }
  if (config.schemaVersion !== REMOTE_PROXY_SCHEMA_VERSION) errors.push('schemaVersion must be 1');
  if (typeof config.enabled !== 'boolean') errors.push('enabled must be false unless explicitly set to true');
  if (config.credentialForwarding !== 'never')
    errors.push('credentialForwarding must be never; credentials are not forwarded');
  if (!config.listen || typeof config.listen !== 'object' || Array.isArray(config.listen))
    errors.push('listen must be an object');
  else {
    for (const key of Object.keys(config.listen)) {
      if (!LISTEN_FIELDS.has(key)) errors.push(`unknown listen field ${key}`);
    }
    if (!LOOPBACK_HOSTS.includes(config.listen.host))
      errors.push('listen.host must be the loopback address 127.0.0.1 or ::1');
    if (!integerPort(config.listen.port, { allowZero: true }))
      errors.push('listen.port must be an integer from 0 through 65535');
  }
  if (!Array.isArray(config.allowlist)) errors.push('allowlist must be an array');
  else if (config.allowlist.length > MAX_ALLOWLIST_ENTRIES)
    errors.push(`allowlist accepts at most ${MAX_ALLOWLIST_ENTRIES} entries`);
  else {
    config.allowlist.forEach((entry, index) => validateAllowlistEntry(entry, index, errors));
  }
  if (errors.length) return { valid: false, errors, value: null };
  return {
    valid: true,
    errors: [],
    value: frozenCopy({
      schemaVersion: REMOTE_PROXY_SCHEMA_VERSION,
      enabled: config.enabled,
      listen: { host: config.listen.host, port: config.listen.port },
      allowlist: config.allowlist.map((entry) => ({
        protocol: entry.protocol,
        host: canonicalDestinationHost(entry.host),
        port: entry.port,
      })),
      credentialForwarding: 'never',
    }),
  };
}

function validateAllowlistEntry(entry, index, errors) {
  const label = `allowlist[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const key of Object.keys(entry)) {
    if (!ALLOWLIST_FIELDS.has(key)) errors.push(`${label} contains unknown field ${key}`);
  }
  if (entry.protocol !== 'http' && entry.protocol !== 'https')
    errors.push(`${label}.protocol must be http or https`);
  const host = canonicalDestinationHost(entry.host);
  if (!host) errors.push(`${label}.host must be an explicit public hostname or IP`);
  else if (canonicalIp(host) && isBlockedAddress(host))
    errors.push(`${label}.host is in a denied address range`);
  if (!integerPort(entry.port)) errors.push(`${label}.port must be an integer from 1 through 65535`);
}

export function isProductionContext(context = {}) {
  if (context.production === true) return true;
  if (context.environment === 'production') return true;
  const selected = context.config?.environments?.[context.environment];
  if (selected?.production === true) return true;
  const nodeEnv = context.nodeEnv === undefined ? process.env.NODE_ENV : context.nodeEnv;
  return nodeEnv === 'production';
}

export function remoteProxyCredentialFindings(value, path = '$') {
  const findings = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      findings.push(...remoteProxyCredentialFindings(item, `${path}[${index}]`))
    );
    return findings;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'credentialForwarding' && CREDENTIAL_HEADER.test(key))
        findings.push(`${path}.${key} is a credential field`);
      findings.push(...remoteProxyCredentialFindings(child, `${path}.${key}`));
    }
    return findings;
  }
  if (typeof value === 'string' && SECRET_MATERIAL.some((pattern) => pattern.test(value)))
    findings.push(`${path} contains credential material`);
  return findings;
}

const PRODUCTION_ARTIFACT = /(?:^|\/)(?:Dockerfile|[^/]+\.Dockerfile)$|infra\/(?:docker|kubernetes)\//;

export function assertRemoteProxyAbsentFromProductionArtifacts(files) {
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
  const errors = [];
  for (const [file, contents] of entries) {
    const text = String(contents);
    if (file.endsWith('remote-proxy.json')) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        errors.push(`${file} is not valid JSON`);
        continue;
      }
      if (parsed.enabled !== false) errors.push(`${file} must stay disabled`);
      const validation = validateRemoteProxyConfig(parsed);
      if (!validation.valid) errors.push(`${file} is invalid: ${validation.errors.join('; ')}`);
      for (const finding of remoteProxyCredentialFindings(parsed)) errors.push(`${file}: ${finding}`);
    }
    if (PRODUCTION_ARTIFACT.test(file) && text.includes('remote-proxy'))
      errors.push(`${file} must not include the local remote proxy`);
    if (file.endsWith('docker-compose.yml') && /^\s*remote-proxy\s*:/m.test(text))
      errors.push(`${file} must not run a remote-proxy service`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return true;
}

function defaultPort(protocol) {
  return protocol === 'https' ? 443 : 80;
}

function displayHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

function queryHasCredentials(url) {
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase().replaceAll('-', '_');
    if (SECRET_QUERY.has(normalized)) return true;
  }
  return false;
}

export function parseProxyDestination(rawUrl, base) {
  let url;
  try {
    url = base ? new URL(rawUrl, base) : new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  const protocol = url.protocol.slice(0, -1);
  if (protocol !== 'http' && protocol !== 'https') return { ok: false, reason: 'protocol' };
  if (url.username || url.password) return { ok: false, reason: 'userinfo' };
  if (queryHasCredentials(url)) return { ok: false, reason: 'credential-query' };
  const host = canonicalDestinationHost(url.hostname);
  if (!host) return { ok: false, reason: 'host' };
  const port = url.port ? Number(url.port) : defaultPort(protocol);
  if (!integerPort(port)) return { ok: false, reason: 'port' };
  const ip = canonicalIp(host);
  if (ip && isBlockedAddress(ip)) return { ok: false, reason: 'blocked-address' };
  url.hash = '';
  return {
    ok: true,
    destination: {
      protocol,
      host,
      port,
      family: ip ? isIP(ip) : 0,
      ip,
      href: url.href,
      path: `${url.pathname}${url.search}`,
    },
  };
}

export function matchAllowlist(allowlist, destination) {
  return allowlist.some(
    (entry) =>
      entry.protocol === destination.protocol &&
      entry.host === destination.host &&
      entry.port === destination.port
  );
}

export function classifyDestination(config, rawUrl, base) {
  const validation = validateRemoteProxyConfig(config);
  if (!validation.valid || validation.value.enabled !== true) return { ok: false, reason: 'disabled' };
  const parsed = parseProxyDestination(rawUrl, base);
  if (!parsed.ok) return parsed;
  if (!matchAllowlist(validation.value.allowlist, parsed.destination))
    return { ok: false, reason: 'not-allowlisted', destination: parsed.destination };
  return { ok: true, destination: parsed.destination, config: validation.value };
}

export async function resolveDestination(destination, lookup) {
  if (destination.ip) {
    if (isBlockedAddress(destination.ip)) return { ok: false, reason: 'blocked-address' };
    return { ok: true, addresses: [{ address: destination.ip, family: destination.family }] };
  }
  let records;
  try {
    records = await lookup(destination.host);
  } catch {
    return { ok: false, reason: 'dns-failed' };
  }
  if (!Array.isArray(records) || records.length === 0) return { ok: false, reason: 'dns-empty' };
  const addresses = [];
  for (const record of records) {
    const address = canonicalIp(record?.address ?? '');
    const family = record?.family === 6 || isIP(address) === 6 ? 6 : 4;
    if (!address || isBlockedAddress(address)) return { ok: false, reason: 'dns-blocked-address' };
    addresses.push({ address, family });
  }
  return { ok: true, addresses };
}

export function credentialHeader(name) {
  return CREDENTIAL_HEADER.test(name);
}

export function forwardedRequestHeaders(headers, destination) {
  const source = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) continue;
    source[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  const removed = new Set(HOP_BY_HOP);
  for (const part of (source.connection ?? '').split(',')) {
    const name = part.trim().toLowerCase();
    if (name) removed.add(name);
  }
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (removed.has(key) || credentialHeader(key) || key === 'host' || key === 'content-length') continue;
    result[key] = value;
  }
  const host = displayHost(destination.host);
  result.host = destination.port === defaultPort(destination.protocol) ? host : `${host}:${destination.port}`;
  return result;
}

export function sanitizedResponseHeaders(headers) {
  const source = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    source[key.toLowerCase()] = value;
  }
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (HOP_BY_HOP.has(key) || credentialHeader(key) || key === 'location' || key === 'set-cookie') continue;
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
  }
  return result;
}
