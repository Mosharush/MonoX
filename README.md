# MonoX

[![create-monox on npm](https://img.shields.io/npm/v/create-monox?label=create-monox)](https://www.npmjs.com/package/create-monox)
[![License: MIT](https://img.shields.io/badge/license-MIT-6f8cff)](LICENSE)
[![Node.js: 22, 24, 26](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-5fa04e)](package.json)

MonoX is an agent-ready JavaScript monorepo starter and deployment toolkit for teams that want fast delivery
without losing architectural control.

It gives people and coding agents the same explicit map: where code belongs, which dependencies are allowed,
how services run locally, and how workloads are packaged for container platforms.

MonoX composes existing workspace, container, and Kubernetes tools instead of replacing them.

> Status: Public preview. `create-monox` is available on npm through trusted publishing with provenance.

[Project site](https://monox.dev) | [Source](https://github.com/Mosharush/MonoX) |
[Architecture](docs/architecture.md) | [create-monox](packages/create-monox/README.md) |
[Roadmap](docs/roadmap.md)

## What works today

- Yarn workspaces with package-manager-independent discovery
- Interactive or non-interactive multi-workspace development runner
- Changed-workspace detection with propagation to internal dependents
- Synthetic Node API and web examples with health endpoints and tests
- A deterministic `create-monox` generator that never clones a private repository
- Versioned deployment configuration and Kubernetes rendering
- Docker Compose for local infrastructure
- Kubernetes probes, resources, PDB, NetworkPolicy, HPA and optional KEDA scale-to-zero
- Least-privilege CI, container and package-release workflows
- Repository rules that keep apps, libraries and infrastructure in clear zones
- One canonical `AGENTS.md` contract for human and AI contributors

MonoX does not claim infinite capacity. Kubernetes and KEDA can scale workloads from zero to a configured
ceiling when the cluster and upstream services have enough capacity. The ceiling, budgets and failure modes
stay visible in configuration.

## Quick start

Requirements: Node.js 22, 24, or 26 and Corepack. These are the supported majors; odd-numbered releases are
not part of the compatibility contract. Node.js distributions that do not bundle Corepack can install the
version used in CI with `npm install --global corepack@0.35.0`.

```bash
corepack enable
yarn install --immutable
yarn doctor
yarn check
yarn dev
```

For an agent or CI session, avoid interactive prompts:

```bash
yarn dev --all
yarn dev --select api,web --dry-run
```

The starter runs:

- API: `http://localhost:3000/api/hello`
- API health: `http://localhost:3000/healthz`
- Web: `http://localhost:3001`
- Web health: `http://localhost:3001/healthz`

## Generate a project

```bash
npm create monox@latest -- my-product --yes
```

The generator installs dependencies by default, creates the selected package manager's lockfile, and can
include Docker, Kubernetes, both, or neither.

```bash
npm create monox@latest -- my-product --package-manager yarn --infra all --yes
```

Use `yarn run create my-product --yes` when developing the generator from a checked-out repository.

It refuses nonempty and symlink destinations. Pass `--no-install` only when another process will create and
commit the lockfile before CI or Docker runs. Generated projects contain synthetic code, CI, architecture
rules and deployment templates without customer data, production domains or credentials.

## Architecture

```text
apps/                    Runnable API and web examples
packages/                Reusable platform code and CLIs
infra/                   Local and Kubernetes deployment adapters
schemas/                 Versioned public configuration contracts
scripts/                 Repository validation and orchestration
docs/                    Architecture, operations and contributor guidance
```

Dependency direction is deliberate:

```text
apps -> packages
infra -> packages
packages -> packages
packages -X-> apps
infra -X-> apps
```

See [Architecture](docs/architecture.md), [Deployment model](docs/deployment.md),
[Architecture decisions](docs/adr/README.md) and [Agent contract](docs/agent-contract.md).

## Verification

The local release gate is one command:

```bash
yarn check
```

It covers formatting, repository boundaries, tests, builds, Kubernetes rendering and Compose validation. The
public CI repeats the full gate on Node.js 22, 24, and 26, then adds secret scanning and dependency review.
`@monox/affected` can identify changed workspaces for targeted local validation, but it does not skip jobs in
the public CI gate. A separate kind workflow builds the API image, applies a synthetic manifest to an
ephemeral cluster, waits for rollout, checks workload policy, and probes the running Service.

## Public-source boundary

MonoX began as a reusable monorepo and delivery foundation created and led by Moshe Harush. This public 0.1.0
implementation was rebuilt in a new repository from an explicit platform specification. It does not contain
private product history, business services, customer fixtures, production identifiers or copied deployment
configuration. See [Provenance](PROVENANCE.md).

## Contributing and security

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Governance](GOVERNANCE.md)
- [Support](SUPPORT.md)
- [Code of conduct](CODE_OF_CONDUCT.md)

MonoX is available under the [MIT License](LICENSE).
