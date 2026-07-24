# Deployment model

MonoX separates build, render and apply.

1. Build produces an immutable image for one workspace.
2. Render combines a validated deployment contract with an environment overlay.
3. Apply is an explicit, protected operation performed by a deployment adapter.

Local development uses Docker Compose. Kubernetes workloads use probes, requests, limits, rolling updates, a
PodDisruptionBudget and a default-deny-friendly NetworkPolicy.

HPA is the default and requires at least one replica. KEDA is opt-in and can scale a workload to zero when its
event source is configured. Both modes require a bounded maximum. Cluster capacity management is a separate
provider responsibility.

Production credentials belong in an external secret store. MonoX configuration may name a Secret or service
account but must never contain the secret value.

CI runtime verification uses a synthetic image and manifest in an ephemeral kind cluster. It applies only to
that disposable cluster, waits for rollout, checks probes and resource policy, and probes the Service before
deleting the cluster. It is evidence that rendered baseline resources run; it is not a production deployment
adapter or proof of provider capacity.

See [ADR 0002](adr/0002-render-is-separate-from-apply.md) for the state-change boundary.
