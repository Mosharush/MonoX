# `@monox/kube-renderer`

`@monox/kube-renderer` turns a validated deployment v1 document or resolved deployment v2 workload wrapper
into deterministic Kubernetes YAML. It uses Node built-ins plus `@monox/deploy-schema`; it does not need Helm,
a cluster connection or provider credentials.

The renderer can produce:

- Namespace and a dedicated ServiceAccount
- Deployment, StatefulSet, Job or CronJob for service, worker, model, static, job and cron intents
- HTTP, TCP or exec probes, bounded resources and a restricted security context
- Service and optional Ingress
- PodDisruptionBudget and topology spread constraints
- ingress and egress NetworkPolicy rules, with default egress limited to cluster DNS and same-namespace pods
- `autoscaling/v2` HPA or KEDA CPU, memory, RPS, queue and custom scaling with bounded fallback
- GPU extended resources, provider-neutral scheduling, persistent storage and per-replica model caches
- optional Prometheus Operator `ServiceMonitor`

Workers with `network.exposure: none` receive no Service and no Ingress. Every pod uses a dedicated
ServiceAccount, disables token automount, runs non-root with a read-only root filesystem, drops all Linux
capabilities and uses the runtime-default seccomp profile. Namespace output enforces the restricted Pod
Security Standard.

`runtime.workingDirectory` remains portable across delivery targets. A relative workspace path leaves the
container image's declared `WORKDIR` unchanged. Kubernetes `workingDir` is emitted only when the contract
supplies an explicit absolute container path.

## CLI

From the repository root:

```bash
node packages/kube-renderer/src/cli.mjs validate infra/kubernetes/example.deployment.json
node packages/kube-renderer/src/cli.mjs validate infra/kubernetes/example.v2.deployment.json
node packages/kube-renderer/src/cli.mjs render infra/kubernetes/example.deployment.json
node packages/kube-renderer/src/cli.mjs render infra/kubernetes/example.deployment.json \
  --output /tmp/example-manifests.yaml
```

`validate` never connects to a cluster. `render` writes to standard output unless `--output` is provided. Both
commands fail closed when the document violates the versioned contract.

## Library API

```js
import { buildKubernetesResources, renderKubernetesManifests } from '@monox/kube-renderer';

const resources = buildKubernetesResources(resolvedWorkloadOrV1Config);
const yaml = renderKubernetesManifests(resolvedWorkloadOrV1Config);
```

`buildKubernetesResources` is useful for policy tests and adapters. `renderKubernetesManifests` serializes the
same objects as a stable multi-document YAML stream.

KEDA, the Prometheus Operator, NVIDIA GPU support and referenced `TriggerAuthentication` resources are
cluster-level prerequisites. The renderer emits only workload-owned resources; credentials stay in an external
secret store. RPS scaling requires an explicit Prometheus endpoint URL in the metric `sourceRef`, not from a
credential-bearing workload value.

Long-running workers must enable `lifecycle.drain`, provide `preStopCommand`, and give Kubernetes at least the
declared drain timeout as termination grace. The generated autoscaler uses a five-minute scale-down
stabilization window unless the deployment contract provides a stricter value.

Run the tests with:

```bash
node --test packages/kube-renderer/test/*.test.mjs
```
