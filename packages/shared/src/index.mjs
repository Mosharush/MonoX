import { randomUUID } from 'node:crypto';

const environments = new Set(['local', 'preview', 'production']);

export function normalizeEnvironment(value = 'local') {
  const normalized = String(value).trim().toLowerCase();
  if (!environments.has(normalized)) {
    throw new TypeError(`Unsupported environment: ${value}`);
  }
  return normalized;
}

export function requestId(candidate) {
  const value = String(candidate ?? '').trim();
  return value && value.length <= 128 && /^[a-zA-Z0-9._:-]+$/.test(value) ? value : randomUUID();
}

export function jsonResponse(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body);
}
