# Changelog

All notable changes will be documented here.

## Unreleased

### Added

- Package-owned deployment contract v2 with strict JSON Schema, generated TypeScript declarations and a
  dependency-free runtime validator.
- Root configuration v2 with workspace discovery, RFC 7396 environment and variant resolution, and exactly one
  target binding per resolved workload.
- `@monox/cli` commands for validation, configuration explanation, doctor checks, planning, rendering, guarded
  apply, status, rollback, destruction and report-first migration.
- A versioned Cloudapter API with canonical redacted plans and receipts, stale-plan rejection, and injected
  execution transports.
- Local Docker Compose, PM2, generic SSH, existing Coolify and existing Kubernetes adapter implementations.
  Local Docker uses a built-in allowlisted executor; remote execution remains acceptance-gated and requires an
  explicitly injected transport.
- Plan-only AWS and Google Cloud provider packages that reject static credentials and emit deterministic
  Pulumi intent without contacting a provider.
- Kubernetes v2 rendering for restricted workload security, typed HPA and KEDA metrics, worker drain,
  accelerator intent, model-cache storage and optional ServiceMonitor output.
- Deterministic `create-monox` recipe selection for JavaScript, TypeScript, Python, PHP and Go, with a
  versioned catalog and `monox.lock` integrity.
- A maintained add-on catalog with 21 digest-pinned local Compose services, recursive dependency closure,
  loopback-bound ports, required secret placeholders, production rejection for development-only add-ons, and
  fail-closed unverified Kubernetes chart records.
- Shared runtime packages for lifecycle, logging, telemetry, service discovery, application health, Fastify
  integration, tests and compiled agent guidance.
- Synthetic migration goldens for services, queue workers, long workers, GPU models, static output, suspended
  workloads and variants.
- Proof-first English and Hebrew project pages with RTL and LTR support, logical CSS properties, reduced
  motion and responsive layouts.
- A scheduled 24-recipe acceptance matrix that installs, tests, builds and starts or probes each generated
  JavaScript, Python, PHP and Go workspace in isolation.

### Changed

- Made `package.json.deployment` the only application deployment source of truth and removed the root
  `applications[]` list.
- Replaced legacy zero-maximum-replica parking with explicit `suspended: true`.
- Replaced side deployments with deterministic variants and provider fields with target bindings.
- Bumped source and `create-monox` metadata to `0.2.0-alpha.1`. A prerelease tag and npm publish remain gated
  by the complete acceptance suite and security prerequisites.
- Aligned Nuxt 4 with its project-reference TypeScript layout and Angular 22 with the current `@angular/build`
  builder.
- Namespaced generated Python distributions and modules so workspace names such as `fastapi` cannot shadow a
  dependency or resolve as a self-dependency.
- Made generated PHP and Go container builds consume committed lock state instead of resolving dependencies
  during image builds.

### Security

- Added production gates that require a protected environment, CI execution and an external identity reference
  before state changes.
- Added exact destructive confirmation identities and read-only tracked-file migration inventory by default.
- Added full-history secret scanning, dependency audit and SPDX source SBOM generation to public CI.
- Required local add-on credentials at runtime and bound generated service ports to loopback.
- Documented credential rotation, encrypted backup, consumer coordination and truthful chronology as required
  prerequisites for any approved history rewrite.
- Verify every published `create-monox` version through the public registry by generating and testing a clean
  npm-based consumer after trusted publishing completes.

### Known limitations

- AWS and Google Cloud packages are plan-only in this alpha and do not invoke Pulumi Automation API.
- PM2, SSH, Coolify and Kubernetes adapters have not completed their live acceptance matrices.
- Kubernetes add-on chart coordinates and digests remain intentionally unverified and non-executable.
- The private production reference has not completed a MonoX 0.2 canary and proven rollback, so it is not yet
  a public case study.

## 0.1.2

The 0.1.1 source tag was not published to npm because its protected release job stopped during npm client
bootstrap. Version 0.1.2 contains the same product changes plus the release fix below.

### Fixed

- Run the pinned trusted-publishing npm client through `npx` so the release job never replaces the active npm
  installation while it is executing.

## 0.1.1

### Added

- Full quality and compatibility CI on Node.js 22.22.2+, 24.15.0+, and 26.x.
- Pinned Yarn, npm, and pnpm adapters across generation, documentation, CI, and Docker builds.
- Node.js 26 consumer tests that scaffold, install, and test every supported package-manager layout without a
  bundled Corepack binary.
- A kind-based Kubernetes runtime smoke for both the reference repository and a freshly generated project.
- Initial architecture decision records for explicit contracts, render and apply separation, model-output
  safety, and package-manager adapters.
- A public technical product page, complete MonoX brand kit, favicon set, README header, and social cards.

### Fixed

- Narrowed Node.js engine metadata to the supported even-numbered majors instead of also accepting unsupported
  Node.js 23 and 25 releases.
- Made the one-time Yarn scaffold install safe in public pull-request CI while preserving hardened immutable
  installs after the generated lockfile is committed.
- Aligned generated Docker and Kubernetes security contexts on numeric non-root UID and GID 10001.
- Rejected rolling updates when both surge and unavailable limits resolve to zero, including percentage
  values.
- Removed mobile overflow from Quick Start commands and the capability status layout.
- Replaced stale pre-release wording in the npm README with install and provenance information that remains
  accurate after publication.

### Documentation

- Clarified that affected-workspace detection propagates to internal dependents while public CI still runs the
  full repository gate.
- Distinguished renderer validation, the ephemeral kind runtime smoke, and protected production apply
  operations.

## 0.1.0 (public preview)

### Added

- Public MonoX implementation with workspace discovery, affected-project calculation, and a development
  runner.
- Dependency-free `create-monox` CLI for Yarn, npm, and pnpm projects.
- Synthetic API and web examples with health endpoints and tests.
- Versioned deployment contracts and hardened Kubernetes rendering.
- Local Compose, non-root container templates, CI, dependency review, and secret scanning workflows.

### Changed

- Replaced the historical `create-monox` 0.0.x implementation with a dependency-free generator and explicit
  human and coding-agent boundaries.
- Made dependency installation the CLI default so generated projects begin with the lockfile required by CI
  and Docker builds.
- Published `create-monox` from the
  [`create-monox-v0.1.0` release](https://github.com/Mosharush/MonoX/releases/tag/create-monox-v0.1.0) through
  the protected [trusted-publishing workflow](https://github.com/Mosharush/MonoX/actions/runs/30122766033)
  with [npm provenance](https://registry.npmjs.org/-/npm/v1/attestations/create-monox@0.1.0).

### Security

- Pinned external GitHub Actions to full commit SHAs.
- Kept deployment rendering separate from apply operations and rejected inline secret-like values.
