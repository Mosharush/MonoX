# Changelog

All notable changes will be documented here.

## Unreleased

- Complete the public repository and trusted publishing gates.
- Publish `create-monox` 0.1.0 as an upgrade to the existing npm package.

## 0.1.0 (release candidate)

### Added

- Clean-room MonoX platform with workspace discovery, affected-project calculation, and a development runner.
- Dependency-free `create-monox` CLI for Yarn, npm, and pnpm projects.
- Synthetic API and web examples with health endpoints and tests.
- Versioned deployment contracts and hardened Kubernetes rendering.
- Local Compose, non-root container templates, CI, dependency review, and secret scanning workflows.

### Changed

- Replaced the historical `create-monox` 0.0.x implementation with a dependency-free generator and explicit
  human and coding-agent boundaries.
- Made dependency installation the CLI default so generated projects begin with the lockfile required by CI
  and Docker builds.

### Security

- Pinned external GitHub Actions to full commit SHAs.
- Kept deployment rendering separate from apply operations and rejected inline secret-like values.
