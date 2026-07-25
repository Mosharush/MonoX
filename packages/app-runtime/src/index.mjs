import { randomUUID } from 'node:crypto';

import { createLifecycle } from '@monox/lifecycle';
import { createLogger } from '@monox/logger';
import { createTelemetry } from '@monox/telemetry';

function safeRequestId(candidate) {
  const value = String(candidate ?? '').trim();
  return value && value.length <= 128 && /^[a-zA-Z0-9._:-]+$/.test(value) ? value : randomUUID();
}

function json(response, statusCode, payload, headers = {}) {
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

export function createAppRuntime(options = {}) {
  const name = options.name ?? 'application';
  const version = options.version ?? 'development';
  const logger = options.logger ?? createLogger({ context: { service: name, version } });
  const telemetry = options.telemetry ?? createTelemetry();
  const lifecycle = options.lifecycle ?? createLifecycle({ timeoutMs: options.shutdownTimeoutMs });
  let ready = false;
  let live = true;

  lifecycle.onShutdown('runtime-liveness', () => {
    live = false;
  });

  function health() {
    return { name, version, ready, live, state: lifecycle.state };
  }

  function handleSystemRequest(request, response) {
    const pathname = new URL(request.url ?? '/', 'http://runtime.local').pathname;
    const requestId = safeRequestId(request.headers?.['x-request-id']);
    const responseHeaders = { 'x-request-id': requestId };
    if (pathname === '/healthz') {
      json(response, ready && live ? 200 : 503, health(), responseHeaders);
      return true;
    }
    if (pathname === '/readyz') {
      json(response, ready ? 200 : 503, { ready }, responseHeaders);
      return true;
    }
    if (pathname === '/livez') {
      json(response, live ? 200 : 503, { live }, responseHeaders);
      return true;
    }
    if (pathname === '/metrics') {
      const body = telemetry.prometheus();
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'x-content-type-options': 'nosniff',
        ...responseHeaders,
      });
      response.end(body);
      return true;
    }
    return false;
  }

  function observeRequest({ method = 'GET', route = 'unknown', statusCode, durationSeconds }) {
    const labels = { method, route, status: String(statusCode) };
    telemetry.increment('monox_http_requests_total', 1, labels);
    telemetry.histogram('monox_http_request_duration_seconds', durationSeconds, labels);
  }

  function attachServer(server) {
    if (!server || typeof server.close !== 'function') throw new TypeError('attachServer requires a server');
    const removeServerHook = lifecycle.onShutdown(
      'http-server',
      () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    );
    const removeReadinessHook = lifecycle.onShutdown('runtime-readiness', () => {
      ready = false;
    });
    return () => {
      removeReadinessHook();
      removeServerHook();
    };
  }

  return Object.freeze({
    name,
    version,
    logger,
    telemetry,
    lifecycle,
    health,
    setReady: (value = true) => {
      ready = Boolean(value);
    },
    setLive: (value = true) => {
      live = Boolean(value);
    },
    requestId: safeRequestId,
    handleSystemRequest,
    observeRequest,
    attachServer,
  });
}
