import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { captureResponse, waitFor, withTempDirectory } from '../src/index.mjs';

test('cleans an isolated temporary directory', async () => {
  let location;
  await withTempDirectory(async (root) => {
    location = root;
    await writeFile(path.join(root, 'fixture.txt'), 'safe');
  });
  await assert.rejects(() => access(location));
});

test('waits for a bounded condition', async () => {
  let attempts = 0;
  await waitFor(() => ++attempts >= 2, { intervalMs: 1, timeoutMs: 100 });
  assert.equal(attempts, 2);
});

test('captures an HTTP-like response', () => {
  const response = captureResponse();
  response.writeHead(201, { location: '/resource' });
  response.end('created');
  assert.equal(response.statusCode, 201);
  assert.equal(response.body, 'created');
});
