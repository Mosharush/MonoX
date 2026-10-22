# Static web container

This optional container serves only `apps/web/public` with Nginx. The existing Node service and its deployment
contract remain available. Use this image when the deployment needs only the static site.

Build from the repository root:

```sh
docker build -f apps/web/deploy/container/Dockerfile -t starter-web:local .
```

In Coolify, use the repository root as the build context, this Dockerfile path, port `80`, and HTTP health
path `/healthz`. Set the public domains in the deployment platform. TLS and domain redirects belong to the
outer proxy; this container has no production hostname or certificate paths.

The Nginx configuration preserves language selection, static file routing and content security headers. The
Dockerfile-specific ignore file excludes source, credentials and development files outside the public site and
container configuration. The base image is pinned to a digest; review and rebuild when updating it.

Before release, run `yarn check`, build the image, validate `nginx -t`, and verify English/Hebrew responses,
`/healthz`, missing-file 404s and the image's public file manifest.
