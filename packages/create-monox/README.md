<p align="center">
  <img src="https://raw.githubusercontent.com/Mosharush/MonoX/main/assets/brand/monox-readme-header.png" alt="MonoX. Reusable monorepo boundaries and delivery paths for AI agents." width="1280">
</p>

# create-monox

`create-monox` generates a deterministic, polyglot monorepo from recipes bundled with the published package.
It never clones a live template repository. Every runnable workspace owns a strict `package.json.deployment`
v2 contract, while root configuration owns boundaries, environments, targets and add-ons.

The package has no runtime dependencies and supports Node.js 22.22.2+, 24.15.0+ and 26.x.

## Quick start

```sh
npm create monox@next -- my-product \
  --workspace api=node-fastify-api \
  --workspace web=react-vite-web \
  --addon redis \
  --addon rabbitmq \
  --delivery docker:local \
  --yes
```

Use `--dry-run` to validate selections and print every planned path without creating a directory, initializing
Git or installing dependencies.

## Options

| Option                        | Behavior                                                    |
| ----------------------------- | ----------------------------------------------------------- |
| `--directory <path>`          | Write to an empty or missing directory                      |
| `--package-manager <value>`   | `yarn`, `npm` or `pnpm`                                     |
| `--workspace <name=template>` | Select a versioned workspace recipe; repeatable             |
| `--addon <id>`                | Select a versioned add-on recipe; repeatable                |
| `--delivery <runtime:target>` | Select an available or cataloged delivery contract          |
| `--environment <value>`       | `development`, `preview`, `staging` or `production`         |
| `--config <path>`             | Load the same selections from JSON; explicit CLI values win |
| `--interactive`               | Prompt for missing selections in a TTY                      |
| `--dry-run`                   | Validate and list output without side effects               |
| `--infra <value>`             | Compatibility flag: `none`, `docker`, `kubernetes` or `all` |
| `--yes`                       | Skip confirmation; required in non-interactive write mode   |
| `--no-git`                    | Skip Git initialization                                     |
| `--no-install`                | Skip the JavaScript package-manager install and lockfile    |

All `0.1.2` flags remain supported. When no workspace is selected, the default is Fastify API, React/Vite web
and a TypeScript library.

## Configuration file

```json
{
  "name": "my-product",
  "packageManager": "pnpm",
  "workspaces": {
    "api": "node-fastify-api",
    "web": "react-vite-web",
    "worker": "python-worker",
    "shared": "typescript-library"
  },
  "addons": ["postgresql", "redis", "rabbitmq"],
  "delivery": "kubernetes:gcp-gke",
  "environment": "staging",
  "git": true,
  "install": false
}
```

Unknown configuration keys, duplicate workspace names, unsupported runtime combinations and unknown recipes
fail before the destination is touched. Production generation is deliberately fail-closed until a protected
CI/OIDC identity and immutable image or artifact digests are bound by a delivery plan. Local delivery,
unverified chart coordinates, `localstack` and `mailpit` are never accepted as production inputs.

Available delivery selections are listed separately from planned selections in `--help`. Remote Docker over
SSH, EC2 or Google Compute is cataloged for `0.2.0-alpha.2` and is rejected before any destination write in
this alpha.

## Maintained workspace recipes

- JavaScript and TypeScript: `node-http-api`, `node-fastify-api`, `node-express-api`, `node-nest-api`,
  `node-hono-api`, `node-worker`, `node-cron`, `react-vite-web`, `vue-vite-web`, `next-web`, `nuxt-web`,
  `sveltekit-web`, `angular-web`, `typescript-library`.
- Python with `uv`: `python-fastapi-api`, `python-django-api`, `python-worker`, `python-model`,
  `python-library`.
- PHP with Composer: `php-laravel-api`, `php-library`.
- Go: `go-chi-api`, `go-worker`, `go-library`.

Each recipe writes its own install, build, test and start scripts when those operations apply. Polyglot
workspaces require their named toolchain on the developer machine or in CI.

