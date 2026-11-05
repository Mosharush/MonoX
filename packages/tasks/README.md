# @monox/tasks

Plans a deterministic local task graph for selective execution. The cache is a readable directory under
`.monox/cache/tasks`. There is no remote cache and no hosted runner. The full contract is
[docs/task-graph.md](../../docs/task-graph.md).

```bash
node packages/tasks/src/cli.mjs plan --root . --changed packages/api/src/server.mjs
node packages/tasks/src/cli.mjs run --root . --changed packages/api/src/server.mjs
```

`plan` explains every task and does not execute scripts or write cache entries.

## Task identity

A node exists where a workspace script name matches a task in `monox.tasks.json`. The id is
`<package-name>#<task>`.

## Dependency rules

- `build` depends on the `build` script in the same workspace. That script must exist.
- `^build` depends on the `build` script of each internal workspace dependency that has one.
- Internal dependencies come from `dependencies`, `devDependencies`, `optionalDependencies` and
  `peerDependencies`.
- Unknown task names, unsafe globs and cycles are invalid.

## Cache keys

The SHA-256 key includes the schema version, task id, script text, declared `dependsOn`, `inputs`, `outputs`,
`env` and `cache`, the path and content hash of every file matched by a declared input, a null record for a
declared glob with no matches, each direct dependency cache key, and the name plus value hash of every
declared environment variable. Raw environment values are not stored. `.git`, `node_modules` and `.monox` are
excluded.

## Dry-run

Each node is `run`, `skip` or `restore`. The reason names the changed inputs, the dependency that will run,
the cache hit, the cache miss, a missing output or a disabled cache. `--json` includes the key material.

## Fail-open

Invalid or incomplete graphs, uncovered changes and failed Git comparisons run every expanded task, or
`yarn run check` when the document cannot be expanded. They do not skip tasks and do not restore cache
entries.

## Public CI

Selective execution is local. The public quality workflow keeps the complete repository gate until selective
CI is separately approved.
