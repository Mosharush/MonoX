import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { jsonResponse, normalizeEnvironment, requestId } from '@monox/shared';

const securityHeaders = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export function createApiServer(options = {}) {
  const environment = normalizeEnvironment(options.environment ?? process.env.MONOX_ENV ?? 'local');
  const startedAt = Date.now();

  return createServer((request, response) => {
    const id = requestId(request.headers['x-request-id']);
    const url = new URL(request.url ?? '/', 'http://monox.local');
    const headers = { ...securityHeaders, 'x-request-id': id };

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return jsonResponse(response, 200, { status: 'ok' }, headers);
    }

    if (request.method === 'GET' && url.pathname === '/readyz') {
      return jsonResponse(response, 200, { status: 'ready', environment }, headers);
    }

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
}

export async function startApiServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const server = createApiServer(options);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return server;
}

const isEntryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntryPoint) {
  const server = await startApiServer();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : process.env.PORT;
  console.log(`MonoX API listening on http://localhost:${port}`);
}