`php-laravel-api` is a minimal Laravel 12 application, not a standalone PHP front controller. It includes
Laravel's `artisan` and `bootstrap/app.php` lifecycle, API and health routes, provider registration,
application configuration and an ignored local environment initializer. Production delivery resolves `APP_KEY`
through the workspace deployment contract's external secret reference.

Run the generated `bootstrap:toolchains` script before building polyglot containers. It creates the selected
workspace's `uv.lock`, `composer.lock` or `go.sum`; PHP and Go Dockerfiles then consume that committed state
without open-ended dependency resolution during the image build.

## Add-ons

- Data: PostgreSQL, MongoDB and Redis.
- Messaging: RabbitMQ, NATS, Redpanda, Temporal and LocalStack.
- AI, search and storage: Ollama, Qdrant, Typesense, OpenSearch and MinIO.
- Identity and development: Keycloak, Flipt and Mailpit.
- Observability: OpenTelemetry Collector, Prometheus, Grafana, Loki and Tempo.
- Kubernetes: cert-manager, External Secrets, KEDA, metrics-server, Gateway support, kube-prometheus-stack and
  NVIDIA GPU Operator.

Bundled add-ons are enabled only for development and preview. Staging and production require an explicit
managed or external add-on decision. Compose ports bind to loopback. Most authentication-capable services
require values through `${VARIABLE:?Set VARIABLE}`, and generated `.env.example` files contain blank
placeholders only.

Redis, NATS and Typesense use Compose file secrets instead. Run the generated `local:secrets` script once to
create cryptographically random credentials under the ignored `.monox/secrets` directory. Existing files are
never replaced. Their startup wrappers construct private runtime configuration files, and daemon arguments,
healthcheck arguments and Compose environment entries contain file paths only, not secret values. The
generated `.dockerignore` excludes the entire `.monox` directory from build contexts.

Kubernetes add-on records are deliberately marked `unverified` until their OCI chart coordinates and digests
pass the release verification pipeline; execution must fail closed while that marker remains.

## Determinism

`monox.lock` records:

- generator and catalog versions,
- recipe IDs, versions and SHA-256 integrity values,
- add-on IDs, versions and SHA-256 integrity values,
- delivery target integrity,
- an integrity hash over the complete resolved selection.

Generated CI runs `scripts/verify-monox-lock.mjs`. Re-running the same package version with the same options
produces identical tracked content and file digests.

## Programmatic API

```js
import { generateProject } from 'create-monox';

const result = await generateProject({
  name: 'my-product',
  directory: '/tmp/my-product',
  packageManager: 'pnpm',
  workspaces: ['api=node-fastify-api', 'web=react-vite-web'],
  addons: ['redis'],
  delivery: 'docker:local',
  git: false,
  install: false,
});

console.log(result.fileDigests);
```

The programmatic API keeps installation disabled by default. Pass `dryRun: true` for a side-effect-free
generation plan.

### Typed recipe contracts

The package publishes TypeScript declarations for the generator and catalog entry points. The public
`WorkspaceRecipe` and `AddonRecipe` data contracts carry `apiVersion: "1"`, while each bundled recipe also has
its own semantic version and integrity digest.

```ts
import type { AddonRecipe, WorkspaceRecipe } from 'create-monox';
import { ADDON_RECIPES, WORKSPACE_RECIPES } from 'create-monox/catalog';

const workspace: WorkspaceRecipe = WORKSPACE_RECIPES['node-fastify-api'];
const addon: AddonRecipe = ADDON_RECIPES.redis;
```

Execution remains bundled-only in `0.2.0-alpha.1`. There is no external recipe loader in this release. Future
external references must use a namespaced ID such as `@acme/java-api`, declare an API version and recipe
version, and provide a verified `sha256-...` integrity value before MonoX can accept them. Passing an external
recipe ID to the current generator fails validation.

## Development

```sh
node --test packages/create-monox/test
```
