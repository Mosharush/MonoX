# `@monox/cloudapter-coolify`

Builds a deterministic `POST /api/v1/services` request for an existing Coolify installation. The request
contains base64-encoded Docker Compose source and a bearer token reference, never a token value. Required
secret environment values use Compose `${NAME:?required}` expressions.

Compose is rendered by `@monox/cloudapter-docker`, shared with generic Docker planning. It includes immutable
images, healthchecks, CPU/memory limits and persistent named volumes. Coolify 4.4.7 rejects unresolved
`${...}` volume sources in its service API security validator, so `config` and `secret` file bindings fail
validation before planning. To mount preprovisioned files, use a `persistent` storage item with `sourceRef`
pointing to an existing external named volume and `readOnly: true`; the operator provisions and populates that
volume separately. Generic Docker mode still supports the renderer's external file references. Only public
workloads inherit the optional target domain; internal services remain internal. Image building and file
provisioning stay explicit operator steps. See the [shared renderer contract](../cloudapter-docker/README.md)
for supported intent and limitations.

The generated plan declares `read`, `write` and `deploy` as required scopes and `root` as forbidden. The
injected transport resolves `target.serverRef` and `target.bindings.identityRef`, verifies the actual token
scopes, and performs the request. Network I/O is injected with `context.coolify.request(request)`; the package
does not call the Coolify server directly and neither a base URL nor a token value is stored in configuration.

Service creation uses `instant_deploy: true`. The injected request transport must wait for the deployed
service health result and return `healthy: true`; an unhealthy result fails apply and invokes the rollback
transport when one is available.
