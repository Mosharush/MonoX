# `@monox/cloudapter-remote-proxy`

Optional loopback proxy for local development. It is disabled by default, accepts only explicit `http` and
`https` destinations, and is not a general-purpose forward proxy. The delivery CLI does not register it, so
target selection cannot turn it on. Production artifacts must not enable it.

```js
import {
  createRemoteProxyCloudapter,
  disabledRemoteProxyConfig,
  startRemoteProxyServer,
} from '@monox/cloudapter-remote-proxy';
```

`disabledRemoteProxyConfig()` is the only document generation writes. `startRemoteProxyServer()` throws unless
`enabled` is exactly `true`, the process is not a production environment, and `listen.host` is `127.0.0.1` or
`::1`.

## Allowlist

Every destination is checked before a connection is opened. An entry is an exact triple:

```json
{ "protocol": "https", "host": "dev.example.test", "port": 443 }
```

- `protocol` is `http` or `https`. `CONNECT`, `TRACE`, and any other scheme are rejected.
- `host` is a public hostname or a canonical IP. Matching is exact after lowercasing and IPv6 compression.
  Wildcards, suffixes, and single-label names are rejected.
- `port` is required. An omitted URL port means `80` or `443`, and that value must be the entry's port.
- Paths are forwarded only after the triple matches. The listen socket accepts absolute-form URLs only, so a
  request such as `GET /admin` is denied.
- The proxy binds only to loopback. It does not listen on `0.0.0.0`, a hostname, or any other address.

There is no config switch that weakens these checks. Unknown fields are rejected.

## Private ranges

Private and non-global addresses are denied even when an allowlist entry names them. The checked set is
`BLOCKED_IPV4_SUBNETS` and `BLOCKED_IPV6_SUBNETS` in `src/policy.mjs`:

- IPv4 unspecified, private, shared CGNAT, loopback, link-local (including cloud metadata), IETF protocol,
  documentation, 6to4 relay, benchmarking, multicast, and reserved ranges.
- IPv6 unspecified, loopback, unique-local, link-local, site-local, multicast, documentation, benchmarking,
  ORCHID, discard, deprecated 6to4, and local-use NAT64.
- IPv4-mapped IPv6 is judged as the embedded IPv4 address.
- NAT64 addresses in `64:ff9b::/96` are judged as the embedded IPv4 address.

Hostnames are also denied when they are special-use names such as `localhost`, names ending in `.internal`,
`.local`, `.localhost`, `.localdomain`, `.home`, `.intranet`, `.lan`, or `.arpa`, and metadata or cluster
names such as `metadata.google.internal` and `kubernetes.default`. Obfuscated literals such as `2130706433`
and `0177.0.0.1` are normalized by the URL parser and then denied.

## Redirects

Redirects are not followed. `3xx` responses and any `Location` header are checked again with the same
allowlist, private-range, and DNS rules. A target that fails is discarded: the caller receives `403` and the
forbidden `Location` is not returned. A target that passes is returned once, still without the proxy opening a
second connection. Userinfo, non-HTTP schemes, protocol-relative links to blocked addresses, and suffix
lookalikes such as `dev.example.test.evil.example` fail that check.

## DNS

Hostnames are resolved for the request being checked. The proxy does not keep a DNS cache that can be reused
for a later request. If any answer is a denied address, the destination is denied and nothing is dialed. A
change from a public answer to a private answer, or a single response that mixes public and private answers,
fails closed.

When every answer is public, the connection uses the first checked address only. Name resolution is not
repeated for that connection, and there is no fallback to another address. HTTPS keeps the allowlisted
hostname as the TLS server name.

## Credentials

`credentialForwarding` must be `never`. The proxy has no credential field, does not read proxy environment
variables, and does not attach ambient credentials.

Before an upstream request it removes `Authorization`, `Cookie`, `Proxy-Authorization`, and any header whose
name contains those credential words, including headers named by `Connection`. Userinfo and credential query
parameters (`token`, `password`, `secret`, `api_key`, and the related names in the policy module) deny the
request instead of being forwarded. Upstream `Set-Cookie` and credential response headers are removed. Denial
responses do not echo the blocked target.

## Production

Generation rejects a `remoteProxy` option. Docker-capable projects receive `infra/local/remote-proxy.json`
with `enabled: false`, an empty allowlist, and no credential material. Kubernetes manifests, Dockerfiles, and
Compose services do not include the proxy. Rendering a plan for a production environment forces `enabled` back
to `false`. `NODE_ENV=production`, an environment named `production`, or `production: true` on the selected
environment all refuse to listen.
