import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createAppRuntime } from '@monox/app-runtime';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(appRoot, 'public');
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

function headers(contentType, options = {}) {
  return {
    'cache-control': contentType.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
    'content-security-policy':
      "default-src 'self'; style-src 'self'; script-src 'sha256-yobifisrUX5jmFbF2OJOXGbUsGsYDPdPdkH4ehe2Ll0='; frame-ancestors 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'content-type': contentType,
    'permissions-policy': 'camera=(), geolocation=(), microphone=()',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...(options.language ? { 'content-language': options.language, vary: 'Accept-Language' } : {}),
  };
}

function preferredLanguage(request, url) {
  const explicit = url.searchParams.get('lang');
  if (explicit === 'en' || explicit === 'he') return explicit;
  const candidates = String(request.headers['accept-language'] ?? '')
    .split(',')
    .map((entry, index) => {
      const [tag, ...parameters] = entry.trim().split(';');
      const quality = parameters
        .map((parameter) => /^q=([0-9.]+)$/i.exec(parameter.trim()))
        .find(Boolean)?.[1];
      return { language: tag.toLowerCase().split('-')[0], quality: Number(quality ?? 1), index };
    })
    .filter((entry) => ['en', 'he'].includes(entry.language) && Number.isFinite(entry.quality))
    .sort((left, right) => right.quality - left.quality || left.index - right.index);
  return candidates[0]?.language ?? 'en';
}

export function createWebServer(options = {}) {
  const runtime = options.runtime ?? createAppRuntime({ name: '@monox/web', version: '0.2.0-alpha.1' });
  const server = createServer(async (request, response) => {
    const requestStartedAt = process.hrtime.bigint();
    const url = new URL(request.url ?? '/', 'http://monox.local');
    const language = preferredLanguage(request, url);

    for (const [name, value] of Object.entries(headers('text/plain; charset=utf-8'))) {
      if (name !== 'content-type') response.setHeader(name, value);
    }
    if (request.method === 'GET' && runtime.handleSystemRequest(request, response)) return;

    response.once('finish', () => {
      runtime.observeRequest({
        method: request.method,
        route: url.pathname === '/' ? '/' : 'static',
        statusCode: response.statusCode,
        durationSeconds: Number(process.hrtime.bigint() - requestStartedAt) / 1_000_000_000,
      });
    });

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, headers('text/plain; charset=utf-8'));
      response.end('Method not allowed');
      return;
    }

    const relativePath =
      url.pathname === '/' || url.pathname === '/index.html'
        ? language === 'he'
          ? 'index.he.html'
          : 'index.html'
        : url.pathname.slice(1);
    const filePath = path.resolve(publicRoot, relativePath);
    if (!filePath.startsWith(`${publicRoot}${path.sep}`)) {
      response.writeHead(400, headers('text/plain; charset=utf-8'));
      response.end('Invalid path');
      return;
    }

    try {
      const [resolvedPublicRoot, resolvedFilePath] = await Promise.all([
        realpath(publicRoot),
        realpath(filePath),
      ]);
      if (!resolvedFilePath.startsWith(`${resolvedPublicRoot}${path.sep}`)) {
        response.writeHead(400, headers('text/plain; charset=utf-8'));
        response.end('Invalid path');
        return;
      }

      const contentType = contentTypes.get(path.extname(resolvedFilePath));
      if (!contentType) {
        response.writeHead(404, headers('text/plain; charset=utf-8'));
        response.end('Not found');
        return;
      }

      const info = await stat(resolvedFilePath);
      if (!info.isFile()) throw new Error('Not a file');
      response.writeHead(200, {
        ...headers(contentType, { language: contentType.startsWith('text/html') ? language : undefined }),
        'content-length': info.size,
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(resolvedFilePath).pipe(response);
    } catch {
      response.writeHead(404, headers('text/plain; charset=utf-8'));
      response.end('Not found');
    }
  });

  Object.defineProperty(server, 'monoxRuntime', { value: runtime });
  runtime.attachServer(server);
  return server;
}

export async function startWebServer(options = {}) {
  const server = createWebServer(options);
  const port = Number(options.port ?? process.env.PORT ?? 3001);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  server.monoxRuntime.setReady(true);
  return server;
}

const isEntryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntryPoint) {
  const server = await startWebServer();
  server.monoxRuntime.lifecycle.installSignalHandlers();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : process.env.PORT;
  server.monoxRuntime.logger.info('HTTP server listening', { host: 'localhost', port });
}
