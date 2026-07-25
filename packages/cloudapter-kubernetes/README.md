# `@monox/cloudapter-kubernetes`

This Cloudapter turns resolved deployment v2 workloads, or legacy deployment v1 documents, into deterministic
Kubernetes YAML. Planning and rendering are offline. Applying, status checks, rollback and destroy require an
explicitly injected cluster transport; the package never shells out to `kubectl` or selects a kube context.

When a package leaves `build.image` unresolved, the adapter derives a repository from
`target.bindings.registry` and a deterministic `source-<digest>` tag from the source digest. Explicit package
images are preserved. The selected target also supplies the namespace and any missing public route host before
validation, planning and rendering.

The renderer enforces restricted pod security, dedicated ServiceAccounts, NetworkPolicies, resources, probes,
topology spread and bounded autoscaling. A non-network worker receives neither a Service nor an Ingress.

```js
import { createKubernetesCloudapter } from '@monox/cloudapter-kubernetes';

const adapter = createKubernetesCloudapter();
const plan = await adapter.plan(context);
const { artifacts } = await adapter.render(plan, context);
```

For apply, pass `context.kubernetes.applyArtifact(artifact)`. Production callers remain responsible for an
approved identity, server-side diff policy, locking and protected environment controls.
