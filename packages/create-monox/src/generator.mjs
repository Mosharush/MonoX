import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export const PACKAGE_MANAGERS = Object.freeze(['yarn', 'npm', 'pnpm']);
export const INFRA_OPTIONS = Object.freeze(['none', 'docker', 'kubernetes', 'all']);

const PACKAGE_MANAGER_VERSIONS = Object.freeze({
  yarn: 'yarn@4.9.1',
  npm: 'npm@10.9.2',
  pnpm: 'pnpm@10.13.1',
});
const LOCKFILE_NAMES = Object.freeze({
  yarn: 'yarn.lock',
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
});

const PROJECT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateProjectName(name) {
  if (typeof name !== 'string' || !PROJECT_NAME_PATTERN.test(name)) {
    throw new Error(
      'Project name must use 1 to 63 lowercase letters, numbers, or hyphens, and must start and end with a letter or number.'
    );
  }

  return name;
}

export function resolveDestination({ cwd = process.cwd(), name, directory } = {}) {
  validateProjectName(name);

  if (directory === undefined) {
    return resolve(cwd, name);
  }

  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new Error('Directory must be a nonempty path.');
  }

  return isAbsolute(directory) ? resolve(directory) : resolve(cwd, directory);
}

export async function runCommand(command, args, { cwd } = {}) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    });

    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      rejectPromise(new Error(`${command} failed with ${reason}.`));
    });
  });
}

export async function generateProject(options, dependencies = {}) {
  const normalized = normalizeOptions(options);
  const destination = resolveDestination(normalized);
  const execute = dependencies.runCommand ?? runCommand;

  await prepareDestination(destination);

  const files = createProjectFiles(normalized);
  for (const [relativePath, contents] of files) {
    const outputPath = join(destination, relativePath);
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, contents, { encoding: 'utf8', flag: 'wx' });
  }

  if (normalized.git) {
    await execute('git', ['init', '--initial-branch=main'], { cwd: destination });
  }

  if (normalized.install) {
    const invocation = installInvocation(normalized.packageManager);
    await execute(invocation.command, invocation.args, { cwd: destination });
  }

  return Object.freeze({
    name: normalized.name,
    directory: destination,
    packageManager: normalized.packageManager,
    infra: normalized.infra,
    files: Object.freeze([...files.keys()]),
    gitInitialized: normalized.git,
    installed: normalized.install,
  });
}

function installInvocation(packageManager) {
  if (packageManager === 'npm') {
    return { command: 'npm', args: ['install'] };
  }

  return { command: 'corepack', args: [packageManager, 'install'] };
}

function normalizeOptions(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new Error('Generator options must be an object.');
  }

  const name = validateProjectName(options.name);
  const packageManager = options.packageManager ?? 'yarn';
  const infra = options.infra ?? 'all';

  if (!PACKAGE_MANAGERS.includes(packageManager)) {
    throw new Error(`Package manager must be one of: ${PACKAGE_MANAGERS.join(', ')}.`);
  }

  if (!INFRA_OPTIONS.includes(infra)) {
    throw new Error(`Infrastructure must be one of: ${INFRA_OPTIONS.join(', ')}.`);
  }

  return {
    name,
    cwd: options.cwd ?? process.cwd(),
    directory: options.directory,
    packageManager,
    infra,
    git: options.git ?? true,
    install: options.install ?? false,
  };
}

