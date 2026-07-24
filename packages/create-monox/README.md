# create-monox

`create-monox` generates a compact JavaScript monorepo with clear ownership boundaries for people and coding
agents. It has no runtime dependencies and supports Node.js 22 through 26.

> Release status: this tree prepares `create-monox` 0.1.0 as an in-place upgrade to the existing
> [npm package](https://www.npmjs.com/package/create-monox). The registry still serves 0.0.5 until the public
> repository, trusted publisher, and release workflow pass their final gates.

## Usage

From this repository:

```sh
yarn run create my-project --yes
```

After 0.1.0 is published, npm can run the package directly:

```sh
npm create monox@latest -- my-project --yes
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
before the first push.

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
