<p align="center">
  <img src="https://raw.githubusercontent.com/Mosharush/MonoX/main/assets/brand/monox-readme-header.png" alt="MonoX. Reusable monorepo boundaries and delivery paths for AI agents." width="1280">
</p>

# create-monox

`create-monox` generates a compact JavaScript monorepo with clear ownership boundaries for people and coding
agents. It has no runtime dependencies and supports Node.js 22.22.2+, 24.15.0+, and 26.x.

Generated commands pin Yarn 4.9.1, npm 10.9.2, or pnpm 10.13.1. Yarn and pnpm run through Corepack 0.35.0,
including on Node.js distributions that do not bundle Corepack.

The package is available as the [`create-monox` npm package](https://www.npmjs.com/package/create-monox).
Releases use npm trusted publishing from the protected GitHub workflow and include registry provenance.

## Usage

From npm:

```sh
npm create monox@latest -- my-project --yes
cd my-project
npx --yes corepack@0.35.0 yarn run dev:api
```

From a checked-out MonoX repository:

```sh
yarn run create my-project --yes
```

Available options:

| Option                      | Values                                              | Default    |
| --------------------------- | --------------------------------------------------- | ---------- |
| `--directory <path>`        | Any empty or missing directory                      | `./<name>` |
| `--package-manager <value>` | `yarn`, `npm`, `pnpm`                               | `yarn`     |
| `--infra <value>`           | `none`, `docker`, `kubernetes`, `all`               | `all`      |
| `--yes`                     | Skip confirmation; required in non-interactive mode | off        |
| `--no-git`                  | Do not initialize a Git repository                  | off        |
| `--no-install`              | Skip dependency installation and lockfile creation  | off        |

Run `create-monox --help` for the complete command reference.

Scripts, CI jobs, and other sessions without an interactive terminal must pass `--yes` explicitly. The CLI
installs dependencies by default so the selected package manager creates the lockfile required by generated CI
and Docker builds. Pass `--no-install` only when another process will run the install and commit that lockfile
before the first push. Generated CI runs its test gate on the supported Node.js 22, 24, and 26 lines and uses
the same pinned package-manager adapter as local generation and Docker builds.

## Generated layout

```text
my-project/
  .github/workflows/ci.yml
  apps/
    api/
    web/
  packages/
    shared/
  test/
  AGENTS.md
  monox.config.json
  package.json
```

Docker templates are written to `infra/docker` and Kubernetes templates to `infra/kubernetes` when selected.
The generated files contain no credentials, deployment domains, or organization-specific product code.

The destination must be empty. Existing content is never overwritten.

## Programmatic API

```js
import { generateProject } from 'create-monox';

const result = await generateProject({
  name: 'my-project',
  directory: '/tmp/my-project',
  packageManager: 'pnpm',
  infra: 'kubernetes',
  git: false,
  install: false,
});

console.log(result.directory);
```

`generateProject` accepts an optional command runner as its second argument. This makes Git initialization and
dependency installation observable or replaceable in automation. The programmatic API keeps `install: false`
as its side-effect-safe default; callers must run the selected package manager before enabling generated CI.

## Development

```sh
npm test --prefix packages/create-monox
```
