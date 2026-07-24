# Changelog

All notable changes will be documented here.

## Unreleased

## 0.1.1 (public preview)

### Added

- Full quality and compatibility CI on Node.js 22.22.2+, 24.15.0+, and 26.x.
- Explicit Corepack installation in repository and generated CI, including Node.js distributions that do not
  bundle it.
- A kind-based Kubernetes runtime smoke that builds, applies, rolls out, checks workload policy, and probes
  the synthetic API Service.
- Initial architecture decision records for explicit contracts, render and apply separation, model-output
  safety, and package-manager adapters.

### Fixed

- Narrowed Node.js engine metadata to the supported even-numbered majors instead of also accepting unsupported
  Node.js 23 and 25 releases.
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
