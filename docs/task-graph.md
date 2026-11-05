# Task graph

`@monox/tasks` plans workspace scripts for selective local execution. The plan is deterministic: the same
graph, workspaces, changed paths, environment inputs and local cache produce the same task order, cache keys
and statuses.

Public CI does not use this plan. The quality job in `.github/workflows/ci.yml` remains the complete
repository gate (`yarn install --immutable`, `yarn format:check`, `yarn lint`, `yarn test`, `yarn build` and
`yarn infra:check`). Selective CI needs a separate approval. See
[ADR 0005](adr/0005-local-task-cache-and-full-ci-gate.md).

The versioned document is [`schemas/v1/tasks.schema.json`](../schemas/v1/tasks.schema.json). A valid example
is [`schemas/fixtures/v1/valid.tasks.json`](../schemas/fixtures/v1/valid.tasks.json).

```bash
node packages/tasks/src/cli.mjs plan --root . --changed packages/api/src/server.mjs
node packages/tasks/src/cli.mjs run --root . --changed packages/api/src/server.mjs
```

`plan` is a dry run. It prints the explanation and does not execute scripts or write cache entries. `run`
performs that plan. Commands are argument arrays with `shell: false`.

## Task identity

A task node exists for each workspace that has a string `package.json` script of the same name as a graph
task. The id is the workspace package name, `#`, and the task name:

```text
@monox/api#build
```

Package names are unique. Task names match `^[A-Za-z0-9:_-]{1,64}$`. Nodes are ordered by dependencies and
then by id. A task that matches no workspace script is incomplete.

## Dependency rules

`dependsOn` entries use two forms:

| Entry    | Meaning                                                                     |
| -------- | --------------------------------------------------------------------------- |
| `build`  | The same workspace's `build` task. That script must exist in the workspace. |
| `^build` | The `build` task of each internal dependency that defines a `build` script. |

Internal dependencies are `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`
whose package names are workspaces in the same repository. A workspace is not its own dependency. `^build`
does not add an edge when the dependency workspace has no `build` script. Any other shape, including a task
name that the graph does not define, is invalid.

Edges are expanded before ordering. A cycle is invalid. Execution follows the topological order, with ready
tasks sorted by id.

## Cache key composition

Cache entries are local files under `.monox/cache/tasks/<cache-key>/`. The manifest is pretty JSON. Output
files are copied beside it. The directory is gitignored. MonoX does not upload it or read a hosted cache.

The cache key is the SHA-256 of the canonical JSON for all of the following:

- schema version and task id;
- the exact `package.json` script string;
- the declared `dependsOn`, `inputs`, `outputs`, `env` and `cache` values;
- every file matched by a declared input glob, as a repository path and content SHA-256, in glob order;
- a null path and hash for a declared glob that matches no file;
- each direct dependency's task id and cache key;
- each declared environment name and the SHA-256 of its value, or a fixed hash when the value is unset.

Environment values are never written into the manifest or the dry-run text. File contents are hashed, not
copied into the key. `.git`, `node_modules` and `.monox` are not hashed. Symbolic links are not inputs; a
declared input that matches one fails open. A glob must be a workspace-relative posix pattern. `**` is a whole
segment. `.`, `..`, empty segments, backslashes and absolute paths are rejected.

`cache: false` still computes a key for inspection, but the task always runs when selected and the runner does
not write or restore an entry. A manifest that cannot be parsed, does not match the key material, or is
missing a declared output file is a cache miss for that task. It does not fail the rest of the graph open.

## Dry-run behavior

Dry-run prints every node. `plan --json` prints the same decision, including `keyMaterial.inputs`, so the key
can be checked without opening the cache. Statuses are:

| Status    | Meaning                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skip`    | No declared input changed, no dependency will run, and declared outputs are still on disk.                                                                                           |
| `run`     | The task is selected and must execute. The reason names the changed inputs, the running dependency, a missing or incomplete cache entry, or `cache is disabled`.                     |
| `restore` | A local cache entry matches the current key. The runner copies declared outputs back and does not execute the script. A missing output can restore even when sources did not change. |

`--all` selects every task and then applies the cache. Without `--all`, selection starts from changed paths. A
changed input selects that task. A task whose dependency will `run` is selected too. A dependency that only
restores does not select its dependents. Changed paths that match a declared output, but not an input, are
covered and do not select the task.

`run` executes `yarn workspace <package> run <task>` only for `run` nodes, in plan order, then writes the
local manifest after a zero exit. A failed script writes nothing and stops the plan.

## Fail-open semantics

These inputs disable selection and cache restore:

- the graph file is missing, unreadable or not JSON;
- `schemaVersion` is not `"1"` or the document has an unknown property;
- a task is missing inputs, uses an unsafe glob, names an unknown dependency, overlaps an input with an
  output, matches a symlink, or matches no script;
- the dependency graph contains a cycle;
- a changed path is outside every declared input and output;
- the Git comparison cannot be trusted.

When the document still expands to task nodes, `execution` is `all-tasks`: every node has status `run`,
`cacheKey` is null, and the reason starts with `fail-open:`. When it does not expand, `execution` is `full`:
the only node is `#repository` and `run` invokes `yarn run check` (override the script name with
`--full-gate-script`). The full gate is also an argument array. Fail-open never skips a task and never
restores a cache entry.

Uncovered changes are intentional. A file that can affect results has to be declared as an input, or the safe
behavior is to run the work.
