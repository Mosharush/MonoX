# `@monox/cloudapter-core`

This package defines the provider-neutral Cloudapter API and the tamper-evident plan and receipt envelopes
used by MonoX delivery commands.

A Cloudapter exposes `doctor`, `validate`, `plan`, `render`, `apply`, `status`, `rollback` and `destroy`.
Adapters receive a resolved context containing the project configuration, selected environment and target, and
resolved workload wrappers. Subprocess arguments and credentials are never represented as shell strings.

```js
import { createPlan, createReceipt } from '@monox/cloudapter-core';

const plan = createPlan({
  adapter,
  project: { name: 'example' },
  environment: 'preview',
  target,
  workloads,
  actions,
  sourceDigest,
  targetStateDigest,
});

const receipt = createReceipt({ plan, result: { status: 'applied', changed: true } });
```

Plan and receipt digests are deterministic over canonical, redacted content. Timestamps are audit metadata and
do not affect content identity. `assertFreshPlan` rejects an apply when source, target state, adapter identity
or plan content changed after planning.

Redaction recognizes camelCase, kebab-case and snake_case credential keys. Explicit references such as
`tokenRef`, `secretRef` and `credentialName` remain visible so a plan can be audited. The boolean
`automountServiceAccountToken` policy also remains intact; it never carries token material.

`NoopCloudapter` is safe for local inspection when external execution is not configured. It never reports a
state change.

`PlanOnlyCloudapter` is a base for renderers that should fail closed for state changes until an explicit
executor is injected.
