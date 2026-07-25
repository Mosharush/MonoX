# Public capability status

This file is the wording boundary for MonoX 0.2. Website, README, npm, GitHub and social profiles should claim
only what appears here with passing release evidence.

## Status vocabulary

- **Verified in source**: implemented and covered by repository tests or deterministic validation.
- **Implemented, acceptance pending**: code exists, but the live or cross-platform acceptance named here has
  not passed.
- **Plan-only**: produces validated intent and cannot change external state.
- **Planned**: part of the 0.2 roadmap, not a current capability.

## Contract and CLI

| Capability                                                       | Status                          | Current evidence                                                | Remaining evidence                                               |
| ---------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `package.json.deployment` v2                                     | Verified in source              | JSON Schema, generated declarations and runtime validator tests | Prerelease CI on the tagged source                               |
| Root config v2 without `applications[]`                          | Verified in source              | Strict validator and repository validation                      | Prerelease CI on the tagged source                               |
| RFC 7396 overlays                                                | Verified in source              | Merge, deletion and immutable-field tests                       | More complex production migration cases                          |
| Automatic deployment discovery                                   | Verified in source              | Workspace fixture tests                                         | Large-repository performance measurement                         |
| Exactly one target per resolved workload                         | Verified in source              | Zero-match and multi-match rejection tests                      | Production inventory review                                      |
| `validate`, `config explain`, `doctor`, `plan`, `render`         | Verified in source              | CLI unit and fixture tests                                      | Published package consumer test when CLI publication is approved |
| `deploy`, `apply`, `status`, `rollback`, `destroy` orchestration | Implemented, acceptance pending | Built-in local executor plus injected-adapter tests             | Live remote adapter-specific acceptance                          |
| Stale-plan rejection                                             | Verified in source              | Source, target-state, adapter and plan-content tests            | Concurrent external-state test                                   |
| Production identity gate                                         | Verified in source              | Protected environment, `CI=true` and identity-reference tests   | Hosted protected-environment run                                 |

## Generator and catalog

| Capability                        | Status                                            | Current evidence                                                     | Remaining evidence                                                  |
| --------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Bundled deterministic recipes     | Verified in source                                | Byte-identical generation and selection-integrity tests              | Published `create-monox@next` consumer test                         |
| Yarn, npm and pnpm                | Verified for representative JavaScript generation | Existing consumer smoke workflows                                    | Representative polyglot run on each package manager                 |
| JavaScript and TypeScript catalog | Implemented, acceptance pending                   | All 14 recipes pass local install, test and build acceptance         | First hosted 24-recipe matrix and complete runtime probe run        |
| Python catalog with `uv`          | Implemented, acceptance pending                   | All 5 recipes pass local install, test, build and runtime acceptance | First hosted 24-recipe matrix run                                   |
| PHP catalog with Composer         | Implemented, acceptance pending                   | Both recipes pass containerized install, strict validation and test  | First hosted 24-recipe matrix run across supported PHP releases     |
| Go catalog                        | Implemented, acceptance pending                   | All 3 recipes pass digest-pinned container build and runtime checks  | First hosted 24-recipe matrix run across supported Go releases      |
| Java, .NET and Rust               | Planned extension recipes                         | Extension direction only                                             | Versioned external recipe loader and maintained CI                  |
| Local Compose add-ons             | Implemented, acceptance pending                   | 21 digest-pinned services, dependency closure and config validation  | `docker compose up` health matrix for every add-on                  |
| Kubernetes add-ons                | Plan-only metadata                                | Generated records are marked `unverified`                            | Verified OCI chart coordinates, versions, digests and runtime tests |

## Delivery paths

