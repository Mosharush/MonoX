# @monox/affected

Calculates changed workspaces from a Git comparison and propagates changes to internal dependents.

```bash
node packages/affected/src/cli.mjs --base origin/main --json
```

Git is called with an argument array, never a shell string. Missing or invalid base refs fail open and return
every workspace so CI does not silently skip required work.

Workspace detection feeds the local task graph in `@monox/tasks`. That graph adds task identity, dependency
ordering, a transparent local cache and dry-run explanations. Public CI does not use either result to skip
work: the quality workflow remains the complete repository gate until selective CI is separately approved. See
[task graph](../../docs/task-graph.md).
