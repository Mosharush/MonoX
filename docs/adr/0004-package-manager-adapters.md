# ADR 0004: Keep package managers behind small generator adapters

- Status: Accepted
- Date: 2026-07-24

## Context

Teams use Yarn, npm, and pnpm, but their lockfiles, workspace dependency ranges, immutable install commands,
and workspace metadata differ. Pretending they are identical produces generated projects that fail later in CI
or container builds.

## Decision

The MonoX reference repository uses Yarn 4. `create-monox` generates exactly one selected package-manager
contract per project through small adapter tables for versions, lockfiles, install commands, and workspace
ranges. Generated CI verifies the selected lockfile and uses that manager's immutable install mode.

Adding another package manager requires generator tests, a pinned manager version, lockfile behavior, an
immutable CI install command, Docker behavior, and documentation. MonoX does not run multiple package managers
inside one generated workspace.

## Consequences

- Generated projects can choose Yarn, npm, or pnpm without weakening reproducibility.
- The reference repository remains simple and does not imply simultaneous package-manager use.
- Adapter behavior is intentionally small but must be tested for every supported manager.
- Package-manager-specific features stay outside shared workspace discovery and architecture rules.
