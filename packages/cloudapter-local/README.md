# `@monox/cloudapter-local`

Plans local Docker Compose delivery as executable plus argument arrays. The CLI supplies a built-in executor
for `infra/local/docker-compose.yml`; callers can still inject `context.local` for tests or alternate trusted
runtimes. The executor always uses `shell: false`, accepts only actions from the immutable plan and runs
bounded HTTP, TCP or container exec readiness probes before an apply receipt reports success.

Enabled `bundled` add-ons for the selected environment are merged from `infra/docker/addons.compose.yaml` and
started as explicit owned services. The command uses a project-specific Compose project name. Rollback stops
only those owned services. Destroy removes only their containers and never uses `down`, `--remove-orphans` or
volume deletion, so persistent data and unmanaged services are retained.
