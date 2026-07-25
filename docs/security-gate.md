# Security gate

MonoX is a clean-room public implementation. Production repositories are behavioural references only. Their
history, source files, identifiers, manifests, fixtures and credentials must never be imported into this
repository or a generated project.

## Public repository controls

The public repository uses GitHub secret scanning, push protection, Dependabot security updates and CodeQL
default setup. CI also checks the complete Git history with Gitleaks, fails high-severity dependency audits,
and emits an SPDX JSON source SBOM. Release workflows use protected environments, OIDC trusted publishing,
provenance and immutable release identifiers.

CodeQL is configured through GitHub default setup. Do not add an advanced CodeQL workflow while default setup
is active because GitHub permits only one effective setup for a repository.

## Credential response order

Finding a credential in Git history starts an incident response. Rewriting Git history is not the first
response and does not revoke the credential.

1. Record the provider, repository, affected refs and known consumers without copying the secret value.
2. Disable or rotate the credential at the provider.
3. Replace it with OIDC, workload identity or an external secret reference.
4. Verify every consumer has moved to the replacement identity.
5. Create and verify an encrypted mirror backup with restricted access.
6. Agree a maintenance window and reclone instructions with contributors and deployment consumers.
7. Rewrite only repositories whose owner has explicitly approved the operation.
8. Force-push every affected ref, invalidate cached artifacts where the host permits it, and run a new
   full-history scan.

History rewriting preserves author dates, commit order and truthful chronology. It must never manufacture
activity or move commits for visual effect. Repositories owned by another person or organization require
explicit owner approval before any rewrite or force push.

## Rewrite acceptance record

Before a rewrite, the operator records these non-secret fields in a private incident log:

- credential provider and fingerprint;
- rotation timestamp and replacement identity type;
- consumer inventory and confirmation status;
- encrypted mirror location and verified checksum;
- refs to rewrite and the exact replacement rule;
- contributor notification and maintenance window;
- pre-rewrite and post-rewrite scan results;
- force-pushed refs and any cached artifact removal request.

The incident log is private. Public release notes may state that credentials were rotated and history was
cleaned, but must not include fingerprints, account identifiers, filenames from private products or scan
excerpts.

## Generated and runtime data

- `env.values` accepts non-secret values only.
- `env.secretRefs` identifies external secrets without embedding their contents.
- local development secrets belong in ignored `.env` files.
- plans and receipts are redacted and written below ignored `.monox/` state by default.
- generated fixtures use reserved example domains, synthetic names and non-routable identifiers.
- production apply requires a CI or OIDC identity and a protected environment.

## 0.2 release boundary

The following evidence is required before a `0.2.0-alpha` prerelease:

- repository formatting, lint, tests, builds and infrastructure validation pass from an immutable install;
- schema, generated declaration and runtime validator parity passes;
- synthetic migration goldens and representative generated-project acceptance pass;
- the complete public Git history passes secret scanning;
- high-severity dependency audit and source SBOM generation pass;
- the npm package dry run contains only reviewed public files;
- the tag points to the protected `main` commit and trusted publishing uses OIDC with provenance.

The alpha tag does not waive the private-reference credential gate. Any production case study, dual-render
diff or production rollout remains private until the affected credentials are rotated, the reference history
is handled under the approved process, and a canary plus rollback have been reviewed.

Kubernetes add-on metadata marked `unverified` is non-executable. Provider packages marked plan-only cannot be
promoted to apply support through documentation or a CLI flag. Support status changes only after the adapter's
live acceptance suite passes.

## Ownership boundary

History cleanup is allowed only for a repository owned by Moshe Harush or an organization that has explicitly
approved the exact rewrite. Behavioural reference access is not ownership permission. Do not push, rewrite,
archive or change visibility for another owner's repository as part of MonoX work.
