# Architecture

MonoX separates policy, reusable behavior, runnable applications and deployment adapters.

## Dependency flow

Applications depend on reusable packages. Deployment adapters depend on schemas and renderers. Reusable
packages do not import applications, and infrastructure does not import application source.

This keeps three workflows independent:

1. Product teams can replace an app without changing platform internals.
2. Platform teams can evolve renderers and CI without importing business code.
3. Coding agents can explore one zone with a small, explicit context window.

## Contracts

`monox.config.json` is the project-level map. Package manifests describe workspace behavior. Deployment
schemas define what infrastructure accepts. Generated Kubernetes output is a build artifact, not a second
source of truth.

## Change strategy

Configuration schemas use semantic versions. Breaking changes require a migration note and a compatibility
test. Adapters stay optional, and cloud-specific behavior must not leak into core workspace packages.

The reasons behind these boundaries are recorded in the [architecture decision log](adr/README.md).
