# MonoX 0.2 deployment model

MonoX separates validation, planning, rendering and external state changes. The `0.2.0-alpha.1` source is safe
to use for contract evaluation and offline artifacts. Local Docker Compose uses a built-in allowlisted
executor; live remote apply remains gated by adapter support and an explicitly injected transport.

## Package-owned deployment contract

A runnable workspace owns one `package.json.deployment` v2 document:

```json
{
  "schemaVersion": "2",
  "enabled": true,
  "id": "api",
  "kind": "service",
  "build": {
    "strategy": "dockerfile",
    "context": ".",
    "dockerfile": "Dockerfile"
  },
  "runtime": {
    "language": "typescript",
    "command": ["node", "dist/server.mjs"]
  },
  "network": {
    "exposure": "internal",
    "ports": [{ "name": "http", "containerPort": 3000 }]
  },
  "probes": {
    "readiness": { "type": "http", "path": "/readyz", "port": "http" },
    "liveness": { "type": "http", "path": "/healthz", "port": "http" }
  },
  "env": {
    "values": { "NODE_ENV": "production" },
    "secretRefs": [{ "name": "api-runtime", "target": "DATABASE_URL" }]
  },
  "resources": {
    "requests": { "cpu": "100m", "memory": "128Mi" },
    "limits": { "cpu": "500m", "memory": "512Mi" },
    "accelerators": []
  },
  "scaling": {
    "mode": "hpa",
    "minReplicas": 2,
    "maxReplicas": 10,
    "metrics": [{ "type": "cpu", "target": 70 }]
  },
  "variants": {},
  "environments": {}
}
```

`env.values` is limited to non-secret strings. Credentials are represented only by `env.secretRefs` and are
resolved by the selected runtime. Unknown fields and secret-like inline values fail validation.

## Root target selection

`monox.config.json` owns environments and target bindings, without duplicating applications:

```json
{
  "schemaVersion": "2",
  "project": {
    "name": "example",
    "workspaceGlobs": ["apps/*", "packages/*"],
    "defaultEnvironment": "local"
  },
  "boundaries": { "apps": ["packages"] },
  "workloadProfiles": {},
  "environments": {
    "local": {
      "bindings": [{ "target": "local-docker", "selector": { "workloads": ["*"] } }]
    }
  },
  "targets": {
    "local-docker": {
      "provider": "generic",
      "provisioner": "none",
      "transport": "local",
      "runtime": "docker"
    }
  },
  "addons": {}
}
```

Resolution fails if an enabled workload or variant matches no target or more than one target in the selected
environment.

## CLI flow

```sh
monox validate
monox config explain api --env local
monox doctor --env local
monox plan --env local --all --output .monox/plans/local.json
monox render --env local --target local-docker --all --output-dir .monox/rendered
monox deploy --env local --all
monox apply --plan .monox/plans/local.json
monox status --env local --target local-docker
monox rollback --env local --target local-docker --revision <revision>
monox destroy --env local --target local-docker --confirm example/local/local-docker
```

`plan`, `render` and `deploy` require exactly one workload selector: `--all`, `--select <ids>` or
`--affected`. Environment selection is explicit. A target is also explicit when a command could otherwise
address more than one target.

`deploy` orchestrates validate, plan and apply in one invocation when the selected adapter has an available
executor. Unsupported remote transports and plan-only providers fail closed. For a non-production environment,
running that command with a selector is the state-change decision. Production state changes additionally
require:

- the environment marked `production: true` and `protected: true`;
- `CI=true`;
- `target.bindings.identityRef` for the approved OIDC or workload identity.

Destroy requires the exact `project/environment/target` confirmation string. The same rule applies to
`monox cloud destroy`. A normal deployment plan does not contain a blanket delete of unmanaged resources.

## Plans and receipts

A plan binds:

- adapter ID, version, API version and adapter digest;
- Git HEAD when available, tracked and non-ignored working-tree bytes, and resolved configuration digest;
- environment, target and selected workloads;
- redacted target-state digest;
- ordered, typed actions.

