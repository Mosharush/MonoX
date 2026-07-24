# MonoX agent contract

This file is the canonical operating contract for coding agents and human contributors.

## Objective

Keep MonoX small, reusable and safe to generate from. Favor explicit contracts over hidden conventions. Every
change should improve delivery speed without weakening boundaries, security or reproducibility.

## Repository zones

- `apps/`: runnable examples. Apps may depend on packages.
- `packages/`: reusable libraries, CLIs and schemas. Packages must never depend on apps.
- `infra/`: deployment adapters and local infrastructure. Infra may use schemas and renderer packages but must
  not import application source.
- `schemas/`: public, versioned configuration contracts.
- `scripts/`: repository-level validation and orchestration only.
- `docs/`: architecture, operations and decisions.

Keep product-specific code, production domains, account identifiers, credentials, customer data and private
repository paths out of every zone.

## Required workflow

1. Read the closest package README and tests before editing.
2. State the contract being changed.
3. Add or update tests with the implementation.
4. Run the narrowest relevant checks during development.
5. Run `yarn check` before handing off.
6. Report skipped checks and the exact reason.

Do not deploy, publish, rotate credentials, change repository visibility or destroy infrastructure without
explicit human approval.

## Commands

```bash
yarn install --immutable
yarn workspaces:list
yarn dev --select api,web
yarn test
yarn build
yarn infra:check
yarn check
```

Non-interactive agents must use `--all` or `--select` with the development runner.

## Engineering boundaries

- Prefer Node built-ins and small modules before adding dependencies.
- Pass subprocess arguments as arrays. Never construct shell commands from user, branch, model or network
  input.
- Validate configuration at boundaries and fail closed for deployment operations.
- Keep secrets in external secret stores. Commit only names and example placeholders.
- Use typed allowlisted tools for AI features. Model output is data, never executable shell.
- Keep public APIs stable and version schemas before breaking them.
- Keep adapters replaceable. Cloud-specific behavior belongs behind a package or infra adapter.
- Reuse shared behavior through packages. Avoid cross-zone copy and paste.

## Deployment rules

- Rendering and validation are safe default operations.
- `deploy` and `destroy` require explicit environment selection and human approval.
- Preview environments must have ownership labels, a TTL and an automated cleanup path.
- Autoscaling needs requests, limits, probes and a bounded maximum.
- Scale-to-zero requires KEDA and an event source. HPA alone starts at one replica.

## Done means

- Tests cover the changed behavior.
- `yarn check` passes.
- Generated output contains no private markers or credentials.
- Docs and schemas agree with the implementation.
- The change can be explained without relying on private product context.
