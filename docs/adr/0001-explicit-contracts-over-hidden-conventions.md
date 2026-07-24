# ADR 0001: Prefer explicit contracts over hidden conventions

- Status: Accepted
- Date: 2026-07-24

## Context

MonoX is used by developers, CI, and coding agents. A convention that exists only in a maintainer's memory is
easy to violate and difficult to validate. Inferring repository boundaries from incidental folder names also
makes migrations unsafe.

## Decision

Repository zones, dependency direction, workspace metadata, deployment schemas, and agent rules are explicit,
versioned where they cross a public boundary, and validated in CI. New implicit behavior must be replaced by a
documented contract or remain outside the core.

## Consequences

- Contributors and agents can discover the same boundaries without private context.
- CI can reject invalid dependency direction and deployment configuration deterministically.
- Contract changes require documentation, compatibility tests, and migration notes.
- The repository carries more visible configuration, but that cost is preferred to hidden coupling.
