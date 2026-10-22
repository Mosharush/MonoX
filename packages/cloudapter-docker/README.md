# `@monox/cloudapter-docker`

Renders a deterministic Docker Compose document from existing deployment v2 workloads. The Coolify adapter
uses the same renderer, so persistent storage, required environment references and healthchecks have one
implementation. This package remains npm-private and is available from a pinned MonoX source checkout.

```js
import { renderDockerCompose } from '@monox/cloudapter-docker';

const compose = renderDockerCompose(workloads, {
  name: 'example-preview',
  mode: 'docker', // or 'coolify'
});
```

The function is pure: it reads no files or process environment, starts no containers and makes no network
calls. It accepts resolved workload wrappers with `.deployment` or deployment v2 objects. Workloads must have
an immutable `build.image`; image building and any repository-specific build-context overlay remain separate,
explicit steps. Digest images are supported. Commands remain argument arrays. Ordinary dollar characters are
escaped against unintended Compose interpolation, while external references use required Compose
substitutions.

## API and gateway example

An internal application and a public gateway can be selected together. Give each its own v2 `id`, immutable
image, runtime command, ports and readiness probe. Use an exec probe when the image does not include `wget`
for HTTP or `nc` for TCP checks. The application keeps its state through a named volume:

```json
{
  "storage": [{ "name": "state", "type": "persistent", "mountPath": "/data", "size": "1Gi" }]
}
```

For workload `api`, this creates the service-scoped `api-state` Compose volume. Its lifecycle is separate from
container replacement. `size` remains portable intent, not a Docker disk quota. Set a persistent storage
`sourceRef` to reference an existing external Docker volume; MonoX does not create or delete that external
volume. Storage classes are rejected because Compose cannot resolve them.

A gateway can mount preprovisioned configuration and authentication files:

```json
{
  "storage": [
    {
      "name": "auth",
      "type": "secret",
      "sourceRef": "gateway-auth",
      "mountPath": "/etc/gateway/auth",
      "readOnly": true
    }
  ]
}
```

This becomes a read-only bind mount from `${MONOX_FILE_GATEWAY_AUTH:?required}` with
`bind.create_host_path: false`. The operator supplies the existing absolute path on the Docker host; only the
reference is rendered. `config` storage follows the same convention. Writable secret/config mounts are
rejected. `ephemeral` storage becomes a `tmpfs` mount. Missing files are not silently created as directories.

`env.secretRefs` become `${NAME:?required}` (or `${NAME:-}` when explicitly optional). No secret values are
read or included. CPU/memory limits, memory reservations, working directory and termination grace are
rendered. Autoscaling, multiple replicas, accelerators, cron and pre-stop commands fail explicitly; they need
another runtime adapter. Disabled and suspended workloads cannot accidentally be rendered for startup.

## Routing and execution

No host ports are published. A generic Docker operator supplies an explicit, reviewed port or proxy overlay.
In `mode: 'coolify'`, services get Coolify ownership labels. Only workloads with `network.exposure: 'public'`
receive a domain, selected from their Coolify override, route host or the optional renderer `domain`. Omitting
all domain values leaves routing for the Coolify operator. Internal workloads never inherit the target domain.

`createDockerCloudapter()` exposes plan/render for generic Docker targets. The CLI selects it for non-local
Docker transports. It does not infer an SSH connection, Docker context or credentials: apply/rollback/destroy
fail without an explicitly injected executor. The existing local Docker adapter still owns its separate,
tested Compose executor and local Compose-file lifecycle. Coolify still owns its service API transport and
health gate.

```bash
node --test packages/cloudapter-docker/test/*.test.mjs packages/cloudapter-coolify/test/*.test.mjs
```
