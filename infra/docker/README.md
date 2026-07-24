# Node container image

`Dockerfile.node` builds any scoped Node workspace, then runs it as UID/GID `10001` with a
read-only-root-ready layout. The build requires the committed `yarn.lock`, installs it immutably, runs the
selected workspace build and focuses production dependencies before copying the workspace into the runtime
stage.

Build the example API or web workspace from the repository root:

```bash
docker build -f infra/docker/Dockerfile.node \
  --build-arg MONOX_WORKSPACE=@monox/api \
  -t monox-api:local .

docker build -f infra/docker/Dockerfile.node \
  --build-arg MONOX_WORKSPACE=@monox/web \
  -t monox-web:local .
```

The build argument becomes the runtime default, so an image built for `@monox/web` starts that workspace. The
runtime value can still be overridden explicitly when needed:

```bash
docker run --rm -p 3001:3001 \
  -e MONOX_WORKSPACE=@monox/web \
  -e PORT=3001 \
  monox-web:local
```

The entrypoint passes validated values as arguments to Yarn and never evaluates them as shell source. The
image runs without root, drops inline package installation from startup and includes an HTTP health check.
