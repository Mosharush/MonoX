# `@monox/cloudapter-static`

Plans static artifact delivery for AWS S3 with CloudFront or Google Cloud Storage with Cloud CDN. The adapter
derives logical origin and CDN references from the project, environment and workload unless the package uses
the allowlisted `adapterOverrides.static` fields.

The 0.2.0 adapter never invokes a provider CLI or shell. State changes require an injected
`context.static.execute(action)` implementation, and stale plans are rejected before that function is called.
From a source checkout, provider provisioning remains a separate `yarn monox cloud plan` operation. The
source-tree delivery CLI is npm-private in 0.2.0.
