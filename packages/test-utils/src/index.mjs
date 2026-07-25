import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function withTempDirectory(callback, options = {}) {
  const root = await mkdtemp(path.join(options.parent ?? os.tmpdir(), options.prefix ?? 'monox-test-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function waitFor(assertion, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 20;
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const result = await assertion();
      if (result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError ?? new Error(`Condition was not met within ${timeoutMs}ms`);
}

export function captureResponse() {
  return {
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk));
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
      this.body = Buffer.concat(this.chunks).toString('utf8');
    },
  };
}
