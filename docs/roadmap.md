# MonoX 0.2 delivery roadmap

This roadmap separates the stable generator and contract surface from remote infrastructure acceptance. Code
in the repository is not a production support claim until the capability status names its evidence.

## Current state

`create-monox@0.2.0` is the stable release for deterministic project generation and generated offline
contracts. The supported package boundary includes:

- package-owned deployment v2 contracts and root target configuration;
- 24 bundled JavaScript, TypeScript, Python, PHP and Go workspace recipes;
- deterministic selection and `monox.lock` integrity;
- Yarn, npm and pnpm project generation;
- local service, CI, container and Kubernetes artifact generation.

Release evidence includes the complete repository gate, representative polyglot acceptance, a hosted 24-recipe
matrix and a clean-cache generated-project consumer with signed npm provenance.

The public source tree also contains schema and TypeScript declaration parity, RFC 7396 resolution, migration
and production identity gates, the `@monox/cli`, Cloudapter implementations, a built-in local Docker Compose
executor and synthetic migration goldens. Those packages remain npm-private in 0.2.0. Generated projects do
not receive a public `monox` binary, so source-tool evidence is not described as package-consumer evidence.

Stable does not promote every source package to live infrastructure support. PM2, SSH, Coolify and Kubernetes
state changes remain guarded behind injected transports and their live acceptance is pending. AWS and Google
Cloud providers emit plan-only intent. Kubernetes add-on records marked `unverified` remain non-executable.

## Security boundary

- Rotate any tracked provider credentials in reference repositories before extraction or case-study work.
- Replace long-lived credentials with OIDC, workload identity or external secret references.
- Complete consumer inventory, encrypted mirror verification and contributor coordination before any history
  rewrite.
- Run full-history scans after approved rewrites and purge cached artifacts where the host allows it.
- Keep product code, private identifiers and live manifests out of public fixtures.

The public MonoX repository has read-only CI, full-history secret scanning, dependency audit, source SBOM
generation and pinned release actions. These controls do not replace the private-reference credential gate.

## 0.2.x follow-up tracks

### Local catalog acceptance

Target evidence:

- run every selected Compose add-on to health in isolated environments;
- verify dependency closure, persistent-data ownership and owned-only destroy;
- keep LocalStack and Mailpit rejected in production;
- keep stateful Kubernetes add-ons opt-in and external by default in production.

### Remote delivery acceptance

Target evidence:

- disposable-host PM2 promotion, readiness and rollback;
- generic SSH host verification and connection tests;
- authenticated Coolify create, deploy, status and rollback with scoped tokens;
- existing Kubernetes apply, health, status and rollback through the v2 adapter;
- composite Docker delivery over SSH, AWS SSM and Google Cloud IAP.

Until those checks pass, these adapters require an explicitly injected transport and remain
acceptance-pending.

### Cloud and managed Kubernetes

Target evidence:

- Pulumi Automation API preview, apply, status and destroy in budget-guarded AWS and Google Cloud sandboxes;
- OIDC and Workload Identity Federation without static provider credentials;
- managed EKS and GKE identity, queue, RPS and scale-to-zero acceptance;
- GPU placement, model-cache storage and operator compatibility on supported nodes;
- verified Helm OCI chart coordinates, versions and digests;
- OpenTelemetry Collector integration and managed alert acceptance.

AWS and Google Cloud remain plan-only until this track passes. Generated plans must never imply that external
state changed.

### Production adoption and public case study

Target evidence:

- a read-only migration report from the private production reference;
- sanitized and reviewed dual-render differences;
- dev and staging adoption;
- one low-risk production canary;
- an exercised rollback to the previous revision;
- an independent new-project pilot with consented measurements.

The private reference, its implementation details and its name remain outside public case-study claims until
credential cleanup, canary and rollback evidence are complete.

## Release requirements

Every `0.2.x` package release requires:

- immutable installation, formatting, lint, tests, builds and infrastructure validation;
- schema, generated declarations and runtime validator parity;
- synthetic migration goldens and representative generated-project acceptance;
- full public-history secret scanning, high-severity dependency audit and source SBOM generation;
- reviewed package contents, an exact protected-main tag and OIDC trusted publishing with provenance;
- clean-cache registry consumption and the expected npm dist-tag;
- unsupported selections to fail before destination writes or external changes.

A production capability or case-study claim additionally requires its live evidence above. Package stability
does not waive that rule.

## Non-goals during 0.2

- copying source or Git history from a private product;
- promising unlimited scale or unmeasured time savings;
- adding arbitrary Kubernetes object merges to the workload contract;
- defaulting production stateful systems into clusters;
- using static provider credentials in CI;
- changing commit dates for profile cosmetics;
- treating model output as executable shell.

See [capability-status.md](capability-status.md) for evidence at the package level and
[security-gate.md](security-gate.md) for history-cleanup prerequisites.
