import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(appRoot, 'public');
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

function headers(contentType) {
  return {
    'cache-control': contentType.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
    'content-security-policy':
      "default-src 'self'; style-src 'self'; script-src 'none'; frame-ancestors 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'content-type': contentType,
    'permissions-policy': 'camera=(), geolocation=(), microphone=()',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

export function createWebServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://monox.local');

    if (request.method === 'GET' && url.pathname === '/healthz') {
      const body = JSON.stringify({ status: 'ok' });
      response.writeHead(200, {
        ...headers('application/json; charset=utf-8'),
        'content-length': body.length,
      });
      response.end(body);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, headers('text/plain; charset=utf-8'));
      response.end('Method not allowed');
      return;
    }

    const relativePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
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
      response.writeHead(200, { ...headers(contentType), 'content-length': info.size });
      if (request.method === 'HEAD') response.end();
      else createReadStream(resolvedFilePath).pipe(response);
    } catch {
      response.writeHead(404, headers('text/plain; charset=utf-8'));
      response.end('Not found');
    }
  });
}

export async function startWebServer(options = {}) {
  const server = createWebServer();
  const port = Number(options.port ?? process.env.PORT ?? 3001);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

const isEntryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntryPoint) {
  const server = await startWebServer();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : process.env.PORT;
  console.log(`MonoX web listening on http://localhost:${port}`);
}
