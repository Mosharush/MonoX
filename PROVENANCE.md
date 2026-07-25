# Provenance

MonoX began as a reusable monorepo and delivery foundation created and led by Moshe Harush. The public 0.1
implementation was rebuilt in a new repository in 2026 from an explicit platform specification. No private
product Git history was imported.

MonoX 0.2 continues as a clean-room public implementation. Private and historical systems are behavioural
references only. Contributors may study which setup steps, workload classes and operational failure modes a
general platform must handle, but they must not copy implementation source, manifests or history from those
systems.

The public repository and generated projects must not include:

- customer or business data;
- private product source or commit history;
- production domains, registry coordinates, account or project identifiers;
- cloud credentials, service-account keys, private keys or long-lived tokens;
- private stack configuration, backups, logs or deployment receipts;
- product-specific services disguised as generic fixtures.

Public migration examples are synthetic. They use reserved example domains, generic workload names and no
routable account identifiers. A redacted private inventory is not automatically publishable and requires a
separate secret scan and marker review.

The generic concepts implemented here are common platform patterns:

- monorepo workspace discovery, dependency boundaries and affected calculation;
- deterministic scaffolding from bundled, versioned recipes;
- package-owned workload contracts and environment resolution;
- container builds, health checks and graceful shutdown;
- provider-neutral plans, receipts and deployment adapter interfaces;
- Kubernetes workload rendering, autoscaling and accelerator intent;
- least-privilege CI, OIDC release automation, SBOM and provenance;
- concise repository guidance for coding agents.

Third-party packages, container images, actions and charts remain governed by their own licenses and terms.
New dependencies and release references require license and supply-chain review. Public MonoX source is MIT
licensed under `Copyright 2026 Moshe Harush and MonoX contributors`.
