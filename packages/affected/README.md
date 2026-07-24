# @monox/affected

Calculates changed workspaces from a Git comparison and propagates changes to internal dependents.

```bash
node packages/affected/src/cli.mjs --base origin/main --json
```

Git is called with an argument array, never a shell string. Missing or invalid base refs fail open and return
every workspace so CI does not silently skip required work.
