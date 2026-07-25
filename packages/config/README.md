# `@monox/config`

`@monox/config` validates MonoX project configuration, discovers enabled `package.json.deployment` v2 blocks
and resolves them for one environment and one unambiguous delivery target.

Resolution order is fixed:

1. secure built-in defaults
2. root workload profile
3. package base
4. package environment RFC 7396 patch
5. variant patch
6. variant environment RFC 7396 patch
7. target binding in the resolved wrapper

RFC 7396 means objects merge recursively, arrays replace in full and `null` removes an optional property.
Overlays cannot change the workload `id`, `kind`, build strategy or runtime language.

```js
import { resolveProjectDeployments } from '@monox/config';

const { workloads } = await resolveProjectDeployments({
  root: process.cwd(),
  environment: 'preview',
});
```

Each wrapper has `{ workspace, environment, variant, profile, deployment, target }`. Resolution fails when a
workload matches zero or multiple target bindings. Raw credentials are rejected; configuration may contain
only non-secret values and external secret references.

Add-on configuration checks credential keys across camelCase, kebab-case and snake_case. Reference fields such
as `tokenRef`, `secretRef` and `credentialName` are allowed because they contain identifiers, not secret
values.
