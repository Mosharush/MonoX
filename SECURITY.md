# Security policy

## Supported versions

MonoX is pre-release software. Security fixes target the latest `0.x` release and the default branch.

## Report a vulnerability

Do not open a public issue for a vulnerability. Use GitHub private vulnerability reporting when it is enabled
for the public repository. Until then, contact `moshe@haru.sh` with a minimal reproduction and impact
description.

Do not include production credentials, customer data or unrelated private source in the report.

## Security model

- Generated projects contain no credentials.
- The repository contract forbids treating model output as executable shell. Current tools use typed CLI
  arguments and pass subprocess arguments as arrays.
- Deployment defaults to render and validate, not apply.
- CI uses read-only permissions unless a release job needs a narrow write permission.
- Autoscaling stays bounded by explicit configuration.
