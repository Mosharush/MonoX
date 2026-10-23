# From generation to a reviewed project

This walkthrough uses `create-monox@0.2.0` to generate a JavaScript project, inspect its contracts and run the
same checks as its generated CI. It does not start containers or deploy infrastructure.

Use Node.js 22.22.2+, 24.15.0+ or 26.x. The generated npm project pins `npm@12.0.1`; use that version for the
dependency and script commands below. Run the first command from a directory where `cookbook-product` does not
exist. All subsequent commands run from the generated project root unless stated otherwise.

## 1. Generate without installing

```sh
npm create monox@0.2.0 -- cookbook-product \
  --package-manager npm \
  --workspace api=node-fastify-api \
  --workspace web=react-vite-web \
  --workspace jobs=node-worker \
  --delivery docker:local \
  --yes --no-git --no-install
cd cookbook-product
```

Adding `--dry-run` validates this selection and lists paths without creating the destination. `--no-git`
leaves repository initialization to you, and `--no-install` deliberately leaves out `package-lock.json`.

Inspect these files before changing product code:

| File                       | What to review                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                | Workspace map, dependency direction and required checks for people and agents. These are instructions, not a sandbox. |
| `apps/*/package.json`      | Each workspace's scripts, dependencies and `deployment` contract.                                                     |
| `monox.config.json`        | Root boundaries, environments and target bindings.                                                                    |
| `monox.lock`               | The resolved generator, recipe and delivery selection.                                                                |
| `.github/workflows/ci.yml` | The checks this generated project will actually run.                                                                  |

When changing how a workload starts, listens or reports health, update its `package.json.deployment` along
with its implementation. Keep reusable code in `packages/`; packages must not import from `apps/`.

## 2. Verify the recipe selection

This check works before dependency installation:

```sh
node scripts/verify-monox-lock.mjs
```

Expect `MonoX lock verified`. In 0.2.0 the verifier checks lock format version 1 and recomputes the SHA-256
hash of `lock.selection`, comparing it with `selectionIntegrity`. The selection records the workspace and
add-on recipes, their versions and integrity values, and the chosen delivery target. The lock also records
generator and catalog metadata outside that selection hash.

This is a selection consistency check. It does not hash your application source, compare source files with the
recipes, authenticate a lock author or replace a package-manager lockfile. Editing `apps/api/src/server.mjs`
can leave this check passing. Review the Git diff and test the changed behavior separately; a passing lock
check cannot establish that a product change is correct or that files are unmodified.

## 3. Prepare the dependency lock and run CI locally

Install the selected JavaScript dependencies once, then inspect and commit the resulting `package-lock.json`
with the generated files in your repository:

```sh
npx --yes npm@12.0.1 install
```

After the lockfile exists, run the sequence from the generated workflow:

```sh
test -f package-lock.json
npx --yes npm@12.0.1 ci
node scripts/verify-monox-lock.mjs
npx --yes npm@12.0.1 test
npx --yes npm@12.0.1 run test:workspaces
npx --yes npm@12.0.1 run build
```

`npm ci` consumes the dependency lock; it is not a substitute for the initial `npm install`. With
`--no-install`, pushing the generated files before committing `package-lock.json` fails the workflow's
explicit lockfile check.

The generated root test checks that workspace manifests are private and use deployment schema v2 where
present. The selected workspace test files start with placeholder assertions, so a green run is only a
starting point. Replace or extend them with product behavior tests before treating them as evidence for a
feature. For example, an API change needs assertions about its response and failure behavior, not just a
successful process start.

Generated CI runs immutable installation, selection verification, tests and builds on Node.js 22, 24 and 26.
It does not deploy the application or include every security and acceptance gate from the MonoX source
repository's own workflows.

## 4. Check the application's actual health contract

The generated Fastify recipe defines `/health` in `apps/api/src/server.mjs` and uses that same path for
startup, readiness and liveness in `apps/api/package.json`. Start it in one terminal:

```sh
npx --yes npm@12.0.1 run start:api
```

From another terminal, with the default `PORT` unchanged:

```sh
curl --fail http://127.0.0.1:3001/health
```

Expect `{"status":"ok"}`; stop the server with Ctrl-C when finished. This response does not test a database,
queue or other dependency. Add application-specific checks and matching probe paths when the product needs
them.

The source repository's `@monox/app-runtime` is a separate implementation: `/readyz` checks its readiness
flag, `/livez` checks its liveness flag and `/healthz` requires both. The generated Fastify recipe does not
import that package. See the [deployment health contract](deployment.md#package-owned-deployment-contract)
before copying probe paths between applications.

## 5. Keep delivery evidence separate

Selecting `docker:local` produces delivery configuration; generation and the checks above do not prove a
deployment happened. `create-monox@0.2.0` does not install a public `monox` delivery binary. Commands
beginning with `yarn monox` in the [deployment guide](deployment.md#source-tree-cli-flow) run from a MonoX
source checkout, not this npm consumer project.

The source CLI includes a built-in local Docker Compose executor. PM2, SSH, Coolify and Kubernetes paths
require explicitly injected transports and still have remote acceptance gaps; AWS and Google Cloud providers
are plan-only in 0.2.0. The generator rejects cataloged remote Docker selections such as `docker:generic-ssh`
before writing a destination. Consult [capability status](capability-status.md) for the supported boundary of
each path before planning a deployment.

For a review or handoff, identify the generated package version and selected recipes, include the relevant
diff and test results, and state whether delivery was only configured, rendered or actually executed. A lock
verification result, a successful build and a healthy deployed application are different pieces of evidence.