async function prepareDestination(destination) {
  let entry;

  try {
    entry = await lstat(destination);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  if (entry) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Destination is not a directory: ${destination}`);
    }

    const contents = await readdir(destination);
    if (contents.length > 0) {
      throw new Error(`Destination is not empty: ${destination}`);
    }
  } else {
    await mkdir(destination, { recursive: true });
  }
}

function createProjectFiles(options) {
  const files = new Map([
    ['package.json', json(rootPackage(options))],
    ['monox.config.json', json(monoxConfig(options))],
    ['AGENTS.md', agentsGuide(options)],
    ['README.md', projectReadme(options)],
    ['.gitignore', gitignore()],
    ['.editorconfig', editorConfig()],
    ['.github/workflows/ci.yml', ciWorkflow(options)],
    ['apps/api/package.json', json(apiPackage(options))],
    ['apps/api/src/server.mjs', apiServer(options)],
    ['apps/web/package.json', json(webPackage(options))],
    ['apps/web/src/server.mjs', webServer(options)],
    ['packages/shared/package.json', json(sharedPackage(options))],
    ['packages/shared/src/index.mjs', sharedModule(options)],
    ['test/smoke.test.mjs', smokeTest()],
  ]);

  if (options.packageManager === 'pnpm') {
    files.set('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  }

  if (options.packageManager === 'yarn') {
    files.set('.yarnrc.yml', 'nodeLinker: node-modules\n');
  }

  if (options.infra === 'docker' || options.infra === 'all') {
    for (const [path, contents] of dockerFiles(options)) {
      files.set(path, contents);
    }
  }

  if (options.infra === 'kubernetes' || options.infra === 'all') {
    for (const [path, contents] of kubernetesFiles(options)) {
      files.set(path, contents);
    }
  }

  return files;
}

function rootPackage({ name, packageManager }) {
  return {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    packageManager: PACKAGE_MANAGER_VERSIONS[packageManager],
    engines: { node: '>=22 <27' },
    workspaces: ['apps/*', 'packages/*'],
    scripts: {
      'dev:api': 'node --watch apps/api/src/server.mjs',
      'dev:web': 'node --watch apps/web/src/server.mjs',
      'start:api': 'node apps/api/src/server.mjs',
      'start:web': 'node apps/web/src/server.mjs',
      test: 'node --test',
    },
  };
}

function apiPackage({ name, packageManager }) {
  return {
    name: `@${name}/api`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'node --watch src/server.mjs',
      start: 'node src/server.mjs',
    },
    dependencies: {
      [`@${name}/shared`]: workspaceDependencyRange(packageManager),
    },
  };
}

function webPackage({ name, packageManager }) {
  return {
    name: `@${name}/web`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'node --watch src/server.mjs',
      start: 'node src/server.mjs',
    },
    dependencies: {
      [`@${name}/shared`]: workspaceDependencyRange(packageManager),
    },
  };
}

function workspaceDependencyRange(packageManager) {
  return packageManager === 'pnpm' ? 'workspace:*' : '*';
}

function sharedPackage({ name }) {
  return {
    name: `@${name}/shared`,
    version: '0.1.0',
    private: true,
    type: 'module',
    exports: './src/index.mjs',
  };
}

function monoxConfig({ name, packageManager, infra }) {
  return {
    schemaVersion: 1,
    name,
    packageManager,
    workspaces: {
      applications: ['apps/api', 'apps/web'],
      packages: ['packages/shared'],
    },
    infrastructure: {
      preset: infra,
      docker: infra === 'docker' || infra === 'all',
      kubernetes: infra === 'kubernetes' || infra === 'all',
    },
    boundaries: {
      api: ['packages/shared'],
      web: ['packages/shared'],
      shared: [],
    },
  };
}

function apiServer({ name }) {
  return `import { createServer } from 'node:http';
import { createHealthPayload } from '@${name}/shared';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(createHealthPayload('api')));
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, () => {
  console.log(\`API listening on port \${port}\`);
});
`;
}

function webServer({ name }) {
  return `import { createServer } from 'node:http';
import { projectName } from '@${name}/shared';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(\`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>\${projectName}</title>
  </head>
  <body>
    <main>
      <h1>\${projectName}</h1>
      <p>Your MonoX workspace is ready.</p>
    </main>
  </body>
</html>\`);
});

server.listen(port, () => {
  console.log(\`Web app listening on port \${port}\`);
});
`;
}

function sharedModule({ name }) {
  return `export const projectName = '${name}';

export function createHealthPayload(service) {
  if (typeof service !== 'string' || service.length === 0) {
    throw new TypeError('service must be a nonempty string');
  }

  return {
    service,
    status: 'ok',
  };
}
`;
}

function smokeTest() {
  return `import assert from 'node:assert/strict';
import test from 'node:test';
import { createHealthPayload } from '../packages/shared/src/index.mjs';

test('shared health payload has a stable contract', () => {
  assert.deepEqual(createHealthPayload('test'), {
    service: 'test',
    status: 'ok',
  });
});
`;
}

function agentsGuide({ name, infra }) {
  return `# AGENTS.md

## Mission

Keep ${name} small, composable, and safe to change. Prefer reusable modules, explicit boundaries, and simple delivery paths.

## Workspace boundaries

- \`apps/api\` owns HTTP API behavior.
- \`apps/web\` owns browser-facing delivery.
- \`packages/shared\` contains dependency-free contracts and utilities used by more than one app.
- \`infra\` contains ${infra === 'none' ? 'no generated templates in this preset' : `${infra} deployment templates`} and must not contain application business logic.

Apps may depend on shared packages. Shared packages must not import from apps. Keep code DRY only when an abstraction has at least two real consumers.

## Delivery rules

1. Run \`${testCommandForGuide()}\` before delivery.
2. Keep credentials, tokens, and private endpoints outside the repository.
3. Prefer environment variables for runtime configuration.
4. Update \`monox.config.json\` when workspace ownership changes.
5. Keep infrastructure templates generic and review resource limits before production use.
`;
}

function testCommandForGuide() {
  return 'node --test';
}

function projectReadme({ name, packageManager, infra }) {
  const install = `${packageManager} install`;
  const test = `${packageManager} test`;
  const enableCorepack = packageManager === 'npm' ? '' : 'corepack enable\n';
  const lockfile = LOCKFILE_NAMES[packageManager];

  return `# ${name}

A small MonoX workspace with an API, a web app, shared code, CI, and ${infra === 'none' ? 'no generated infrastructure preset' : `${infra} infrastructure templates`}.

## Start

\`\`\`sh
${enableCorepack}${install}
${packageManager} run dev:api
${packageManager} run dev:web
\`\`\`

The API uses port \`3001\` and exposes \`GET /health\`. The web app uses port \`3000\`. Override either port with the \`PORT\` environment variable.

The install creates \`${lockfile}\`. Commit it before pushing because generated CI and Docker builds require frozen or immutable dependency resolution.

## Verify

\`\`\`sh
${test}
\`\`\`

Read \`AGENTS.md\` before changing workspace boundaries or infrastructure.
`;
}

function ciWorkflow({ packageManager }) {
  const enableCorepack = packageManager === 'npm' ? '' : '      - run: corepack enable\n';
  const lockfile = LOCKFILE_NAMES[packageManager];
  const installCommand = {
    yarn: 'yarn install --immutable',
    npm: 'npm ci',
    pnpm: 'pnpm install --frozen-lockfile',
  }[packageManager];

  return `name: CI

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22
${enableCorepack}      - name: Require committed ${lockfile}
        shell: bash
        run: |
          if [[ ! -f "${lockfile}" ]]; then
            echo "Run ${packageManager} install and commit ${lockfile} before enabling CI." >&2
            exit 1
          fi
      - run: ${installCommand}
      - run: ${packageManager} test
`;
}

function dockerFiles({ name, packageManager }) {
  const lockfile = LOCKFILE_NAMES[packageManager];
  const installCommand = {
    npm: 'RUN npm ci',
    yarn: 'RUN corepack enable && yarn install --immutable',
    pnpm: 'RUN corepack enable && pnpm install --frozen-lockfile',
  }[packageManager];

  const base = `FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
WORKDIR /workspace
COPY . .
RUN test -f ${lockfile} || (echo "Missing ${lockfile}; run ${packageManager} install and commit it before building." >&2; exit 1)
${installCommand}
ENV NODE_ENV=production
`;

  return new Map([
    ['.dockerignore', 'node_modules\n.git\n.env\n*.log\ncoverage\n'],
    [
      'infra/docker/api.Dockerfile',
      `${base}ENV PORT=3001
EXPOSE 3001
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/src/server.mjs"]
`,
    ],
    [
      'infra/docker/web.Dockerfile',
      `${base}ENV PORT=3000
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/src/server.mjs"]
`,
    ],
    [
      'infra/docker/compose.yaml',
      `services:
  api:
    build:
      context: ../..
      dockerfile: infra/docker/api.Dockerfile
    ports:
      - "3001:3001"
    init: true
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
  web:
    build:
      context: ../..
      dockerfile: infra/docker/web.Dockerfile
    ports:
      - "3000:3000"
    depends_on:
      - api
    init: true
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
`,
    ],
    [
      'infra/docker/README.md',
      `# Docker

Build and start the ${name} services from the repository root:

\`\`\`sh
docker compose -f infra/docker/compose.yaml up --build
\`\`\`

The templates do not include credentials or production routing.
`,
    ],
  ]);
}

function kubernetesFiles({ name }) {
  const workloads = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}-api
spec:
  replicas: 2
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
      app.kubernetes.io/component: api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${name}
        app.kubernetes.io/component: api
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: api
          image: ${name}-api:0.1.0
          imagePullPolicy: IfNotPresent
          env:
            - name: PORT
              value: "3001"
          ports:
            - name: http
              containerPort: 3001
          readinessProbe:
            httpGet:
              path: /health
              port: http
          livenessProbe:
            httpGet:
              path: /health
              port: http
          startupProbe:
            httpGet:
              path: /health
              port: http
            failureThreshold: 30
            periodSeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}-api
spec:
  selector:
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/component: api
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${name}-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${name}-api
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${name}-api
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
      app.kubernetes.io/component: api
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}-web
spec:
  replicas: 2
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
      app.kubernetes.io/component: web
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${name}
        app.kubernetes.io/component: web
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: web
          image: ${name}-web:0.1.0
          imagePullPolicy: IfNotPresent
          env:
            - name: PORT
              value: "3000"
          ports:
            - name: http
              containerPort: 3000
          readinessProbe:
            httpGet:
              path: /
              port: http
          livenessProbe:
            httpGet:
              path: /
              port: http
          startupProbe:
            httpGet:
              path: /
              port: http
            failureThreshold: 30
            periodSeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}-web
spec:
  selector:
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/component: web
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${name}-web
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${name}-web
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${name}-web
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
      app.kubernetes.io/component: web
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${name}-default
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ${name}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: ${name}
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: ${name}
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
`;

  return new Map([
    ['infra/kubernetes/workloads.yaml', workloads],
    [
      'infra/kubernetes/README.md',
      `# Kubernetes

These baseline workloads expose internal ClusterIP services and include CPU-based autoscaling. Build and publish the ${name} images, then update the image references before applying the manifests.

Review namespaces, policies, limits, observability, and external routing for each environment. No credentials or deployment domains are included.
`,
    ],
  ]);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gitignore() {
  return `node_modules/
.env
.env.*
!.env.example
coverage/
dist/
*.log
.DS_Store
`;
}

function editorConfig() {
  return `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true
`;
}
