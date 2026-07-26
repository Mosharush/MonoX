# MonoX 0.2 delivery roadmap

This roadmap distinguishes source implementation from release evidence. A feature is public only after its
release slice passes the named acceptance checks. Code present on a development branch is not a production
support claim.

## Current state

`0.2.0-alpha.1` is implemented as a source prerelease and is still behind the release gate. The repository
must pass the complete check suite, synthetic migration goldens, representative polyglot acceptance, the
built-in local Cloudapter lifecycle smoke and the first hosted 24-recipe matrix before a prerelease tag or npm
publish.

Current source includes:

- package-owned deployment schema v2 and generated TypeScript declarations;
- RFC 7396 environment and variant resolution with unique target binding;
- deterministic bundled recipes and `monox.lock` integrity;
- the complete built-in recipe and add-on catalog definitions;
- platform runtime packages and the versioned Cloudapter interface;
- a built-in local Docker Compose executor plus PM2, SSH, Coolify and Kubernetes adapters behind injected
  remote transports;
- AWS and Google Cloud plan-only provider intent;
- Kubernetes workload rendering for typed scaling and GPU intent;
- a read-only legacy migration inventory with synthetic redaction.

The source now includes a scheduled 24-recipe install, test, build and runtime acceptance workflow. A local
acceptance run covers every recipe, but its first hosted run and cross-platform evidence remain release gates.

The following are not complete release evidence:

- private-reference credential rotation and any approved history cleanup;
- hosted full-template matrix evidence across the maintained toolchain versions;
- disposable PM2 and SSH host tests;
- authenticated Coolify staging tests;
- Pulumi sandbox apply and destroy on AWS and Google Cloud;
- real GKE or EKS identity, queue, RPS and GPU acceptance;
- a production canary and exercised rollback;
- a reviewed public production case study.

## Release slices

### Security gate

- Rotate any tracked provider credentials in reference repositories before extraction or case-study work.
- Replace long-lived credentials with OIDC, workload identity or external secret references.
- Complete consumer inventory, encrypted mirror verification and contributor coordination before any history
  rewrite.
- Run full-history scans after approved rewrites and purge cached artifacts where the host allows it.
- Keep product code, private identifiers and live manifests out of public fixtures.

The public MonoX repository already has read-only CI, full-history secret scanning, dependency audit, source
SBOM generation and pinned release actions. These controls do not replace the private-reference rotation gate.

### `0.2.0-alpha.1`

Target deliverables:

- schema v2, config resolver and migration report;
- deterministic generator and agent kit;
- JavaScript, TypeScript and Python recipe acceptance;
- local Compose validation and health checks;
- core runtime packages and Cloudapter plan protocol.

Exit criteria:

- schema, generated types and runtime validator remain in parity;
- unknown fields, unsafe overlays and ambiguous target bindings fail;
- synthetic service, queue, long worker, GPU, static, suspended and variant migrations match goldens;
- representative Node and Python projects install, build, test, start and pass health checks;
- Yarn, npm and pnpm consumer smoke tests remain green;
- plans and receipts are redacted, immutable and stale-plan aware;
- generated local Docker delivery passes doctor, deploy, readiness, status and owned-only destroy on an
  isolated runner;
- all repository checks pass on supported Node majors.

### `0.2.0-alpha.2`

Target deliverables:

- maintained PHP and Go recipe acceptance;
- complete local add-on health matrix;
- PM2, generic SSH, AWS SSM and Google Cloud IAP execution transports;
- existing Coolify staging support;
- Pulumi-managed VM and provisioned Coolify modules.

Exit criteria:

- PHP and Go representative projects install, build, test and start where applicable;
- disposable-host promotion includes a readiness gate and verified rollback;
- SSH rejects unknown hosts and private-key material in configuration;
- Coolify tests prove scoped `read`, `write` and `deploy` authorization without `root`;
- Pulumi mocks and sandbox VM create, status and destroy pass with TTL and budget guards.

The current alpha.1 adapter packages provide implementation groundwork. They do not satisfy these live exit
criteria by themselves.

### `0.2.0-alpha.3`

Target deliverables:

- existing Kubernetes plus Pulumi-managed EKS and GKE Standard;
- verified Helm OCI add-on catalog with digest pins;
- static delivery for AWS and Google Cloud;
- CPU, memory, RPS, queue and external event scaling;
- GPU scheduling and model-cache support;
- vendor-neutral telemetry through OpenTelemetry.

Exit criteria:

- kind or K3d policy and runtime tests pass with Helm, KEDA, Prometheus and RabbitMQ;
- scheduled AWS and Google Cloud sandboxes prove apply, status, rollback and destroy;
- workload identity, scale-to-zero and RPS or queue scaling pass on a real managed cluster;
- a supported GPU workload schedules with the expected taints, tolerations, storage and metrics;
- chart and image references are versioned and digest-pinned;
- production add-ons default to managed or external stateful services.

### `0.2.0-rc.1`

Target deliverables:

- read-only migration report for the private production reference;
- sanitized dual-render diffs;
- dev and staging adoption;
- one low-risk production canary;
- independent new-project pilot and documentation freeze.

Exit criteria:

- every migrated workload has a reviewed target and no inline secret;
- current and MonoX-rendered outputs have reviewed, explained differences;
- one canary runs through MonoX and rolls back to the previous revision successfully;
- the pilot records first run, CI, first feature and first deploy without coaching during its initial period;
- only consented, measured outcomes appear in public material.

### `0.2.0`

Stable release requires:

- all security-gate records complete;
- production canary and rollback evidence retained;
- package provenance and public registry consumer smoke verified;
- `Mosharush/MonoX`, `create-monox`, `monox.dev`, GitHub profile, portfolio and LinkedIn use the same verified
  wording;
- no duplicate active public MonoX repository;
- unsupported capabilities fail before file writes or external changes;
- generated projects, plans, logs, fixtures and public history contain no credentials or private identifiers.

## Non-goals during 0.2

- copying source or Git history from a private product;
- promising unlimited scale or unmeasured time savings;
- adding arbitrary Kubernetes object merges to the workload contract;
- defaulting production stateful systems into clusters;
- using static provider credentials in CI;
- changing commit dates for profile cosmetics;
- treating model output as executable shell.

See [capability-status.md](capability-status.md) for evidence at the package level and
[security-gate.md](security-gate.md) for the history-cleanup prerequisites.
