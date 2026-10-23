# Static web container

This optional container serves only `apps/web/public` with Nginx. The existing Node service and its deployment
contract remain available. Use this image when the deployment needs only the static site.

Build from the repository root:

```sh
docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
  -f apps/web/deploy/container/Dockerfile -t starter-web:local .
```

In Coolify, use the repository root as the build context, this Dockerfile path, port `80`, and HTTP health
path `/healthz`. Set the public domains in the deployment platform. TLS and domain redirects belong to the
outer proxy; this container has no production hostname or certificate paths.

The build requires the full lowercase Git commit in `SOURCE_COMMIT`. Coolify must enable its source-commit
build argument for the exact queued revision. The image serves `/deployment.json` with that commit and
no-store caching so deployment verification checks the served revision, not only an HTTP 200 response.

See [CI-gated site deployment](../../../../docs/site-deployment.md) for the GitHub environment and restricted
SSH gateway contract. Keep native Coolify push deployment disabled; the workflow owns the CI gate.

The Nginx configuration preserves language selection, static file routing and content security headers. The
Dockerfile-specific ignore file excludes source, credentials and development files outside the public site and
container configuration. The base image is pinned to a digest; review and rebuild when updating it.

Before release, run `yarn check`, build the image, validate `nginx -t`, and verify English/Hebrew responses,
`/healthz`, missing-file 404s and the image's public file manifest.
