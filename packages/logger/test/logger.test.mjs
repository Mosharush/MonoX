import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger, redact } from '../src/index.mjs';

test('redacts nested credential-like fields without mutating input', () => {
  const input = {
    database: { password: 'unsafe', host: 'db' },
    apiKey: 'unsafe',
    'client-secret': 'unsafe',
    access_token: 'unsafe',
    privateKey: { value: 'unsafe' },
    serviceAccountKey: ['unsafe'],
    token: 'unsafe',
    tokenRef: 'runtime-token',
    secretRef: 'runtime-secret',
    credentialName: 'runtime-credential',
    tokenizer: 'cl100k_base',
    completionTokenCount: 1000,
    automountServiceAccountToken: false,
  };
  assert.deepEqual(redact(input), {
    database: { password: '[REDACTED]', host: 'db' },
    apiKey: '[REDACTED]',
    'client-secret': '[REDACTED]',
    access_token: '[REDACTED]',
    privateKey: '[REDACTED]',
    serviceAccountKey: '[REDACTED]',
    token: '[REDACTED]',
    tokenRef: 'runtime-token',
    secretRef: 'runtime-secret',
    credentialName: 'runtime-credential',
    tokenizer: 'cl100k_base',
    completionTokenCount: 1000,
    automountServiceAccountToken: false,
  });
  assert.equal(input.database.password, 'unsafe');
});

test('redacts known credential values even under neutral keys', () => {
  assert.deepEqual(redact({ header: 'Bearer unsafe' }), { header: '[REDACTED]' });
});

test('emits immutable structured child context and respects level', () => {
  const records = [];
  const logger = createLogger({
    level: 'info',
    context: { service: 'api' },
    sink: (record) => records.push(record),
    now: () => '2026-07-25T00:00:00.000Z',
  });
  assert.equal(logger.debug('hidden'), false);
  logger.child({ requestId: 'r1' }).info('ready', { authorization: 'unsafe' });
  assert.deepEqual(records, [
    {
      timestamp: '2026-07-25T00:00:00.000Z',
      level: 'info',
      message: 'ready',
      service: 'api',
      requestId: 'r1',
      authorization: '[REDACTED]',
    },
  ]);
});
