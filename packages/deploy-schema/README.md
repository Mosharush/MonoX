# `@monox/deploy-schema`

`@monox/deploy-schema` defines the provider-neutral deployment contract used by the Kubernetes renderer.
Version 1 lives at `schema/v1/deployment.schema.json` and is also enforced by a dependency-free JavaScript
validator.

The contract describes one application workload:

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

## Security boundaries

- `latest` images are rejected.
- The default ServiceAccount cannot be selected.
- resource requests cannot exceed limits.
- HPA cannot scale to zero; KEDA can.
- NetworkPolicy peers cannot be empty wildcards.
- KEDA credentials must use `authenticationRef` or an external environment reference.
- no provider account, cluster, registry credential or secret value is represented by this contract.

Run the package tests with:

```bash
node --test packages/deploy-schema/test
```
