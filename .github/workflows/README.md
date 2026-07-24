# GitHub automation

Actions must remain disabled until the clean-room candidate repository exists, the complete source and
provenance review is approved, and the activation checklist below is complete. Merely pushing these files is
not approval to run or publish anything.

## Activation checklist

1. Create the candidate as a new repository with no imported Git history.
2. Review every tracked file for original or compatible provenance, credentials, private data, customer
   material, private domains, and environment-specific infrastructure. Reviewers with a confidential marker
   list can run `MONOX_PRIVATE_MARKERS='marker-one,marker-two' yarn lint` locally. Never commit or print that
   list.
3. Generate and review `yarn.lock`, then pass `yarn install --immutable`, `yarn format:check`, `yarn lint`,
   `yarn test`, `yarn build`, and `yarn infra:check` locally.
4. Pass a full-history secret scan and review the dependency audit before making the repository public.
5. Set the repository's default workflow token permission to read-only and keep "Allow GitHub Actions to
   create and approve pull requests" disabled.
6. Enable the dependency graph, Dependabot alerts and security updates, secret scanning, push protection,
   private vulnerability reporting, and a protected `main` ruleset.
7. Create a protected `container-release` environment with required maintainer review.
8. Confirm `packages/create-monox/package.json` names this exact public repository, then configure npm trusted
   publishing for the `create-monox` package, this repository, `npm-release.yml`, the protected `npm`
   environment, and the `npm publish` action. Do not add a long-lived npm token.
9. Confirm GHCR package visibility, immutable-tag expectations, retention, and maintainer access before the
   first container release.
10. Enable Actions only after the candidate is public-ready and a maintainer approves this exact workflow set.
    Run CI manually first; do not start with a release workflow.

## Workflow boundaries

- `ci.yml` runs read-only quality, tests, builds, infrastructure validation, dependency review, dependency
  audit, and secret scanning. The dependency review job is intended for the public candidate or a private
  repository with the required GitHub security entitlement.
- `container-release.yml` is manual-only, accepts an explicit SemVer tag, publishes separate API and web
  images to GHCR, refuses to replace an existing release tag, and attaches BuildKit SBOM and provenance
  attestations. GitHub build provenance is also recorded for supported repositories.
- `npm-release.yml` publishes only when a tag exactly matches `create-monox-v<package version>`. It uses npm
  trusted publishing with OIDC and provenance. Package metadata can be release-ready in the tree while the
  protected environment and matching tag continue to block publication.

`create-monox` already exists on npm under the `mosharush` maintainer account. Version 0.1.0 is an in-place
upgrade from 0.0.5, not a new package name. The release must replace the historical repository metadata with
`https://github.com/Mosharush/MonoX`, include the MIT license in the tarball, and use trusted publishing.

There is intentionally no cloud deployment workflow. Add deployment automation only after an environment,
threat model, OIDC trust policy, and approval boundary are designed and reviewed.

## Action pinning

Every external action is pinned to a full commit SHA. The version comment records the reviewed upstream
release. Dependabot may propose updates, but a maintainer must review the upstream release and resulting SHA
before merging.
