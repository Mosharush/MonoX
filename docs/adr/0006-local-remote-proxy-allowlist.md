# ADR 0006: Keep the local remote proxy opt-in and allowlisted

- Status: Accepted
- Date: 2026-11-05

## Context

Generated local environments sometimes need to reach a remote development service. An open forward proxy would
let that environment reach private networks, follow a redirect to a metadata address, or forward local
credentials. Production delivery does not need that path.

## Decision

`@monox/cloudapter-remote-proxy` is a separate local adapter. It is disabled unless a config sets `enabled` to
`true`. Every destination must match an explicit protocol, host, and port. Private and non-global addresses
stay denied, redirects are not followed, DNS is checked for the request being connected, and credentials are
not forwarded.

The delivery CLI does not register the adapter. `create-monox` cannot enable it. Generated
`infra/local/remote-proxy.json` stays disabled and contains no credentials. Kubernetes manifests, Dockerfiles,
and Compose services do not include the proxy. A production environment cannot start it.

## Consequences

- Local development can opt in to a loopback proxy with a reviewed allowlist.
- Production artifacts do not gain a network egress path through this adapter.
- Callers that need a general forward proxy must use a different, separately reviewed component. This package
  does not become that component.
