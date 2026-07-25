# `@monox/provider-aws`

Produces a deterministic Pulumi Automation API intent for AWS targets. It is deliberately plan-only in the 0.2
alpha: no AWS SDK, Pulumi CLI or cloud endpoint is called. Authentication must be represented by a GitHub OIDC
role reference in `target.bindings.identityRef`; external secret integration is selected by
`target.bindings.secretStoreRef`. Static access keys and secret values are rejected.

`apply`, `rollback` and `destroy` fail with an explicit plan-only error. They never return a successful
receipt or imply that infrastructure changed.

Plans cover ECR plus EKS, EC2/SSM, provisioned Coolify or S3/CloudFront according to the selected runtime. GPU
node capacity is planned separately from each workload's `nvidia.com/gpu` request.
