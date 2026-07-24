# ADR 0003: Treat model output as data, never executable shell

- Status: Accepted
- Date: 2026-07-24

## Context

Model output is probabilistic and may contain malformed, unsafe, or adversarial instructions. Passing it to a
shell would combine untrusted text with the broad authority of the current process.

## Decision

AI features expose typed, allowlisted operations. A trusted program parses model output, validates it against
a schema and policy, and passes subprocess arguments as arrays. Model text is never interpolated into a shell
command. State-changing operations also require an explicit environment and human approval.

## Consequences

- Prompt injection cannot directly become shell execution through the supported contract.
- Tool capabilities and argument validation remain reviewable in ordinary code.
- Some flexible requests must be rejected or mapped to a smaller approved operation.
- Tests must cover invalid tool names, invalid arguments, and approval boundaries.
