# `@monox/lifecycle`

One owner for process signals and graceful drain. Hooks run in reverse registration order, shutdown is
idempotent, and timeout handling is reported without forcing `process.exit` inside library code.