| Delivery path                           | Status                          | Current evidence                                                    | Remaining evidence                                        |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| Local Docker Compose                    | Implemented, acceptance pending | Built-in allowlisted executor, owned rollback and config tests      | Complete generated add-on runtime matrix                  |
| PM2 on an existing host                 | Implemented, acceptance pending | Ecosystem rendering, health gate and rollback-hook tests            | Disposable-host promotion and rollback                    |
| Generic SSH transport                   | Implemented, acceptance pending | Reference validation, argv-only actions and host-verification tests | Disposable-host connection test                           |
| Docker on SSH, EC2 or Compute           | Planned for `0.2.0-alpha.2`     | Catalog entries fail before generator writes                        | Composite build, transport, health and rollback adapter   |
| Existing Coolify                        | Implemented, acceptance pending | Request rendering, redaction and scope validation tests             | Authenticated staging create, deploy, status and rollback |
| Existing Kubernetes                     | Implemented, acceptance pending | Offline v2 rendering, policy goldens and injected transport tests   | Cluster apply and rollback using the v2 adapter           |
| AWS EC2, EKS, Coolify and static        | Plan-only                       | Deterministic Pulumi intent and static-key rejection                | Automation API executor plus sandbox lifecycle            |
| Google Compute, GKE, Coolify and static | Plan-only                       | Deterministic Pulumi intent and key-JSON rejection                  | Automation API executor plus sandbox lifecycle            |
| Azure, DigitalOcean, Hetzner and k3s    | Planned extensions              | Cloudapter contract only                                            | Maintained adapter implementation and CI                  |

## Kubernetes, scaling and GPU

| Capability                                                      | Status                          | Current evidence                                  | Remaining evidence                                           |
| --------------------------------------------------------------- | ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| Restricted pod security baseline                                | Verified in source              | Golden resource assertions                        | Admission test on supported managed clusters                 |
| Worker without Service or Ingress                               | Verified in source              | Worker golden fixture                             | Real queue worker rollout                                    |
| CPU and memory HPA                                              | Verified in source              | Typed validation and renderer tests               | Managed-cluster scaling test                                 |
| RabbitMQ, SQS, Pub/Sub, Redis, Kafka, NATS and external metrics | Implemented, acceptance pending | Typed KEDA rendering tests                        | Supported-scaler catalog pin and event-driven runtime matrix |
| Route-based RPS                                                 | Implemented, acceptance pending | Explicit source and query validation              | Real metric adapter and scale test                           |
| Scale to zero                                                   | Implemented, acceptance pending | HPA rejection and KEDA render tests               | Real event source from zero replicas                         |
| Long-worker drain                                               | Implemented, acceptance pending | Contract and renderer policy tests                | In-flight job drain test during scale-down                   |
| GPU workload intent                                             | Implemented, acceptance pending | Accelerator, scheduling and cache rendering tests | Supported GPU operator and real-node placement               |
| Vendor-neutral telemetry primitives                             | Verified in source              | Runtime package tests and Prometheus exposition   | Collector integration and managed alert acceptance           |

## Migration and production reference

The migration tool reads tracked package manifests by default, emits a report, redacts public aggregate
identifiers and refuses write mode while findings remain. Synthetic fixtures cover service, queue worker, long
worker, GPU model, static, suspended and variant mappings.

The private production reference currently has 42 tracked deployment blocks. No product code or manifest is
part of this repository. Production implementation, canary and rollback are still pending, so public material
must not describe the reference as a completed MonoX 0.2 case study.

## Approved alpha wording

Use concrete statements such as:

> MonoX generates a monorepo with selected apps and libraries, package-owned deployment contracts, local
> services, CI, container definitions and a validated delivery target.

> MonoX gives developers, CI and coding agents the same workspace and deployment map. The 0.2 alpha can
> validate, explain, plan and render that map before a guarded adapter is allowed to change external state.

Do not claim:

- infinite scale;
- a fixed amount of time saved without a published benchmark;
- production-ready AWS, Google Cloud, Coolify or Kubernetes apply before their live acceptance passes;
- a public production case study before security cleanup, canary and rollback evidence;
- complete framework support based only on file generation.

Every public claim should link to a command, fixture, test, release artifact or consented benchmark.
