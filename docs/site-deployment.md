# CI-gated public site deployment

The public static site can deploy from `main` through `.github/workflows/deploy-site.yml`. This is separate
from the generator's Coolify adapter and from deployment of generated consumer projects. It does not publish
an npm package or a container release.

## Trigger and revision checks

Completion of `CI`, `0.2 release acceptance`, `Kubernetes runtime smoke` or repository-default CodeQL starts
the gate. Automatic triggers must belong to the same repository and `main`, with an allowlisted workflow path
and event. CodeQL's `CodeQL`/`Push on main` completion names allow a successful CodeQL rerun to recover
deployment. Pull requests, forks and manually dispatched upstream CI runs cannot authorize deployment.

An operator can also dispatch **Deploy public site** on `main` to retry its GitHub-provided main snapshot.
There is no revision input. This retry passes the same current-main and successful-workflow checks; dispatches
on other branches are rejected. Reconcile an interrupted gateway request before retrying it.

The gate waits at most 20 minutes for the latest run of each required workflow on the triggering commit:

- `CI` (`.github/workflows/ci.yml`, push event);
- `0.2 release acceptance` (`.github/workflows/release-acceptance.yml`, push event);
- `Kubernetes runtime smoke` (`.github/workflows/kubernetes-smoke.yml`, push event);
- repository-default CodeQL (`dynamic/github-code-scanning/codeql`, dynamic event).

Every selected run must be completed successfully. A newer failed or in-progress run cannot be replaced by an
older success. Run attempts are read again to catch reruns. Missing results, unavailable API access and an
expired wait fail closed. The commit must still equal `main`; stale commits are skipped.

The production job repeats the checks after any environment or runner queue delay. Concurrency coalesces
notifications for the same SHA without cancelling an in-flight deployment. Different SHAs are serialized by
the gateway's application lock, which must remain held until the deployment reaches a terminal state and its
public marker is verified. GitHub and Coolify do not share an atomic transaction: a push arriving after the
last check can leave the previous revision in flight. The gateway must recheck freshness after obtaining its
lock and before queueing the immutable revision.

## Required GitHub environment

Configure a `production` environment restricted to the protected `main` branch. Its secrets are:

| Secret                    | Purpose                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `COOLIFY_SSH_PRIVATE_KEY` | Dedicated deployment key accepted only by the restricted gateway. |
| `COOLIFY_SSH_KNOWN_HOSTS` | Independently verified host-key pin for that gateway.             |

Set these environment variables without committing their values:

| Variable                | Purpose                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `COOLIFY_SSH_HOST`      | Gateway hostname or IPv4 address.                                     |
| `COOLIFY_SSH_USER`      | Account whose dedicated key has a forced command.                     |
| `DEPLOYMENT_VERIFY_URL` | Public HTTPS URL of `/deployment.json`, with no credentials or query. |

The short-lived `GITHUB_TOKEN` has only `actions: read` and `contents: read`. It travels through SSH standard
input, never command arguments or a persisted deployment configuration. The gate job has no deployment
secrets. Production jobs use only the checked main revision, without executing pull-request artifacts or
restoring pull-request caches.

The generic gate helper also accepts `COOLIFY_REQUIRED_WORKFLOWS` as a validated JSON list of
`{name, path, event}` records for consumers using a different CI workflow. This site's workflow uses the four
defaults above. The server must independently enforce its fixed workflow allowlist; a client override is not
authority.

## Restricted gateway contract

Provision the server gateway independently of the repository. The authorized key must disable port, agent and
X11 forwarding, PTY allocation and arbitrary commands. It accepts only the literal command `deploy`, followed
by one JSON request on standard input:

```json
{ "sha": "0123456789abcdef0123456789abcdef01234567", "github_token": "EPHEMERAL_READ_TOKEN" }
```

Its server-owned configuration binds one repository, branch and Coolify application. It must:

1. Validate the request and independently verify the current main SHA and required workflow results through
   GitHub. Never log the token or accept application identifiers, shell commands or server addresses from it.
2. Acquire an application lock, recheck freshness, and reconcile existing queued, running or successful
   deployments for that exact SHA before creating another one.
3. Queue that immutable commit in Coolify. Hold the lock through its terminal result and public commit-marker
   check. Reconcile uncertain request outcomes instead of blindly retrying a state change.
4. Return JSON with `status` equal to `deployed`, `already_deployed` or `stale`, and `sha` equal to the
   requested commit. Failures return nonzero with sanitized diagnostics. Provider metadata may be returned,
   but the client prints only status and SHA.

The SSH client has a 20-minute timeout and removes its private temporary key files on success or failure. An
interrupted connection is not evidence that the server stopped deploying. Inspect and reconcile the
gateway/Coolify state before retrying. The client separately requires the public HTTPS marker to match the
requested commit before reporting a deployed result. If another deployment wins the gateway lock after that
verified receipt, the client accepts a different public marker only when it equals GitHub's new current main;
it reports the older request as `stale`. An arbitrary mismatch or failed GitHub lookup cannot establish
supersession.

## Coolify and container settings

Use `main`, repository-root build context, `apps/web/deploy/container/Dockerfile`, port `80` and health path
`/healthz`. Enable Coolify's source-commit build argument so `SOURCE_COMMIT` contains the exact queued Git
SHA. The build rejects a missing or malformed SHA and writes `/deployment.json` into the served image.

Keep Coolify's native automatic push deployment **disabled**. GitHub's CI-gated gateway is the automatic
deployment path; enabling an independent push webhook would bypass the gate.

PR and main CI build the static container and verify Nginx configuration, both languages, health, the commit
marker and rejection of non-public repository paths. These checks need no production credentials. See the
[container instructions](../apps/web/deploy/container/README.md) for local building.

For operational verification, distinguish a successful workflow gate, an accepted queue request, a terminal
Coolify deployment and a public marker matching the commit. A code push changes the public site only after all
of those stages succeed.
