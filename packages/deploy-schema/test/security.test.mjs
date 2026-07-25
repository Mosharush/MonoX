import assert from 'node:assert/strict';
import test from 'node:test';

import { containsSecretMaterial, isSecretLikeKey, isSecretReferenceKey } from '../src/security.mjs';

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
  assert.equal(containsSecretMaterial(`npm_${'a'.repeat(24)}`), true);
  assert.equal(containsSecretMaterial('tokenizer'), false);
});
