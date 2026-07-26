# Kubernetes rendering

`example.deployment.json` is the compatibility deployment v1 fixture. `example.v2.deployment.json` is the
package-owned workload intent used by MonoX 0.2. Reserved `.invalid` hosts and registries are deliberately
non-routable and must be replaced by a selected target before apply.

Validate and render it from the repository root:

```bash
node packages/kube-renderer/src/cli.mjs validate infra/kubernetes/example.deployment.json
node packages/kube-renderer/src/cli.mjs validate infra/kubernetes/example.v2.deployment.json
node packages/kube-renderer/src/cli.mjs render infra/kubernetes/example.deployment.json \
  --output /tmp/example-manifests.yaml
```

The output is provider-neutral. It can be passed to `kubectl`, GitOps, Pulumi, Terraform or another deployment
adapter after the operator supplies an explicit environment and reviews the diff. This repository
intentionally does not include a credential-bearing provider program.

The v2 example enables Namespace, ServiceAccount, Deployment, Service, Ingress, PodDisruptionBudget, topology
spread, NetworkPolicy, HPA and ServiceMonitor resources. KEDA can replace HPA for RPS, queue and custom event
sources, and is required for scale to zero. KEDA and referenced authentication resources must already exist in
the target cluster.

The NetworkPolicy allows the selected gateway and MonoX workloads from the same environment and namespace to
reach application ports. Egress is independently allowlisted for DNS and same-namespace pods. Tighten those
rules for workloads with narrower needs.

Rendering does not deploy and does not contact a cluster. `@monox/cloudapter-kubernetes` also remains offline
until a caller injects an approved cluster transport. It never selects a local kube context implicitly.

## Production defaults

- Restricted Pod Security admission labels, non-root containers, read-only root filesystems and seccomp.
- Dedicated ServiceAccounts with token automount disabled. AWS IRSA and GKE Workload Identity use annotations
  derived from reference-only identity fields.
- Default-deny-friendly NetworkPolicies. Networked workloads accept traffic from namespaces labelled
  `monox.dev/gateway-access=true` and same-namespace pods managed by MonoX for the selected environment.
- Requests, limits, three probes, topology spread and a bounded autoscaler.
- Long-running workers require an explicit drain hook and a termination grace period that covers the drain
  timeout. HPA and KEDA use scale-down stabilization.
- GPU requests use Kubernetes extended resources such as `nvidia.com/gpu`; cloud machine types stay in the
  provider target.
- Persistent model storage becomes a StatefulSet volume claim template, giving every replica its own cache.

## Runtime smoke

`runtime-smoke.deployment.json` is a separate synthetic fixture for CI. The
`scripts/kubernetes-runtime-smoke.sh` check builds the API image, creates an isolated kind cluster, applies
the rendered fixture, waits for rollout, verifies probes and resource policy, and probes the running Service.
The script refuses to reuse an existing cluster name and always deletes the cluster it created.

The smoke fixture proves the baseline on the kind and Kubernetes versions pinned in
`.github/workflows/kubernetes-smoke.yml`. It does not validate Ingress controllers, KEDA, cloud load
balancers, external secret stores, or production cluster capacity.
