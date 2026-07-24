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

AI features must expose typed, allowlisted operations. The model can propose a command or deployment change,
but a trusted program validates it and a human approves state-changing operations.
