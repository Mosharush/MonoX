# Provenance

MonoX began as a reusable monorepo and delivery foundation created and led by Moshe Harush. The public 0.1.0
implementation was rebuilt in a new repository in 2026 from an explicit platform specification. No private
product Git history was imported.

The implementation does not copy private product source or Git history. It does not include customer data,
production domains, cloud account identifiers, private stack configuration, credentials, operational backups
or business-specific services.

The public concepts implemented here are common platform patterns:

- monorepo workspace discovery and task orchestration;
- configuration schemas and dependency boundaries;
- container builds and health checks;
- Kubernetes workload rendering and autoscaling;
- least-privilege CI and release automation;
- repository guidance for coding agents.

Every imported third-party dependency remains governed by its own license. New dependencies require license
and supply-chain review.
