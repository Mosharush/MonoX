# `@monox/deploy-schema`

`@monox/deploy-schema` defines the provider-neutral workload contracts used by MonoX renderers. Version 1
remains immutable at `schema/v1/deployment.schema.json`. Package-owned version 2 lives at
`schema/v2/deployment.schema.json`, has generated TypeScript declarations and is enforced by a dependency-free
JavaScript validator.

Version 1 describes one Kubernetes application workload:

- immutable container image coordinates
- namespace and dedicated ServiceAccount
- Service and optional Ingress
- startup, readiness and liveness probes
- CPU and memory requests and limits
- rolling updates, topology spread and a PodDisruptionBudget
- an isolating NetworkPolicy with explicit ingress and egress rules
- HPA or optional KEDA autoscaling, including KEDA scale to zero

Secret values are deliberately not part of the schema. `container.envFromSecrets` accepts only names of
Secrets created by an external secret manager or cluster operator. Secret-like names in inline `env` entries
are rejected.

## API

```js
import {
  assertValidDeploymentConfig,
  deploymentSchema,
  validateDeploymentConfig,
} from '@monox/deploy-schema';

const result = validateDeploymentConfig(candidate);
if (!result.valid) console.error(result.errors);

const normalized = assertValidDeploymentConfig(candidate);
```

`validateDeploymentConfig` returns `{ valid, errors, value }`. `value` contains normalized defaults and can be
passed directly to `@monox/kube-renderer`. Each error contains a JSON-style path, message and stable code.

For version 2:

```js
import {
  assertValidDeploymentSpecV2,
  validateDeploymentPatchV2,
  validateDeploymentSpecV2,
} from '@monox/deploy-schema';

const result = validateDeploymentSpecV2(packageJson.deployment);
const workload = assertValidDeploymentSpecV2(packageJson.deployment);
```

Version 2 models build and runtime intent, network exposure, HTTP/TCP/exec probes, non-secret environment
values, external secret references, CPU, memory, storage and accelerators, telemetry, lifecycle and typed
autoscaling metrics. Environment and variant overlays are strict RFC 7396 patches. Unknown properties and
changes to identity, kind, build strategy or runtime language are rejected.

## Security boundaries

- `latest` images are rejected.
- The default ServiceAccount cannot be selected.
- resource requests cannot exceed limits.
- HPA cannot scale to zero; KEDA can.
- NetworkPolicy peers cannot be empty wildcards.
- KEDA credentials must use `authenticationRef` or an external environment reference.
- no provider account, cluster, registry credential or secret value is represented by this contract.
- credential-like keys are detected across camelCase, kebab-case and snake_case, while explicit `Ref`, `Name`,
  `Id` and `FromEnv` fields remain valid references.
- `package.json.deployment` contains portable workload intent. Provider target bindings stay in
  `monox.config.json`.
- suspended workloads are explicit and independent from their normal scaling bounds.

JSON Schema and generated type parity is checked with:

```bash
node packages/deploy-schema/scripts/generate-types.mjs --check
```

Run the package tests with:

```bash
node --test packages/deploy-schema/test
```
