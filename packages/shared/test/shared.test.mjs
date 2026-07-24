import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeEnvironment, requestId } from '../src/index.mjs';

test('normalizes supported environments', () => {
  assert.equal(normalizeEnvironment(' Preview '), 'preview');
  assert.throws(() => normalizeEnvironment('staging'), /Unsupported environment/);
});

test('keeps safe request ids and replaces missing ids', () => {
  assert.equal(requestId('request-1'), 'request-1');
  assert.match(requestId(), /^[0-9a-f-]{36}$/);
  assert.match(requestId('unsafe value'), /^[0-9a-f-]{36}$/);
  assert.match(requestId('line\nbreak'), /^[0-9a-f-]{36}$/);
});
