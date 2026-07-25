# `@monox/cli`

`monox` is the project lifecycle CLI for MonoX v2. Validation, explanation, planning and rendering are safe
inspection operations. Deploy and cloud setup orchestrate plan and apply without an extra prompt when the
selected adapter has an available executor, but still require an explicit environment and workload selector.
Unsupported remote transports and plan-only providers fail closed. Destruction requires an exact
`project/environment/target` confirmation string.

The executable selects the built-in local, PM2, Coolify, Kubernetes, static, AWS or GCP Cloudapter from target
axes. The SSH package is a transport primitive and is not presented as a complete Docker delivery path. Each
adapter can plan and render without credentials. Local Docker targets use the built-in safe Compose executor;
other apply paths fail closed until their explicit transport or provider executor is injected.
`NoopCloudapter` remains available for tests and custom inspection workflows, and never claims an external
state change.

The local executor validates `infra/local/docker-compose.yml` and merges `infra/docker/addons.compose.yaml`
when the selected environment enables bundled add-ons. It uses only allowlisted `docker compose` argument
arrays with `shell: false`, a project-specific namespace and explicit owned service names. Readiness checks
are bounded. Rollback and destroy never remove volumes, unmanaged services or the whole Compose project.

```text
monox validate
monox config explain @example/api --env local
monox plan --env preview --all
monox render --env preview --target preview-kubernetes --all --output-dir .monox/rendered
monox deploy --env preview --all
monox destroy --env preview --target preview-kubernetes --confirm example/preview/preview-kubernetes
```

A state-changing deploy is limited to one target per invocation and holds a local target lock. Successful
apply, rollback and destroy operations write redacted receipts below `.monox/receipts/`. Rendering validates
all artifacts first, writes a sibling staging directory and atomically promotes it without overwriting output.

Production state changes require a protected environment, `CI=true` and a target `identityRef`. Migration
commands emit a redacted report with changes, warnings and manual-review items; they never edit a source
package automatically. A root inventory remains read-only unless `--write` is explicit, and write mode refuses
the entire operation while any security or manual-review finding remains. `--redact-identifiers` removes
source paths, workload names, domains, account references and metric identifiers for a public aggregate
fixture. Root inventory uses `git ls-files -z` and scans tracked package manifests only. `--include-untracked`
is the explicit filesystem fallback for a directory without Git or when untracked packages must be included.

The clean-room legacy mapper recognizes the production-shaped `cdn`, `website`, `node` and `python` types;
worker service classes; camel-case lifecycle and probe settings; CPU, memory, RPS and RabbitMQ scaling;
resource pairs; GPU requests; environment patches; and `sideDeployments` variants. Static provider
identifiers, workload identity and the legacy target are reported as root target-binding work instead of being
copied into a package. Queue metrics receive a matching `RABBITMQ_URL` secret reference placeholder and still
require the operator to bind an external secret.

Migration remains blocked for unverified worker lifecycle contracts, inline secrets, pod self-patching,
arbitrary platform patches, hidden unpause behavior, metric sources, target bindings, storage mounts,
placement policies, unsupported scrape or scaler timing, disruption-budget differences and variant semantic
diffs. A zero legacy maximum is converted to `suspended: true`; it is never preserved as an invalid zero
maximum replica count.
