# ADR 0005: Keep task cache local and public CI on the full gate

- Status: Accepted
- Date: 2026-11-05

## Context

Workspace change detection can already tell which packages changed. It does not say which scripts to run, when
a result can be reused, or why a script was skipped. A remote cache or a hosted execution service would make
those decisions hard to inspect and would add a trust boundary the repository does not operate.

Public CI is the complete repository gate: immutable install, formatting, lint, tests, build and
infrastructure validation. Skipping any of those jobs because a task graph says they are unaffected is a
separate product decision.

## Decision

The task graph is an explicit local contract. A task id is `package#task`. Dependencies are declared as `task`
in the same workspace or `^task` in internal workspace dependencies. Cache keys are SHA-256 digests of the
task definition, the script text, every declared input file, direct dependency cache keys and the names and
hashes of declared environment values. Cache entries live under `.monox/cache/tasks` as readable JSON
manifests and output files. There is no remote cache and no hosted task execution.

Dry-run prints every task with status `run`, `skip` or `restore` and the reason for that status. Invalid,
incomplete, cyclic, uncovered or failed Git inputs fail open: the runner executes the declared tasks, or the
full gate when the document cannot be expanded, and it does not restore cache entries.

Public workflows keep running the complete repository gate. Selective CI is not enabled by this decision.

## Consequences

- Developers can see why a local task ran, was skipped or was restored, and can inspect the cache key.
- A bad or partial graph cannot hide work behind a skip or a stale restore.
- CI cost stays the same until a later change explicitly approves selective jobs.
- Repositories that want selection must declare inputs for every file whose change can affect a result.
