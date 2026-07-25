# `@monox/provider-gcp`

Produces a deterministic Pulumi Automation API intent for Google Cloud targets. It performs no Google Cloud,
Pulumi or Kubernetes calls in the 0.2 alpha. Authentication is a single `target.bindings.identityRef`
representing the Workload Identity Federation deploy principal. Service-account key JSON and other credential
material are rejected. Secret Manager integration is selected by `target.bindings.secretStoreRef` without
putting secret values in the plan.

`apply`, `rollback` and `destroy` fail with an explicit plan-only error. They never return a successful
receipt or imply that infrastructure changed.

The GKE intent includes private Standard clusters, Dataplane V2, Secret Manager, Workload Identity, managed
Prometheus, control-plane metrics, DCGM metrics and an API server latency alert in Google Cloud Monitoring.
