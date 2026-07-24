# `@monox/kube-renderer`

`@monox/kube-renderer` turns a validated deployment v1 JSON document into deterministic Kubernetes YAML. It
uses Node built-ins plus `@monox/deploy-schema`; it does not need Helm, a cluster connection or provider
credentials.

The renderer can produce:

- Namespace and a dedicated ServiceAccount
- Deployment with rolling updates, three HTTP probes, resources and a restricted security context
- Service and optional Ingress
- PodDisruptionBudget and topology spread constraints
- ingress and egress NetworkPolicy rules
- `autoscaling/v2` HPA or an optional KEDA `ScaledObject` with scale to zero

## CLI

From the repository root:

```bash
node packages/kube-renderer/src/cli.mjs validate infra/kubernetes/example.deployment.json
node packages/kube-renderer/src/cli.mjs render infra/kubernetes/example.deployment.json
node packages/kube-renderer/src/cli.mjs render infra/kubernetes/example.deployment.json \
  --output /tmp/example-manifests.yaml
```

`validate` never connects to a cluster. `render` writes to standard output unless `--output` is provided. Both
commands fail closed when the document violates the versioned contract.

## Library API

```js
import { buildKubernetesResources, renderKubernetesManifests } from '@monox/kube-renderer';

const resources = buildKubernetesResources(deploymentConfig);
const yaml = renderKubernetesManifests(deploymentConfig);
```

`buildKubernetesResources` is useful for policy tests and adapters. `renderKubernetesManifests` serializes the
same objects as a stable multi-document YAML stream.

KEDA itself and any referenced `TriggerAuthentication` are cluster-level prerequisites. The renderer only
emits the application `ScaledObject`; credentials stay in an external secret store.

Run the tests with:

```bash
node --test packages/kube-renderer/test/*.test.mjs
```
