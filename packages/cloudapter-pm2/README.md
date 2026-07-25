# `@monox/cloudapter-pm2`

Produces an `ecosystem.config.json` and a release sequence with stage, start/reload, readiness gate and atomic
promotion steps. Commands are represented as executable/argument arrays. An injected PM2 transport performs
execution; no SSH connection or process mutation happens inside this package.

Secret references are listed as requirements and never copied into the PM2 artifact. A failed readiness gate
invokes the injected rollback hook before apply fails.