Plan files are created exclusively, so an existing plan is not overwritten by accident. Apply re-resolves the
project and selected workload set and rejects stale source, target state, adapter identity or content.
Receipts bind the completed operation to the plan digest, redact credential-like fields and are persisted
under ignored `.monox/receipts/` state. State-changing operations take a per-environment, per-target lock.
Deploy refuses a multi-target mutation so one failed target cannot leave a second target half-applied. Render
validates every artifact before writing to a sibling staging directory and promotes the complete directory
atomically.

## Adapter status in `0.2.0-alpha.1`

| Path                 | What the source currently does                                                                                 | What is not yet proven                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Local Docker Compose | Built-in allowlisted executor; bounded probes; owned-only rollback and destroy                                 | Full catalog runtime matrix                           |
| PM2                  | Renders an ecosystem file and staged promotion sequence; injected transport; rollback hook on failed readiness | Disposable-host and long-running soak tests           |
| Generic SSH          | Requires server, identity and pinned-known-host references; injected argv transport                            | Live host promotion and rollback                      |
| Existing Coolify     | Renders a scoped service request for `POST /api/v1/services`; injected HTTP transport                          | Authenticated staging API create, deploy and rollback |
| Existing Kubernetes  | Renders deterministic YAML; injected cluster transport                                                         | Production cluster apply and rollback                 |
| AWS                  | Emits deterministic Pulumi intent for EC2, EKS, Coolify and static paths                                       | Pulumi Automation API execution and sandbox apply     |
| Google Cloud         | Emits deterministic Pulumi intent for Compute, GKE, Coolify and static paths                                   | Pulumi Automation API execution and sandbox apply     |

An unavailable executor fails closed. A no-op adapter is used only for tests and explicit inspection and
reports `changed: false`.

## Kubernetes rendering

The v2 renderer can generate Deployment, StatefulSet, Job or CronJob resources from the workload kind. Its
baseline policy includes:

- a dedicated ServiceAccount with token automount disabled;
- non-root execution, read-only root filesystem, runtime-default seccomp and all capabilities dropped;
- probes and bounded CPU, memory and ephemeral-storage requests and limits;
- PodDisruptionBudget and topology spread for eligible long-running workloads;
- NetworkPolicy and no Service or Ingress for non-networked workers;
- HPA for CPU or memory metrics;
- KEDA objects for route RPS, queues and supported external metrics;
- accelerator resources, scheduling intent and model-cache storage for GPU workloads;
- optional Prometheus Operator `ServiceMonitor` output.

HPA cannot scale to zero. KEDA may use `minReplicas: 0` only with an external event metric. RPS requires an
explicit metric source and query. Multiple KEDA triggers are alternative signals. A long-running worker must
declare drain behavior, a pre-stop command and a termination grace period that covers its drain timeout.

KEDA, Prometheus Operator, external secret controllers and GPU drivers are cluster prerequisites. The renderer
does not install or verify them.

## Add-ons

The generator can render loopback-bound Compose definitions for the maintained local catalog. Services that
support authentication require environment variables, and generated `.env.example` files contain blank
placeholders. `localstack` and `mailpit` are rejected for production selections.

Kubernetes add-on records are currently `unverified`. They intentionally omit executable chart coordinates
until an OCI chart version and digest have passed release verification. Any installer must fail closed while
that marker remains. Stateful production add-ons remain opt-in, with managed or external services preferred.

## Migration

Migration is report-first:

```sh
monox migrate deployment \
  --from legacy-production \
  --root /path/to/repository \
  --output .monox/migration-report.json
```

Root scans use tracked package manifests by default. `--include-untracked` is an explicit filesystem fallback.
The report maps side deployments to variants, legacy autoscaling to typed metrics, GPU fields to accelerators
and zero maximum replicas to `suspended: true`. It flags inline secrets, shell strings, arbitrary Kubernetes
patches, pod self-patching and hidden unpause behavior for manual review.

`--write` refuses the entire operation while any manual or security finding remains. It never changes a single
input file implicitly. Use `--redact-identifiers` for a synthetic public aggregate report, and do not combine
redaction with write mode.

See [migration.md](migration.md) for the adoption sequence and
[ADR 0002](adr/0002-render-is-separate-from-apply.md) for the state-change boundary.
