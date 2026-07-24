# Kubernetes rendering

`example.deployment.json` is a synthetic deployment v1 document. The reserved `.invalid` host and registry are
deliberately non-routable and must be replaced by an operator before deployment.

Validate and render it from the repository root:

```bash
node packages/kube-renderer/src/cli.mjs validate infra/kubernetes/example.deployment.json
node packages/kube-renderer/src/cli.mjs render infra/kubernetes/example.deployment.json \
  --output /tmp/example-manifests.yaml
```

The output is provider-neutral. It can be passed to `kubectl`, GitOps, Pulumi, Terraform or another deployment
adapter after the operator supplies an explicit environment and reviews the diff. This repository
intentionally does not include a credential-bearing provider program.

The example enables Namespace, ServiceAccount, Deployment, Service, Ingress, PodDisruptionBudget, topology
spread, NetworkPolicy and HPA resources. Set `autoscaling.mode` to `keda` and supply external trigger metadata
to use scale to zero. KEDA and referenced authentication resources must already exist in the target cluster.

The NetworkPolicy allows only the selected gateway to reach the application port. Egress is independently
allowlisted for DNS, HTTPS and same-namespace pods. Tighten those switches for workloads with narrower needs.

Rendering does not deploy and does not contact a cluster.
