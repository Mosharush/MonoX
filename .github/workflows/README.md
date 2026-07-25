# GitHub automation

GitHub Actions enforce the public-source quality and release boundaries. Pushing source runs CI using a
read-only GitHub token; publishing packages or containers requires an explicit release trigger and a protected
environment.

## Repository controls

1. Keep the default workflow token read-only and keep "Allow GitHub Actions to create and approve pull
   requests" disabled.
2. Require `yarn install --immutable`, formatting, repository rules, tests, builds, infrastructure validation,
   dependency audit, and full-history secret scanning before a release.
3. Enable the dependency graph, Dependabot alerts and security updates, secret scanning, push protection,
   private vulnerability reporting, and a protected `main` ruleset.
4. Keep external actions pinned to reviewed full commit SHAs.
5. Protect the `container-release` and `npm` environments before using their workflows.
6. Configure npm trusted publishing for the `create-monox` package, `Mosharush/MonoX`, `npm-release.yml`, and
   the `npm` environment. Do not add a long-lived npm token.
7. Confirm GHCR package visibility, immutable-tag expectations, retention, and maintainer access before the
   first container release.
8. Review every tracked file for provenance, credentials, private data, customer material, private domains,
   and environment-specific infrastructure. Reviewers with a confidential marker list can run
   `MONOX_PRIVATE_MARKERS='marker-one,marker-two' yarn lint` locally. Never commit or print that list.

## Workflow boundaries

- `ci.yml` runs the complete formatting, repository-rule, test, build, and infrastructure gate on Node.js 22,
  24, and 26. It also runs dependency review, dependency audit, full-history secret scanning and generates an
  SPDX JSON source SBOM. Dependency review requires a public repository or the corresponding GitHub security
  entitlement.
- `alpha-acceptance.yml` verifies the seven synthetic migration goldens and generates one representative Node,
  Python, PHP and Go project. It installs each selected toolchain, verifies `monox.lock`, builds and tests the
  workspaces, then starts the Node and Python APIs and probes their health endpoints. A separate job exercises
  the built-in local Cloudapter through doctor, deploy, an explicit health probe, status and owned-service
  destroy. This is representative coverage, not the complete catalog matrix.
- `catalog-matrix.yml` is scheduled weekly and can be started manually. It generates every one of the 24
  bundled workspace recipes in isolation, installs the selected toolchain, verifies the lock, runs tests and
  builds. It then runs the shared acceptance helper, which probes services, checks workers, waits for jobs and
  cron workloads, and marks libraries as not applicable.
- `kubernetes-smoke.yml` builds the synthetic API image, renders the runtime fixture, applies it to a
  disposable kind cluster, waits for rollout, checks workload policy, and probes the Service. kind, kubectl,
  and the kind node image are pinned and verified. The workflow never contacts a production cluster.
- `container-release.yml` is manual-only, accepts an explicit SemVer tag, publishes separate API and web
  images to GHCR, refuses to replace an existing release tag, and attaches BuildKit SBOM and provenance
  attestations. GitHub build provenance is also recorded for supported repositories.
- `npm-release.yml` publishes only when a tag exactly matches `create-monox-v<package version>`. It uses npm
  trusted publishing with OIDC and provenance, waits for the exact version to become readable from the public
  registry, generates a clean npm-based consumer from that registry artifact, and runs the generated test
  suite. Package metadata can be release-ready in the tree while the protected environment and matching tag
  continue to block publication.

`create-monox` exists on npm under the `mosharush` maintainer account. Version 0.1.0 was the first release
from this public repository and upgraded the historical 0.0.5 package in place. The public `latest` tag is
currently 0.1.2; the 0.2 source stays on an alpha prerelease until the release gates are complete. Releases
keep the `https://github.com/Mosharush/MonoX` metadata, include the MIT license in the tarball, and use
trusted publishing with registry provenance.

CodeQL uses GitHub default setup with JavaScript and TypeScript analysis. Keep that repository-level setup
instead of adding a duplicate advanced workflow.

There is intentionally no workflow with static cloud credentials. Cloud apply workflows may be added only
after an environment, threat model, OIDC trust policy, protected environment and exact adapter scope are
reviewed.

## Action pinning

Every external action is pinned to a full commit SHA. The version comment records the reviewed upstream
release. Dependabot may propose updates, but a maintainer must review the upstream release and resulting SHA
before merging.
