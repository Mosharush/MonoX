# Architecture decision records

Architecture decision records explain why MonoX has a boundary, not only how the current code implements it.
Accepted decisions remain in this log when they are replaced so contributors can follow the design history.

| ADR                                                        | Status   | Decision                                              |
| ---------------------------------------------------------- | -------- | ----------------------------------------------------- |
| [0001](0001-explicit-contracts-over-hidden-conventions.md) | Accepted | Prefer explicit contracts over hidden conventions     |
| [0002](0002-render-is-separate-from-apply.md)              | Accepted | Keep render separate from apply                       |
| [0003](0003-model-output-is-not-executable-shell.md)       | Accepted | Treat model output as data, never executable shell    |
| [0004](0004-package-manager-adapters.md)                   | Accepted | Keep package managers behind small generator adapters |
| [0005](0005-local-task-cache-and-full-ci-gate.md)          | Accepted | Keep task cache local and public CI on the full gate  |
| [0006](0006-local-remote-proxy-allowlist.md)               | Accepted | Keep the local remote proxy opt-in and allowlisted    |

New decisions use the next four-digit number. A change that replaces an accepted decision adds a new ADR and
marks the old record as superseded instead of rewriting history.
