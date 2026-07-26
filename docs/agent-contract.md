# Agent contract

`AGENTS.md` is the canonical cross-tool instruction source.

The contract gives coding agents:

- a small repository map;
- allowed dependency directions;
- safe commands for interactive and non-interactive work;
- clear deployment approval boundaries;
- one definition of done.

Tool-specific adapters may summarize this file, but they must link back to it and must not create conflicting
rules. CI validates the repository boundaries that matter to correctness and security.

AI features must expose typed, allowlisted operations. Model output is data and cannot become a shell string
or an external request directly. A trusted program validates every proposal. A person or protected CI job
authorizes state-changing commands with an explicit environment and workload selector; production also
requires the protected-environment and external-identity gates.

Runnable workspaces own `package.json.deployment`. Agents must not recreate a root application list or place
provider credentials in a workload patch. From a MonoX source checkout, use `yarn monox config explain` to
inspect the effective contract before changing a profile, environment or variant. The public generator does
not install the source-tree delivery CLI in generated projects.

See [ADR 0003](adr/0003-model-output-is-not-executable-shell.md) for the trust boundary around model output.
