import assert from 'node:assert/strict';
import test from 'node:test';

import { containsSecretMaterial, isSecretLikeKey, isSecretReferenceKey } from '../src/security.mjs';
import { validateDeploymentSpecV2 } from '../src/v2.mjs';

test('detects credential keys across common naming styles', () => {
  for (const key of [
    'apiKey',
    'api-key',
    'api_key',
    'APIKEY',
    'clientSecret',
    'client-secret',
    'client_secret',
    'accessToken',
    'access-token',
    'access_token',
    'privateKey',
    'private-key',
    'private_key',
    'serviceAccountKey',
    'service-account-key',
    'service_account_key',
    'password',
  ]) {
    assert.equal(isSecretLikeKey(key), true, key);
  }
});

test('preserves explicit references and avoids token vocabulary false positives', () => {
  for (const key of [
    'tokenRef',
    'secretRef',
    'credentialName',
    'privateKeyId',
    'apiKeyFromEnv',
    'secretRefs',
    'pullSecrets',
    'envFromSecrets',
  ]) {
    assert.equal(isSecretReferenceKey(key), true, key);
    assert.equal(isSecretLikeKey(key), false, key);
  }
  for (const key of [
    'tokenizer',
    'tokenizationMode',
    'promptTokens',
    'completionTokenCount',
    'publicKey',
    'serviceAccount',
  ]) {
    assert.equal(isSecretLikeKey(key), false, key);
  }
});

test('detects known credential value formats without matching ordinary values', () => {
  assert.equal(containsSecretMaterial('Bearer definitely-secret'), true);
  assert.equal(containsSecretMaterial('request failed with Bearer definitely-secret at upstream'), true);
  assert.equal(containsSecretMaterial('Authorization: Basic dXNlcjpwYXNz'), true);
  assert.equal(containsSecretMaterial('authorization=opaque-credential'), true);
  assert.equal(containsSecretMaterial(`npm_${'a'.repeat(24)}`), true);
  assert.equal(containsSecretMaterial('postgresql://admin:supersensitive@db/app'), true);
  for (const value of [
    'https://example.com/api?token=definitely-secret',
    'https://example.com/api?access_token=definitely-secret',
    'https://example.com/api?API_KEY=definitely-secret',
    'postgresql://db/app?password=definitely-secret',
    'https://example.com/api#secret=definitely-secret',
    'https://example.com/api#signature=abcdef',
    'https://example.com/api?credential=definitely-secret',
    'https://example.com/api?X-Amz-Signature=abcdef',
    'https://example.com/api?X-Goog-Credential=example',
  ]) {
    assert.equal(containsSecretMaterial(value), true, value);
  }
  assert.equal(containsSecretMaterial('tokenizer'), false);
  assert.equal(containsSecretMaterial('https://example.com/path?q=public'), false);
  assert.equal(containsSecretMaterial('https://example.com/users/@moshe'), false);
  assert.equal(
    containsSecretMaterial('https://example.com/callback?tokenRef=oauth-token&secretRef=vault-secret'),
    false
  );
  assert.equal(
    containsSecretMaterial(
      'https://example.com/callback?accessTokenRef=oauth-token&credentialName=vault-credential'
    ),
    false
  );
});

test('rejects URI userinfo credentials under a neutral deployment key', () => {
  const result = validateDeploymentSpecV2({
    schemaVersion: '2',
    enabled: true,
    id: 'example-api',
    kind: 'service',
    build: { strategy: 'none' },
    runtime: { language: 'typescript', command: ['node', 'server.mjs'] },
    env: {
      values: { DATABASE_URL: 'postgresql://admin:supersensitive@db/app' },
      secretRefs: [],
    },
  });

  assert.equal(result.valid, false);
  assert(
    result.errors.some((issue) => issue.path === '$.env.values.DATABASE_URL' && issue.code === 'security')
  );
});

test('rejects URI query and fragment credentials under neutral deployment keys', () => {
  for (const [name, value] of [
    ['TOKEN_URL', 'https://example.com/api?token=definitely-secret'],
    ['PASSWORD_URL', 'postgresql://db/app?password=definitely-secret'],
    ['API_KEY_URL', 'https://example.com/api?API_KEY=definitely-secret'],
    ['ACCESS_TOKEN_URL', 'https://example.com/api#access_token=definitely-secret'],
    ['SIGNED_URL', 'https://example.com/object?X-Amz-Credential=example&X-Amz-Signature=abcdef'],
  ]) {
    const result = validateDeploymentSpecV2({
      schemaVersion: '2',
      enabled: true,
      id: 'example-api',
      kind: 'service',
      build: { strategy: 'none' },
      runtime: { language: 'typescript', command: ['node', 'server.mjs'] },
      env: {
        values: { CALLBACK_URL: value },
        secretRefs: [],
      },
    });

    assert.equal(result.valid, false, name);
    assert(
      result.errors.some((issue) => issue.path === '$.env.values.CALLBACK_URL' && issue.code === 'security'),
      name
    );
  }
});
