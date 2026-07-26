# Deployment migration guide

MonoX migration is designed for evidence before edits. It inventories package-owned deployment blocks,
produces v2 candidates and records every unresolved semantic or security question. It does not apply
infrastructure.

## Read-only inventory

Run from a clean clone of the repository being assessed:

```sh
monox migrate deployment \
  --from legacy-production \
  --root . \
  --output .monox/migration-report.json
```

The default scan uses `git ls-files -z` and reads tracked `package.json` files only. This prevents nested
copies, build output and untracked experiments from inflating the inventory. Use `--include-untracked` only
for an explicit filesystem audit or for a directory that is not a Git repository.

The command is read-only unless `--write` is present. Output files belong below ignored `.monox/` state or in
another access-controlled review location.

## Mapping rules

| Legacy pattern                 | v2 candidate                                    | Required review                                      |
| ------------------------------ | ----------------------------------------------- | ---------------------------------------------------- |
| Service or ingress fields      | `network.exposure`, ports and routes            | Domain, TLS and ownership                            |
| Shell start command            | `runtime.command` argv array                    | Manual conversion, never shell evaluation            |
| HPA CPU or memory              | Typed `scaling.metrics`                         | Bounds and resource requests                         |
| Queue length                   | Typed KEDA metric and explicit source reference | Authentication and event semantics                   |
| RPS                            | Typed RPS metric                                | Explicit source and query                            |
| `sideDeployments`              | `variants`                                      | Semantic diff for every reduced field                |
| GPU count or model             | `resources.accelerators`                        | Provider capacity, taints, storage and metrics       |
| Maximum replicas equal to zero | `suspended: true`                               | Explicit resume ownership                            |
| Pod self-patching              | No automatic mapping                            | Redesign without broad runtime RBAC                  |
| Arbitrary Kubernetes patch     | No automatic mapping                            | Model the portable intent or reject it               |
| Inline credential              | No migrated value                               | Rotate and replace with an external secret reference |

Unknown legacy fields remain manual-review findings. Migration never silently drops an unknown field and then
marks the candidate ready.

## Public aggregate

To create a report that can be reviewed outside the private repository:

```sh
monox migrate deployment \
  --from legacy-production \
  --root . \
  --redact-identifiers \
  --output .monox/migration-public.json
```

Public redaction replaces root paths, workspace paths, workload and variant names, domains, image references,
commands, metric identifiers, environment values and identity details. It keeps workload kinds, resource
shapes, scaling modes and review categories so generic migration lessons remain useful.

Do not publish a report merely because the redaction option was used. Scan it separately and review it against
the private marker list before release.

## Current private-reference checkpoint

The tracked-only, read-only audit on 2026-07-25 found 42 deployment blocks. All 42 generated v2 candidates
pass schema validation. One candidate has no manual finding; the other 41 remain blocked by 244 explicit
review items covering target bindings, scaling timing and safety, placement, metric sources, disruption
budgets, telemetry, worker lifecycle, secret binding, storage, hidden resume behavior and one privileged
self-patch pattern.

These numbers are migration evidence, not a production case study. No private package manifest, command,
identifier, path or rendered resource is committed here. The redacted report remains ignored local state until
the private owners complete credential cleanup and review.

## Write gate

`--write` operates at inventory scope. If any entry has a security, unmapped or manual-review finding, no
package manifest is edited. When the report is clear:

1. save the read-only report;
2. review every candidate with its workload owner;
3. record the target binding and external secret ownership;
4. run write mode on a dedicated branch;
5. validate the entire project;
6. compare the current renderer with the v2 renderer using sanitized diffs;
7. deploy to development, then staging, then one low-risk canary;
8. exercise rollback before broadening adoption.

`--write` cannot be combined with `--redact-identifiers` because write mode must preserve the real package
identity inside the private working tree.

## Adoption order

Migrate in increasing operational risk:

1. stateless internal service;
2. static output or CDN workload;
3. bounded public service;
4. queue worker with drain;
5. long-running job;
6. route-based RPS workload;
7. scale-to-zero workload;
8. GPU model workload.

Keep the previous deployment revision and pipeline available until rollback has succeeded for each new class.
Feed only generic lessons back into MonoX as synthetic fixtures.

The committed migration fixtures use reserved example data and can be verified with:

```sh
node --test packages/cli/test/fixtures/migration-goldens.test.mjs
```
