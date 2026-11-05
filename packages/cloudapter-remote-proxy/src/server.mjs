import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent as HttpAgent, createServer, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

import {
  MAX_BODY_BYTES,
  classifyDestination,
  forwardedRequestHeaders,
  isBlockedAddress,
  isProductionContext,
  resolveDestination,
  sanitizedResponseHeaders,
  validateRemoteProxyConfig,
} from './policy.mjs';

const METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const UPSTREAM_TIMEOUT_MS = 10_000;

export async function systemLookup(hostname) {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
}

export function createPinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    if (options && typeof options === 'object' && options.all) {
      done(null, [{ address, family }]);
      return;
    }
    done(null, address, family);
  };
}

function nodeRequest(operation) {
  if (!operation.address || isBlockedAddress(operation.address)) {
    return Promise.reject(new Error('refusing blocked address'));
  }
  const secure = operation.protocol === 'https:';
  const agent = secure
    ? new HttpsAgent({ keepAlive: false, maxSockets: 1 })
    : new HttpAgent({ keepAlive: false, maxSockets: 1 });
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(
      {
        agent,
        autoSelectFamily: false,
        headers: operation.headers,
        host: operation.address,
        lookup: createPinnedLookup(operation.address, operation.family),
        method: operation.method,
        path: operation.path,
        port: operation.port,
        servername: operation.hostname,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            response.destroy();
            reject(new Error('response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          agent.destroy();
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', (error) => {
          agent.destroy();
          reject(error);
        });
      }
    );
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      agent.destroy();
      reject(error);
    });
    if (operation.body && operation.method !== 'GET' && operation.method !== 'HEAD')
      req.write(operation.body);
    req.end();
  });
}

export function createPinnedTransport({ requestImpl = nodeRequest } = {}) {
  return function pinnedTransport(operation) {
    const target = new URL(operation.url);
    const selected = operation.addresses?.[0];
    if (!selected || isBlockedAddress(selected.address)) {
      return Promise.reject(new Error('refusing blocked address'));
    }
    return requestImpl({
      protocol: target.protocol,
      method: operation.method,
      hostname: target.hostname,
      port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
      path: `${target.pathname}${target.search}`,
      headers: operation.headers,
      body: operation.body ?? '',
      address: selected.address,
      family: selected.family,
    });
  };
}

function denied(kind) {
  const body =
    kind === 'disabled' ? 'proxy disabled' : kind === 'redirect' ? 'redirect denied' : 'destination denied';
  return { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' }, body, followed: false };
}

function headerValue(headers, name) {
  if (!headers) return '';
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(value)) return String(value[0] ?? '');
  return value === undefined || value === null ? '' : String(value);
}

async function inspectUpstream(response, requestUrl, config, lookup) {
  const status = Number(response?.status);
  const location = headerValue(response?.headers, 'location');
  if (location || (status >= 300 && status < 400)) {
    if (!location) return denied('redirect');
    const redirect = classifyDestination(config, location, requestUrl);
    if (!redirect.ok) return denied('redirect');
    const resolved = await resolveDestination(redirect.destination, lookup);
    if (!resolved.ok) return denied('redirect');
    return {
      status,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        location: redirect.destination.href,
      },
      body: '',
      followed: false,
    };
  }
  const body = typeof response?.body === 'string' ? response.body : '';
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return { status: 502, headers: {}, body: 'upstream failed' };
  return {
    status: Number.isInteger(status) ? status : 502,
    headers: {
      ...sanitizedResponseHeaders(response?.headers),
      'content-type': headerValue(response?.headers, 'content-type') || 'text/plain; charset=utf-8',
    },
    body,
    followed: false,
  };
}

export async function forwardThroughProxy({
  config,
  method = 'GET',
  url,
  headers,
  body = '',
  lookup,
  transport,
  context = {},
}) {
  if (!METHODS.has(method) || method === 'TRACE')
    return { status: 405, headers: { allow: [...METHODS].join(', ') }, body: 'method not allowed' };
  if (isProductionContext(context)) return denied('disabled');
  const classified = classifyDestination(config, url);
  if (!classified.ok) return denied(classified.reason === 'disabled' ? 'disabled' : 'destination');
  if (Buffer.byteLength(body) > MAX_BODY_BYTES)
    return { status: 413, headers: {}, body: 'request too large' };
  const resolved = await resolveDestination(classified.destination, lookup);
  if (!resolved.ok) return denied('destination');
  let response;
  try {
    response = await transport({
      method,
      url: classified.destination.href,
      headers: forwardedRequestHeaders(headers, classified.destination),
      body,
      addresses: resolved.addresses,
    });
  } catch {
    return { status: 502, headers: {}, body: 'upstream failed' };
  }
  return inspectUpstream(response, classified.destination.href, config, lookup);
}

function readBody(request) {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Promise.reject(Object.assign(new Error('request too large'), { statusCode: 413 }));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(Object.assign(new Error('request too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function handleRequest(request, config, lookup, transport, context) {
  if (request.method === 'CONNECT' || request.method === 'TRACE' || !METHODS.has(request.method)) {
    return { status: 405, headers: { allow: [...METHODS].join(', ') }, body: 'method not allowed' };
  }
  let body = '';
  try {
    body = await readBody(request);
  } catch (error) {
    if (error.statusCode === 413) return { status: 413, headers: {}, body: 'request too large' };
    return { status: 400, headers: {}, body: 'destination denied' };
  }
  return forwardThroughProxy({
    config,
    method: request.method,
    url: request.url,
    headers: request.headers,
    body,
    lookup,
    transport,
    context,
  });
}

export async function startRemoteProxyServer({
  config,
  lookup = systemLookup,
  transport,
  context = {},
} = {}) {
  const validation = validateRemoteProxyConfig(config);
  if (!validation.valid)
    throw new TypeError(`Remote proxy config is invalid: ${validation.errors.join('; ')}`);
  if (validation.value.enabled !== true) throw new TypeError('Remote proxy is disabled');
  if (isProductionContext(context)) throw new TypeError('Remote proxy cannot be enabled for production');
  const upstream = transport ?? createPinnedTransport();
  const server = createServer((request, response) => {
    handleRequest(request, validation.value, lookup, upstream, context)
      .then((result) => {
        if (response.writableEnded) return;
        response.writeHead(result.status, result.headers);
        response.end(result.body ?? '');
      })
      .catch(() => {
        if (response.headersSent || response.writableEnded) return;
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('upstream failed');
      });
  });
  server.on('connect', (_request, socket) => {
    socket.end(
      'HTTP/1.1 405 Method Not Allowed\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: 18\r\n\r\nmethod not allowed'
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(validation.value.listen.port, validation.value.listen.host, resolve);
  });
  const address = server.address();
  return {
    address: { host: validation.value.listen.host, port: address.port },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
