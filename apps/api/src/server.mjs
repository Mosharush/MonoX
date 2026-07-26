import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createAppRuntime } from '@monox/app-runtime';
import { jsonResponse, normalizeEnvironment, requestId } from '@monox/shared';

const securityHeaders = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export function createApiServer(options = {}) {
  const environment = normalizeEnvironment(options.environment ?? process.env.MONOX_ENV ?? 'local');
  const startedAt = Date.now();
  const runtime = options.runtime ?? createAppRuntime({ name: '@monox/api', version: '0.2.0' });

  const server = createServer((request, response) => {
    const requestStartedAt = process.hrtime.bigint();
    const id = requestId(request.headers['x-request-id']);
    const url = new URL(request.url ?? '/', 'http://monox.local');
    const headers = { ...securityHeaders, 'x-request-id': id };
    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);

    if (request.method === 'GET' && runtime.handleSystemRequest(request, response)) return;

    response.once('finish', () => {
      runtime.observeRequest({
        method: request.method,
        route: url.pathname === '/api/hello' ? '/api/hello' : 'unmatched',
        statusCode: response.statusCode,
        durationSeconds: Number(process.hrtime.bigint() - requestStartedAt) / 1_000_000_000,
      });
    });

    if (request.method === 'GET' && url.pathname === '/api/hello') {
      return jsonResponse(
        response,
        200,
        {
          message: 'Hello from MonoX',
          environment,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        },
        headers
      );
    }

    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      return jsonResponse(response, 405, { error: 'method_not_allowed', requestId: id }, headers);
    }

    return jsonResponse(response, 404, { error: 'not_found', requestId: id }, headers);
  });

  Object.defineProperty(server, 'monoxRuntime', { value: runtime });
  runtime.attachServer(server);
  return server;
}

export async function startApiServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const server = createApiServer(options);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  server.monoxRuntime.setReady(true);

  return server;
}

const isEntryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntryPoint) {
  const server = await startApiServer();
  server.monoxRuntime.lifecycle.installSignalHandlers();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : process.env.PORT;
  server.monoxRuntime.logger.info('HTTP server listening', { host: 'localhost', port });
}
