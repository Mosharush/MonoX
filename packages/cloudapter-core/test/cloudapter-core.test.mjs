import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NoopCloudapter,
  StalePlanError,
  assertCloudapter,
  assertFreshPlan,
  canonicalize,
  createPlan,
  createReceipt,
  deterministicDigest,
  redactSecrets,
} from '../src/index.mjs';

test('canonicalization and digests are independent of object key order', () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(deterministicDigest({ b: 2, a: 1 }), deterministicDigest({ a: 1, b: 2 }));
});

test('redacts credential fields and values but preserves reference names', () => {
  assert.deepEqual(
    redactSecrets({
      apiKey: 'unsafe',
      'client-secret': 'unsafe',
      access_token: 'unsafe',
      privateKey: { value: 'unsafe' },
      serviceAccountKey: ['unsafe'],
      password: 'unsafe',
      secretRef: 'runtime-secret',
      tokenRef: 'runtime-token',
      credentialName: 'runtime-credential',
      tokenizer: 'cl100k_base',
      promptTokens: 1000,
      automountServiceAccountToken: false,
      nested: { token: 'unsafe' },
    }),
    {
      apiKey: '[REDACTED]',
      'client-secret': '[REDACTED]',
      access_token: '[REDACTED]',
      privateKey: '[REDACTED]',
      serviceAccountKey: '[REDACTED]',
      password: '[REDACTED]',
      secretRef: 'runtime-secret',
      tokenRef: 'runtime-token',
      credentialName: 'runtime-credential',
      tokenizer: 'cl100k_base',
      promptTokens: 1000,
      automountServiceAccountToken: false,
      nested: { token: '[REDACTED]' },
    }
  );
});

test('creates deterministic, deeply immutable plans and receipts', () => {
  const adapter = new NoopCloudapter();
  const input = {
    adapter,
    project: { name: 'example' },
    environment: 'preview',
    target: { id: 'local', provider: 'generic', runtime: 'docker' },
    workloads: [{ deployment: { id: 'api' } }],
    actions: [{ operation: 'render', workload: 'api' }],
    sourceDigest: deterministicDigest({ source: 1 }),
    targetStateDigest: deterministicDigest({ state: 1 }),
  };
  const first = createPlan({ ...input, createdAt: '2026-01-01T00:00:00.000Z' });
  const second = createPlan({ ...input, createdAt: '2026-01-02T00:00:00.000Z' });
  assert.equal(first.digest, second.digest);
  assert(Object.isFrozen(first));
  assert(Object.isFrozen(first.target));
  assertFreshPlan(first, {
    adapter,
    sourceDigest: input.sourceDigest,
    targetStateDigest: input.targetStateDigest,
  });
  const receipt = createReceipt({ plan: first, result: { status: 'applied', changed: true } });
  assert.equal(receipt.planDigest, first.digest);
  assert(Object.isFrozen(receipt.result));
});

test('rejects stale or tampered plans', () => {
  const adapter = new NoopCloudapter();
  const plan = createPlan({
    adapter,
    environment: 'preview',
    target: { id: 'local' },
    sourceDigest: 'sha256:source',
    targetStateDigest: 'sha256:state',
  });
  assert.throws(
    () =>
      assertFreshPlan(plan, {
        adapter,
        sourceDigest: 'sha256:changed',
        targetStateDigest: 'sha256:state',
      }),
    StalePlanError
  );
});

test('NoopCloudapter implements the complete contract without external changes', async () => {
  const adapter = assertCloudapter(new NoopCloudapter({ reason: 'test adapter only' }));
  const context = {
    config: { project: { name: 'example' } },
    environment: 'preview',
    target: { id: 'local' },
    workloads: [{ deployment: { id: 'api' } }],
    sourceDigest: 'sha256:source',
  };
  const plan = await adapter.plan(context);
  const receipt = await adapter.apply(plan, context);
  assert.equal(receipt.result.status, 'noop');
  assert.equal(receipt.result.changed, false);
  assert.equal((await adapter.render(plan, context)).artifacts.length, 0);
});
