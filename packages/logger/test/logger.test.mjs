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

test('redacts URI userinfo and embedded authorization material without hiding ordinary URLs', () => {
  const connectionUri = 'postgresql://admin:supersensitive@db/app';
  const input = {
    databaseUrl: connectionUri,
    message: `connection failed for ${connectionUri}`,
    response: 'upstream returned Authorization: Bearer definitely-secret',
    basic: 'request used Basic dXNlcjpwYXNz',
    passwordUrl: 'postgresql://db/app?password=definitely-secret',
    signedUrl: 'https://example.com/object#signature=abcdef',
    publicUrl: 'https://example.com/path?q=public',
    referenceUrl: 'https://example.com/callback?tokenRef=oauth-token&secretRef=vault-secret',
  };

  const output = redact(input);
  assert.deepEqual(output, {
    databaseUrl: '[REDACTED]',
    message: '[REDACTED]',
    response: '[REDACTED]',
    basic: '[REDACTED]',
    passwordUrl: '[REDACTED]',
    signedUrl: '[REDACTED]',
    publicUrl: 'https://example.com/path?q=public',
    referenceUrl: 'https://example.com/callback?tokenRef=oauth-token&secretRef=vault-secret',
  });
  assert.equal(JSON.stringify(output).includes('supersensitive'), false);
});

test('redacts credentials embedded in Error messages and stacks before logging', () => {
  const connectionUri = 'postgresql://db/app?password=supersensitive';
  const records = [];
  const logger = createLogger({ sink: (record) => records.push(record) });
  const error = new Error(`connection failed for ${connectionUri}`);

  logger.error('database request failed', error);

  assert.equal(records.length, 1);
  assert.equal(records[0].error.message, '[REDACTED]');
  assert.equal(records[0].error.stack, '[REDACTED]');
  assert.equal(JSON.stringify(records).includes('supersensitive'), false);
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
