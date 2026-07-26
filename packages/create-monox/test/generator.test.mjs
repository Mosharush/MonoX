import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { validateMonoXConfigV2 } from '../../config/src/index.mjs';
import { validateDeploymentSpecV2 } from '../../deploy-schema/src/index.mjs';
import { createKubernetesCloudapter } from '../../cloudapter-kubernetes/src/index.mjs';
import {
  ADDON_IDS,
  ADDON_RECIPES,
  DELIVERY_TARGETS,
  WORKSPACE_RECIPES,
  WORKSPACE_TEMPLATE_IDS,
  catalogManifest,
} from '../src/catalog.mjs';
import {
  createGenerationPlan,
  generateProject,
  parseWorkspaceSelection,
  resolveDestination,
  runCommand,
  validateProjectName,
} from '../src/generator.mjs';
import { workspaceDirectory } from '../src/templates.mjs';
import { expandAddonDependencies } from '../src/addons.mjs';

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'create-monox-test-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('generates v2 package-owned deployment contracts and root-owned target configuration', async () => {
  await withTemporaryDirectory(async (parent) => {
    const destination = join(parent, 'sample-app');
    const result = await generateProject({ name: 'sample-app', directory: destination, git: false });

    assert.equal(result.packageManager, 'yarn');
    assert.equal(result.infra, 'all');
    assert.equal(result.delivery, 'docker:local');
    assert.deepEqual(result.workspaces, [
      { name: 'api', template: 'node-fastify-api' },
      { name: 'web', template: 'react-vite-web' },
      { name: 'shared', template: 'typescript-library' },
    ]);

    for (const path of [
      'AGENTS.md',
      'monox.config.json',
      'monox.lock',
      '.github/workflows/ci.yml',
      'apps/api/src/server.mjs',
      'apps/web/src/main.jsx',
      'packages/shared/src/index.ts',
      'infra/local/docker-compose.yml',
      'infra/kubernetes/workloads.yaml',
    ]) {
      assert.equal((await stat(join(destination, path))).isFile(), true, path);
    }

    const config = JSON.parse(await readFile(join(destination, 'monox.config.json'), 'utf8'));
    assert.equal(
      validateMonoXConfigV2(config).valid,
      true,
      JSON.stringify(validateMonoXConfigV2(config).errors)
    );
    assert.equal(config.schemaVersion, '2');
    assert.equal(Object.hasOwn(config, 'applications'), false);
    assert.deepEqual(config.environments.production.bindings, [
      { target: 'docker-local', selector: { workloads: ['*'] } },
    ]);

    for (const path of ['apps/api/package.json', 'apps/web/package.json']) {
      const manifest = JSON.parse(await readFile(join(destination, path), 'utf8'));
      const validation = validateDeploymentSpecV2(manifest.deployment);
      assert.equal(validation.valid, true, `${path}: ${JSON.stringify(validation.errors)}`);
      assert.equal(Array.isArray(manifest.deployment.runtime.command), true);
    }
    const library = JSON.parse(await readFile(join(destination, 'packages/shared/package.json'), 'utf8'));
    assert.equal(Object.hasOwn(library, 'deployment'), false);

    const workflow = await readFile(join(destination, '.github/workflows/ci.yml'), 'utf8');
    assert.match(workflow, /actions\/checkout@[a-f0-9]{40}/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /node: \[22, 24, 26\]/);
    assert.match(workflow, /verify-monox-lock/);

    const dockerReadme = await readFile(join(destination, 'infra/local/README.md'), 'utf8');
    assert.match(dockerReadme, /^# Local Docker\n/);
    assert.notEqual(dockerReadme.trim(), 'infra/local/README.md');

    const kubernetesGate = await readFile(join(destination, 'infra/kubernetes/workloads.yaml'), 'utf8');
    assert.match(kubernetesGate, /intentionally contains no runnable Kubernetes resources/);
    assert.match(kubernetesGate, /immutable image reference from the build receipt must be resolved first/);
    assert.doesNotMatch(kubernetesGate, /^kind:\s+/m);
    assert.doesNotMatch(kubernetesGate, /^\s*image:\s+/m);
  });
});

test('catalog contains every approved built-in template and checksums all recipe families', () => {
  assert.deepEqual(WORKSPACE_TEMPLATE_IDS, [
    'node-http-api',
    'node-fastify-api',
    'node-express-api',
    'node-nest-api',
    'node-hono-api',
    'node-worker',
    'node-cron',
    'react-vite-web',
    'vue-vite-web',
    'next-web',
    'nuxt-web',
    'sveltekit-web',
    'angular-web',
    'typescript-library',
    'python-fastapi-api',
    'python-django-api',
    'python-worker',
    'python-model',
    'python-library',
    'php-laravel-api',
    'php-library',
    'go-chi-api',
    'go-worker',
    'go-library',
  ]);
  assert.equal(ADDON_IDS.length, 28);
  const catalog = catalogManifest();
  assert.match(catalog.integrity, /^sha256-[A-Za-z0-9+/]{43}=$/);
  const version11Recipes = new Set(['angular-web', 'php-laravel-api', 'react-vite-web', 'vue-vite-web']);
  for (const [id, entry] of Object.entries(catalog.workspaces)) {
    assert.equal(entry.version, version11Recipes.has(id) ? '1.1.0' : '1.0.0');
    assert.match(entry.integrity, /^sha256-/);
  }
  for (const entry of Object.values(catalog.addons)) {
    assert.equal(entry.version, '1.0.0');
    assert.match(entry.integrity, /^sha256-/);
  }
  for (const definition of Object.values(DELIVERY_TARGETS)) {
    assert.deepEqual(Object.keys(definition), ['provider', 'provisioner', 'transport', 'runtime']);
  }
});

test('renders and validates the complete JS, Python, PHP and Go workspace catalog', async () => {
  await withTemporaryDirectory(async (parent) => {
    const workspaces = WORKSPACE_TEMPLATE_IDS.map((template) => ({ name: template, template }));
    const destination = join(parent, 'catalog-app');
    await generateProject({
      name: 'catalog-app',
      directory: destination,
      workspaces,
      infra: 'none',
      git: false,
    });

    const workloads = [];
    for (const selection of workspaces) {
      const manifestPath = join(destination, workspaceDirectory(selection), 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      assert.equal(manifest.private, true, selection.template);
      const definition = WORKSPACE_RECIPES[selection.template];
      if (definition.kind === 'library') {
        assert.equal(Object.hasOwn(manifest, 'deployment'), false, selection.template);
      } else {
        const validation = validateDeploymentSpecV2(manifest.deployment);
        assert.equal(validation.valid, true, `${selection.template}: ${JSON.stringify(validation.errors)}`);
        assert.equal(Object.hasOwn(manifest.deployment.build, 'image'), false, selection.template);
        assert.doesNotMatch(JSON.stringify(manifest.deployment), /example\.invalid/);
        workloads.push({ workspace: workspaceDirectory(selection), deployment: manifest.deployment });
        assert.equal(typeof manifest.scripts.start, 'string', selection.template);
        assert.equal(typeof manifest.scripts.test, 'string', selection.template);
        assert.equal(typeof manifest.scripts.build, 'string', selection.template);
        assert.deepEqual(Object.keys(manifest.deployment.probes).sort(), [
          'liveness',
          'readiness',
          'startup',
        ]);
      }
      if (definition.family === 'javascript')
        assert.notEqual(manifest.scripts.bootstrap, 'go mod tidy', selection.template);
      if (definition.family === 'go') assert.equal(manifest.scripts.bootstrap, 'go mod tidy');
    }

    const nuxtManifest = JSON.parse(await readFile(join(destination, 'apps/nuxt-web/package.json'), 'utf8'));
    assert.equal(nuxtManifest.dependencies.nuxt, '4.5.0');
    assert.equal(nuxtManifest.devDependencies['vue-tsc'], '3.3.8');
    const nuxtTsconfig = JSON.parse(await readFile(join(destination, 'apps/nuxt-web/tsconfig.json'), 'utf8'));
    assert.deepEqual(
      nuxtTsconfig.references.map(({ path }) => path),
      [
        './.nuxt/tsconfig.app.json',
        './.nuxt/tsconfig.server.json',
        './.nuxt/tsconfig.shared.json',
        './.nuxt/tsconfig.node.json',
      ]
    );

    const angularManifest = JSON.parse(
      await readFile(join(destination, 'apps/angular-web/package.json'), 'utf8')
    );
    assert.equal(angularManifest.devDependencies['@angular/build'], '22.0.8');
    assert.equal(Object.hasOwn(angularManifest.devDependencies, '@angular-devkit/build-angular'), false);
    const angular = JSON.parse(await readFile(join(destination, 'apps/angular-web/angular.json'), 'utf8'));
    assert.equal(angular.projects['angular-web'].architect.build.builder, '@angular/build:application');
    const pythonProject = await readFile(join(destination, 'apps/python-fastapi-api/pyproject.toml'), 'utf8');
    assert.match(pythonProject, /^name = "catalog-app-python-fastapi-api"$/m);
    assert.doesNotMatch(pythonProject, /^name = "fastapi"$/m);
    assert.match(pythonProject, /^packages = \["monox_python_fastapi_api"\]$/m);
    const pythonManifest = JSON.parse(
      await readFile(join(destination, 'apps/python-fastapi-api/package.json'), 'utf8')
    );
    assert.equal(pythonManifest.deployment.runtime.command[3], 'monox_python_fastapi_api.main:app');

    const adapter = createKubernetesCloudapter();
    const context = {
      config: { project: { name: 'catalog-app' } },
      environment: 'development',
      target: {
        id: 'catalog-kubernetes',
        provider: 'generic',
        provisioner: 'none',
        transport: 'kubernetes-api',
        runtime: 'kubernetes',
        clusterRef: 'catalog-cluster',
        bindings: { namespace: 'catalog-app', registry: 'ghcr.io/mosharush' },
      },
      workloads,
      sourceDigest: `sha256:${'a'.repeat(64)}`,
    };
    const adapterValidation = await adapter.validate(context);
    assert.equal(adapterValidation.valid, true, JSON.stringify(adapterValidation.errors));
    const plan = await adapter.plan(context);
    assert.equal(plan.workloads.length, workloads.length);
    for (const workload of plan.workloads) {
      assert.equal(workload.deployment.build.image.repository, `ghcr.io/mosharush/${workload.deployment.id}`);
      assert.match(workload.deployment.build.image.tag, /^source-[a-f0-9]{24}$/);
    }
    const rendered = await adapter.render(plan, context);
    assert.equal(rendered.artifacts.length, workloads.length);
    for (const artifact of rendered.artifacts) {
      assert.match(artifact.content, /readOnlyRootFilesystem: true/);
      assert.match(artifact.content, /image: "ghcr\.io\/mosharush\//);
    }

    const goWorker = await readFile(join(destination, 'apps/go-worker/cmd/app/main.go'), 'utf8');
    assert.match(goWorker, /--healthcheck/);
    assert.match(goWorker, /--drain/);
    assert.match(goWorker, /syscall\.Kill\(1, syscall\.SIGTERM\)/);
  });
});

test('static web recipes use the read-only production server safely', async () => {
  await withTemporaryDirectory(async (parent) => {
    const destination = join(parent, 'static-app');
    const recipes = [
      ['react', 'react-vite-web', 'vite'],
      ['vue', 'vue-vite-web', 'vite'],
      ['angular', 'angular-web', 'ng serve'],
    ];
    await generateProject({
      name: 'static-app',
      directory: destination,
      workspaces: recipes.map(([name, template]) => `${name}=${template}`),
      infra: 'docker',
      delivery: 'docker:local',
      git: false,
    });

    for (const [name, _template, developmentCommand] of recipes) {
      const workspace = join(destination, 'apps', name);
      const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
      const dockerfile = await readFile(join(destination, 'infra/docker', `${name}.Dockerfile`), 'utf8');
      assert.equal(manifest.scripts.dev, developmentCommand);
      assert.equal(manifest.scripts.start, 'node scripts/serve-static.mjs');
      assert.deepEqual(manifest.deployment.runtime.command, ['node', 'scripts/serve-static.mjs']);
      assert.match(dockerfile, /CMD \["node","scripts\/serve-static\.mjs"\]/);
      assert.doesNotMatch(
        JSON.stringify({ start: manifest.scripts.start, runtime: manifest.deployment.runtime, dockerfile }),
        /vite preview|ng serve/
      );
      assert.equal((await stat(join(workspace, 'scripts/serve-static.mjs'))).isFile(), true);
    }

    const angularServer = await readFile(join(destination, 'apps/angular/scripts/serve-static.mjs'), 'utf8');
    assert.match(angularServer, /new URL\('\.\.\/dist\/browser\/'/);

    const reactWorkspace = join(destination, 'apps/react');
    const staticRoot = join(reactWorkspace, 'dist');
    await mkdir(join(staticRoot, 'assets'), { recursive: true });
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html><h1>Static app</h1>\n');
    await writeFile(join(staticRoot, 'assets/app.js'), 'console.log("static app");\n');
    const outside = join(reactWorkspace, 'outside.txt');
    const outsideWithoutExtension = join(reactWorkspace, 'outside');
    await writeFile(outside, 'not public\n');
    await writeFile(outsideWithoutExtension, 'also not public\n');
    await symlink(outside, join(staticRoot, 'leak.txt'));

    const serverModule = await import(
      `${pathToFileURL(join(reactWorkspace, 'scripts/serve-static.mjs')).href}?test=${Date.now()}`
    );
    const server = await serverModule.createStaticServer();
    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    try {
      const address = server.address();
      assert.equal(typeof address, 'object');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const index = await fetch(`${baseUrl}/`);
      assert.equal(index.status, 200);
      assert.match(index.headers.get('content-type'), /^text\/html/);
      assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
      assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
      assert.match(await index.text(), /Static app/);

      const head = await fetch(`${baseUrl}/assets/app.js`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.match(head.headers.get('content-type'), /^text\/javascript/);
      assert.equal(await head.text(), '');

      const fallback = await fetch(`${baseUrl}/dashboard/settings`);
      assert.equal(fallback.status, 200);
      assert.match(await fallback.text(), /Static app/);

      assert.equal((await fetch(`${baseUrl}/missing.js`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/leak.txt`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/%2e%2e%2foutside.txt`)).status, 400);
      const extensionlessTraversal = await fetch(`${baseUrl}/%2e%2e%2foutside`);
      assert.equal(extensionlessTraversal.status, 400);
      assert.doesNotMatch(await extensionlessTraversal.text(), /Static app/);

      const post = await fetch(`${baseUrl}/`, { method: 'POST' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET, HEAD');
    } finally {
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    }
  });
});

test('produces byte-identical tracked content and a complete deterministic lock', async () => {
  await withTemporaryDirectory(async (parent) => {
    const common = {
      name: 'deterministic-app',
      workspaces: ['api=node-hono-api', 'worker=python-worker', 'shared=go-library'],
      addons: ['temporal', 'redis'],
      infra: 'docker',
      delivery: 'docker:local',
      git: false,
    };
    const first = await generateProject({ ...common, directory: join(parent, 'first') });
    const second = await generateProject({ ...common, directory: join(parent, 'second') });
    assert.deepEqual(first.fileDigests, second.fileDigests);

    const firstLock = JSON.parse(await readFile(join(parent, 'first', 'monox.lock'), 'utf8'));
    const secondLock = JSON.parse(await readFile(join(parent, 'second', 'monox.lock'), 'utf8'));
    assert.deepEqual(firstLock, secondLock);
    assert.deepEqual(
      firstLock.selection.addons.map(({ id }) => id),
      ['postgresql', 'redis', 'temporal']
    );
    assert.match(firstLock.selection.delivery.integrity, /^sha256-/);
    assert.match(firstLock.selectionIntegrity, /^sha256-/);
  });
});

test('renders secure local add-ons and fails closed for unverified Kubernetes chart metadata', async () => {
  await withTemporaryDirectory(async (parent) => {
    const destination = join(parent, 'addons-app');
    await generateProject({
      name: 'addons-app',
      directory: destination,
      addons: ADDON_IDS,
      infra: 'all',
      git: false,
    });
    const compose = await readFile(join(destination, 'infra/docker/addons.compose.yaml'), 'utf8');
    assert.match(compose, /^services:\n/);
    assert.doesNotMatch(compose, /^name:/m);
    assert.doesNotMatch(compose, /image:\s+\S+:latest(?:\s|$)/i);
    const images = [...compose.matchAll(/^\s+image:\s+(\S+)\s*$/gm)].map((match) => match[1]);
    const composeAddonIds = ADDON_IDS.filter((id) => ADDON_RECIPES[id].compose);
    assert.equal(images.length, composeAddonIds.length);
    for (const image of images) {
      assert.match(image, /:[^@\s]+@sha256:[a-f0-9]{64}$/);
      assert.doesNotMatch(image, /:latest@/i);
    }
    const servicesSection = compose.slice(0, compose.indexOf('\nvolumes:\n'));
    const renderedServiceIds = [...servicesSection.matchAll(/^  ([a-z0-9-]+):$/gm)]
      .map((match) => match[1])
      .sort();
    assert.deepEqual(renderedServiceIds, [...composeAddonIds].sort());
    assert.equal(
      (compose.match(/^    security_opt: \[no-new-privileges:true\]$/gm) ?? []).length,
      composeAddonIds.length
    );
    for (const ports of compose.matchAll(/^    ports: \[(.+)\]$/gm)) {
      for (const mapping of ports[1].matchAll(/"([^"]+)"/g)) {
        assert.match(mapping[1], /^127\.0\.0\.1:/);
      }
    }
    assert.doesNotMatch(compose, /(?:PASSWORD|TOKEN|API_KEY):\s+(?:admin|password|secret|changeme)\b/i);
    for (const environmentName of ['REDIS_PASSWORD', 'NATS_TOKEN', 'TYPESENSE_API_KEY']) {
      assert.doesNotMatch(compose, new RegExp(environmentName));
    }
    for (const [service, secretName, fileName] of [
      ['redis', 'redis_password', 'redis-password'],
      ['nats', 'nats_token', 'nats-token'],
      ['typesense', 'typesense_api_key', 'typesense-api-key'],
    ]) {
      assert.match(compose, new RegExp(`^  ${service}:$`, 'm'));
      assert.match(compose, new RegExp(`^    secrets: \\[${secretName}\\]$`, 'm'));
      assert.match(
        compose,
        new RegExp(`^  ${secretName}:\\n    file: \\.\\.\\/\\.\\.\\/\\.monox\\/secrets\\/${fileName}$`, 'm')
      );
    }
    assert.match(compose, /entrypoint: \[\/bin\/sh, \/opt\/monox\/redis-start\.sh\]/);
    assert.match(compose, /test: \[CMD, \/bin\/sh, \/opt\/monox\/redis-healthcheck\.sh\]/);
    assert.match(compose, /entrypoint: \[\/bin\/sh, \/opt\/monox\/nats-start\.sh\]/);
    assert.match(compose, /entrypoint: \[\/bin\/sh, \/opt\/monox\/typesense-start\.sh\]/);
    assert.match(compose, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?Set POSTGRES_PASSWORD\}/);
    assert.match(compose, /QDRANT__SERVICE__API_KEY: \$\{QDRANT_API_KEY:\?Set QDRANT_API_KEY\}/);
    assert.match(compose, /127\.0\.0\.1:5432:5432/);
    assert.match(compose, /keycloak-data:\/opt\/keycloak\/data/);
    for (const supportFile of [
      'grafana-datasources.yaml',
      'loki.yaml',
      'otel-collector.yaml',
      'prometheus.yaml',
      'tempo.yaml',
    ]) {
      assert.match(compose, new RegExp(`\\.\\.\\/docker\\/${supportFile.replace('.', '\\.')}:`));
    }
    const requiredNames = [
      ...new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]+):\?Set \1\}/g)].map((match) => match[1])),
    ].sort();
    const envExample = await readFile(join(destination, '.env.example'), 'utf8');
    const exampleNames = envExample
      .trim()
      .split('\n')
      .map((line) => {
        assert.match(line, /^[A-Z][A-Z0-9_]+=$/);
        return line.slice(0, -1);
      })
      .sort();
    assert.deepEqual(exampleNames, requiredNames);
    for (const secretName of ['REDIS_PASSWORD', 'NATS_TOKEN', 'TYPESENSE_API_KEY']) {
      assert.equal(exampleNames.includes(secretName), false);
    }

    const rootManifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
    assert.equal(rootManifest.scripts['local:secrets'], 'node scripts/init-local-secrets.mjs');
    const generatedReadme = await readFile(join(destination, 'README.md'), 'utf8');
    const localReadme = await readFile(join(destination, 'infra/local/README.md'), 'utf8');
    assert.match(generatedReadme, /run local:secrets/);
    assert.match(localReadme, /run local:secrets/);
    const initializer = await readFile(join(destination, 'scripts/init-local-secrets.mjs'), 'utf8');
    assert.match(initializer, /randomBytes\(32\)\.toString\('base64url'\)/);
    assert.match(initializer, /open\(path, 'wx', 0o600\)/);
    assert.match(initializer, /metadata\.isSymbolicLink\(\)/);
    assert.match(
      initializer,
      /console\.log\(`Local secret files ready: \$\{created} created, \$\{kept} kept\.`\)/
    );
    await runCommand(process.execPath, ['scripts/init-local-secrets.mjs'], { cwd: destination });
    assert.equal((await stat(join(destination, '.monox/secrets'))).mode & 0o777, 0o700);
    const firstSecretValues = new Map();
    for (const fileName of ['redis-password', 'nats-token', 'typesense-api-key']) {
      const path = join(destination, '.monox/secrets', fileName);
      const value = await readFile(path, 'utf8');
      assert.match(value, /^[A-Za-z0-9_-]{43}\n$/);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      firstSecretValues.set(fileName, value);
    }
    await runCommand(process.execPath, ['scripts/init-local-secrets.mjs'], { cwd: destination });
    for (const [fileName, value] of firstSecretValues) {
      assert.equal(await readFile(join(destination, '.monox/secrets', fileName), 'utf8'), value);
    }
    await chmod(join(destination, '.monox/secrets'), 0o755);
    await runCommand(process.execPath, ['scripts/init-local-secrets.mjs'], { cwd: destination });
    assert.equal((await stat(join(destination, '.monox/secrets'))).mode & 0o777, 0o700);
    const natsSecret = join(destination, '.monox/secrets/nats-token');
    await chmod(natsSecret, 0o644);
    await assert.rejects(
      runCommand(process.execPath, ['scripts/init-local-secrets.mjs'], { cwd: destination }),
      /exit code 1/
    );
    await chmod(natsSecret, 0o600);
    const typesenseSecret = join(destination, '.monox/secrets/typesense-api-key');
    await rm(typesenseSecret);
    await symlink('redis-password', typesenseSecret);
    await assert.rejects(
      runCommand(process.execPath, ['scripts/init-local-secrets.mjs'], { cwd: destination }),
      /exit code 1/
    );

    const gitignore = await readFile(join(destination, '.gitignore'), 'utf8');
    const dockerignore = await readFile(join(destination, '.dockerignore'), 'utf8');
    assert.match(gitignore, /^\.monox\/$/m);
    assert.match(dockerignore, /^\.monox$/m);

    const redisStart = await readFile(join(destination, 'infra/docker/redis-start.sh'), 'utf8');
    const redisHealthcheck = await readFile(join(destination, 'infra/docker/redis-healthcheck.sh'), 'utf8');
    const natsStart = await readFile(join(destination, 'infra/docker/nats-start.sh'), 'utf8');
    const typesenseStart = await readFile(join(destination, 'infra/docker/typesense-start.sh'), 'utf8');
    assert.match(redisStart, /exec redis-server "\$config_file"/);
    assert.match(redisHealthcheck, /redis-cli --askpass ping < "\$secret_file"/);
    assert.match(natsStart, /store_dir: \\"\/data\\"/);
    assert.match(natsStart, /tr -d "\\n" < "\$secret_file"/);
    assert.match(natsStart, /exec \/usr\/local\/bin\/nats-server --config "\$config_file"/);
    assert.match(typesenseStart, /exec \/opt\/typesense-server --config "\$config_file"/);
    for (const script of [redisStart, redisHealthcheck, natsStart, typesenseStart]) {
      assert.doesNotMatch(script, /\$\{(?:REDIS_PASSWORD|NATS_TOKEN|TYPESENSE_API_KEY)/);
    }

    const collector = await readFile(join(destination, 'infra/docker/otel-collector.yaml'), 'utf8');
    assert.match(collector, /otlp\/tempo:/);
    assert.match(collector, /otlphttp\/loki:/);
    assert.match(collector, /endpoint: 0\.0\.0\.0:8889/);
    const prometheus = await readFile(join(destination, 'infra/docker/prometheus.yaml'), 'utf8');
    assert.match(prometheus, /otel-collector:8889/);
    const grafana = await readFile(join(destination, 'infra/docker/grafana-datasources.yaml'), 'utf8');
    for (const datasource of ['http://prometheus:9090', 'http://loki:3100', 'http://tempo:3200']) {
      assert.match(grafana, new RegExp(datasource.replaceAll('/', '\\/')));
    }
    const loki = await readFile(join(destination, 'infra/docker/loki.yaml'), 'utf8');
    assert.match(loki, /path_prefix: \/loki/);
    assert.match(loki, /reporting_enabled: false/);

    const kubernetes = JSON.parse(await readFile(join(destination, 'infra/kubernetes/addons.json'), 'utf8'));
    assert(kubernetes.addons.length > 0);
    for (const addon of kubernetes.addons) {
      assert.equal(addon.install.status, 'unverified');
      assert.match(addon.install.reason, /must be verified before apply/);
    }

    const config = JSON.parse(await readFile(join(destination, 'monox.config.json'), 'utf8'));
    for (const addon of Object.values(config.addons)) {
      assert.deepEqual(addon.environments, ['development', 'preview']);
      assert.equal(addon.mode, 'bundled');
    }
  });
});

test('expands transitive service dependencies for durable and observable local stacks', () => {
  assert.deepEqual(expandAddonDependencies(['temporal']), ['postgresql', 'temporal']);
  assert.deepEqual(expandAddonDependencies(['otel-collector']), [
    'loki',
    'otel-collector',
    'prometheus',
    'tempo',
  ]);
  assert.deepEqual(expandAddonDependencies(['grafana']), [
    'grafana',
    'loki',
    'otel-collector',
    'prometheus',
    'tempo',
  ]);
});

test('rejects development-only add-ons in production and invalid delivery combinations', async () => {
  for (const addon of ['localstack', 'mailpit']) {
    await assert.rejects(
      generateProject({ name: 'production-app', environment: 'production', addons: [addon], dryRun: true }),
      new RegExp(`${addon} is a development-only add-on`)
    );
  }
  await assert.rejects(
    generateProject({
      name: 'static-app',
      workspaces: ['api=node-http-api'],
      delivery: 'static:aws-s3-cloudfront',
      dryRun: true,
    }),
    /Static delivery supports only static workspaces/
  );
  await assert.rejects(
    generateProject({
      name: 'pm-app',
      workspaces: ['web=react-vite-web'],
      delivery: 'pm2:generic-ssh',
      dryRun: true,
    }),
    /PM2 delivery does not serve static/
  );
  await assert.rejects(
    generateProject({ name: 'addon-app', addons: ['keda'], infra: 'docker', dryRun: true }),
    /Kubernetes add-ons require/
  );
  for (const delivery of ['docker:generic-ssh', 'docker:aws-ec2', 'docker:gcp-compute']) {
    await assert.rejects(
      generateProject({ name: 'remote-docker-app', delivery, dryRun: true }),
      /cataloged for 0\.2\.0-alpha\.2 but is not executable in 0\.2\.0-alpha\.1/
    );
  }
  await assert.rejects(
    generateProject({ name: 'production-app', environment: 'production', dryRun: true }),
    /rejects local delivery because no protected CI\/OIDC identity is bound/
  );
  await assert.rejects(
    generateProject({
      name: 'production-app',
      environment: 'production',
      delivery: 'kubernetes:gcp-gke',
      dryRun: true,
    }),
    /digest-pinned workload images/
  );
  await assert.rejects(
    generateProject({
      name: 'production-app',
      environment: 'production',
      delivery: 'kubernetes:gcp-gke',
      addons: ['keda'],
      dryRun: true,
    }),
    /OCI chart coordinate and digest are not verified/
  );
});

test('pins polyglot build images and generates executable root bootstrap commands', async () => {
  await withTemporaryDirectory(async (parent) => {
    const destination = join(parent, 'polyglot-app');
    await generateProject({
      name: 'polyglot-app',
      directory: destination,
      packageManager: 'npm',
      workspaces: [
        'api=node-fastify-api',
        'model=python-model',
        'backend=php-laravel-api',
        'gateway=go-chi-api',
        'worker=go-worker',
      ],
      infra: 'docker',
      git: false,
    });

    const root = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
    assert.match(root.scripts['bootstrap:model'], /bootstrap --workspace @polyglot-app\/model/);
    assert.match(root.scripts['bootstrap:backend'], /bootstrap --workspace @polyglot-app\/backend/);
    assert.match(root.scripts['bootstrap:worker'], /bootstrap --workspace @polyglot-app\/worker/);
    assert.match(root.scripts['bootstrap:toolchains'], /bootstrap:model/);
    assert.match(root.scripts['bootstrap:toolchains'], /bootstrap:backend/);
    assert.match(root.scripts['bootstrap:toolchains'], /bootstrap:worker/);
    const generatedReadme = await readFile(join(destination, 'README.md'), 'utf8');
    assert.match(generatedReadme, /npm@12\.0\.1 run bootstrap:toolchains/);
    assert.match(generatedReadme, /npm@12\.0\.1 run test:workspaces/);
    assert.match(generatedReadme, /npm@12\.0\.1 run build/);

    const workflow = await readFile(join(destination, '.github/workflows/ci.yml'), 'utf8');
    assert.match(workflow, /actions\/setup-go@[a-f0-9]{40}/);
    assert.match(workflow, /shivammathur\/setup-php@[a-f0-9]{40}/);
    assert.match(workflow, /tools: composer:2\.10\.2/);
    assert.doesNotMatch(workflow, /composer:2\.(?:8\.12|9\.8)/);
    assert.match(workflow, /uv python install 3\.13\.9/);
    assert.match(workflow, /bootstrap:toolchains/);

    for (const name of ['model', 'backend', 'gateway', 'worker']) {
      const dockerfile = await readFile(join(destination, `infra/docker/${name}.Dockerfile`), 'utf8');
      for (const from of dockerfile.matchAll(/^FROM\s+(\S+)/gm)) {
        assert.match(from[1], /@sha256:[a-f0-9]{64}$/);
      }
    }
    const phpDockerfile = await readFile(join(destination, 'infra/docker/backend.Dockerfile'), 'utf8');
    assert.match(
      phpDockerfile,
      /FROM composer:2\.10\.2@sha256:5946476338742b200bb9ff88f8be56275ddae4b3949c72305cb0dbf10cfcb760/
    );
    assert.doesNotMatch(phpDockerfile, /composer:2\.(?:8\.12|9\.8)/);
    assert.match(phpDockerfile, /RUN test -f composer\.lock/);
    assert.match(phpDockerfile, /composer install .*--no-scripts/);
    assert.match(phpDockerfile, /RUN php artisan package:discover --ansi/);
    assert.match(phpDockerfile, /VIEW_COMPILED_PATH=\/tmp/);
    const composerManifest = JSON.parse(
      await readFile(join(destination, 'apps/backend/composer.json'), 'utf8')
    );
    assert.equal(composerManifest.description, 'MonoX generated php-laravel-api workspace.');
    assert.equal(composerManifest.type, 'project');
    assert.equal(composerManifest.license, 'proprietary');
    assert.equal(composerManifest.require['laravel/framework'], '^12.0');
    assert.equal(composerManifest.autoload['psr-4']['App\\'], 'app/');
    assert.deepEqual(composerManifest.scripts['post-autoload-dump'], [
      '@php scripts/bootstrap-environment.php',
      'Illuminate\\Foundation\\ComposerScripts::postAutoloadDump',
      '@php artisan package:discover --ansi',
    ]);
    assert.equal(composerManifest.config.lock, true);

    const laravelManifest = JSON.parse(
      await readFile(join(destination, 'apps/backend/package.json'), 'utf8')
    );
    assert.equal(laravelManifest.scripts.start, 'php artisan serve --host=0.0.0.0 --port=8080');
    assert.deepEqual(laravelManifest.deployment.runtime.command, [
      'php',
      'artisan',
      'serve',
      '--host=0.0.0.0',
      '--port=8080',
    ]);
    assert.deepEqual(laravelManifest.deployment.env.secretRefs, [
      { name: 'laravel-app-key', target: 'APP_KEY' },
    ]);
    assert.equal(laravelManifest.deployment.env.values.VIEW_COMPILED_PATH, '/tmp');

    for (const path of [
      'artisan',
      'app/Providers/AppServiceProvider.php',
      'app/Support/ProjectInfo.php',
      'bootstrap/app.php',
      'bootstrap/providers.php',
      'config/app.php',
      'config/logging.php',
      'config/view.php',
      'public/index.php',
      'routes/api.php',
      'routes/console.php',
      'scripts/bootstrap-environment.php',
      'tests/smoke.php',
    ]) {
      assert.equal((await stat(join(destination, 'apps/backend', path))).isFile(), true, path);
    }
    const laravelBootstrap = await readFile(join(destination, 'apps/backend/bootstrap/app.php'), 'utf8');
    assert.match(laravelBootstrap, /Application::configure/);
    assert.doesNotMatch(laravelBootstrap, /health:/);
    assert.match(laravelBootstrap, /apiPrefix: ''/);
    const laravelRoutes = await readFile(join(destination, 'apps/backend/routes/api.php'), 'utf8');
    assert.match(laravelRoutes, /Route::get\('\/health'/);
    assert.match(laravelRoutes, /'status' => 'ok'/);
    const laravelFrontController = await readFile(join(destination, 'apps/backend/public/index.php'), 'utf8');
    assert.match(laravelFrontController, /handleRequest\(Request::capture\(\)\)/);
    const laravelEnvironment = await readFile(join(destination, 'apps/backend/.env.example'), 'utf8');
    assert.match(laravelEnvironment, /^APP_KEY=$/m);
    assert.doesNotMatch(laravelEnvironment, /^APP_KEY=.+$/m);
    assert.match(laravelEnvironment, /^VIEW_COMPILED_PATH=\/tmp$/m);
    const laravelEnvironmentBootstrap = await readFile(
      join(destination, 'apps/backend/scripts/bootstrap-environment.php'),
      'utf8'
    );
    assert.match(laravelEnvironmentBootstrap, /@lstat\(\$environment\)/);
    assert.match(laravelEnvironmentBootstrap, /fopen\(\$path, 'xb'\)/);
    assert.match(laravelEnvironmentBootstrap, /umask\(0077\)/);
    assert.match(laravelEnvironmentBootstrap, /@rename\(\$temporary, \$environment\)/);
    assert.doesNotMatch(laravelEnvironmentBootstrap, /\bcopy\(/);
    assert.doesNotMatch(laravelEnvironmentBootstrap, /file_put_contents\(/);
    assert.doesNotMatch(laravelEnvironmentBootstrap, /chmod\(\$environment/);
    const dockerIgnore = await readFile(join(destination, '.dockerignore'), 'utf8');
    assert.match(dockerIgnore, /^\.env\*$/m);
    assert.match(dockerIgnore, /^\*\*\/\.env\*$/m);
    assert.match(dockerIgnore, /^\*\*\/\.venv$/m);
    assert.match(dockerIgnore, /^\*\*\/vendor$/m);
    const localCompose = await readFile(join(destination, 'infra/local/docker-compose.yml'), 'utf8');
    assert.match(localCompose, /env_file: \[\.\.\/\.\.\/apps\/backend\/\.env\]/);
    assert.doesNotMatch(localCompose, /APP_KEY:/);
    const localDockerReadme = await readFile(join(destination, 'infra/local/README.md'), 'utf8');
    assert.match(localDockerReadme, /npm@12\.0\.1 run bootstrap:toolchains.*docker compose/s);
    await assert.rejects(stat(join(destination, 'apps/backend/src/ProjectInfo.php')), { code: 'ENOENT' });

    const goApiDockerfile = await readFile(join(destination, 'infra/docker/gateway.Dockerfile'), 'utf8');
    assert.match(goApiDockerfile, /RUN test -f go\.sum/);
    assert.match(goApiDockerfile, /GOFLAGS=-mod=readonly go mod download/);
    assert.doesNotMatch(goApiDockerfile, /go mod tidy/);
  });
});

test('dry-run validates and hashes output without touching the destination or running commands', async () => {
  await withTemporaryDirectory(async (parent) => {
    const destination = join(parent, 'not-created');
    let calls = 0;
    const result = await generateProject(
      { name: 'dry-app', directory: destination, dryRun: true, install: true, git: true },
      {
        runCommand: async () => {
          calls += 1;
        },
      }
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.gitInitialized, false);
    assert.equal(result.installed, false);
    assert.equal(calls, 0);
    assert(Object.keys(result.fileDigests).length > 10);
    await assert.rejects(stat(destination), { code: 'ENOENT' });

    const plan = createGenerationPlan({ name: 'dry-app', directory: destination });
    assert.deepEqual(plan.fileDigests, result.fileDigests);
  });
});

test('keeps legacy infra and package-manager flags safe', async () => {
  await withTemporaryDirectory(async (parent) => {
    for (const infra of ['none', 'docker', 'kubernetes', 'all']) {
      const destination = join(parent, infra);
      await generateProject({
        name: `${infra}-app`,
        directory: destination,
        packageManager: 'pnpm',
        infra,
        git: false,
      });
      assert.equal((await stat(join(destination, 'pnpm-workspace.yaml'))).isFile(), true);
      if (infra === 'none') await assert.rejects(stat(join(destination, 'infra')), { code: 'ENOENT' });
      if (infra === 'docker')
        await assert.rejects(stat(join(destination, 'infra/kubernetes')), { code: 'ENOENT' });
      if (infra === 'kubernetes')
        await assert.rejects(stat(join(destination, 'infra/docker')), { code: 'ENOENT' });
    }
  });
});

test('refuses a nonempty destination and validates names and workspace syntax before writing', async () => {
  await withTemporaryDirectory(async (parent) => {
    const destination = join(parent, 'occupied');
    await mkdir(destination);
    await writeFile(join(destination, 'keep.txt'), 'keep me\n');
    await assert.rejects(
      generateProject({ name: 'occupied', directory: destination, git: false }),
      /Destination is not empty/
    );
    assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'keep me\n');
  });

  for (const name of ['../escape', 'Uppercase', '-leading', 'trailing-', 'with space', 'a'.repeat(64)]) {
    assert.throws(() => validateProjectName(name), /Project name must use/);
  }
  assert.deepEqual(parseWorkspaceSelection('api=node-fastify-api'), {
    name: 'api',
    template: 'node-fastify-api',
  });
  assert.throws(() => parseWorkspaceSelection('../api=node-http-api'), /Invalid workspace name/);
  assert.throws(() => parseWorkspaceSelection('api=unknown'), /Workspace template must be one of/);
  assert.equal(resolveDestination({ cwd: '/tmp/work', name: 'safe-project' }), '/tmp/work/safe-project');
});

test('runs Git initialization and the pinned installer only when requested', async () => {
  await withTemporaryDirectory(async (parent) => {
    const calls = [];
    const destination = join(parent, 'command-app');
    const result = await generateProject(
      { name: 'command-app', directory: destination, packageManager: 'npm', infra: 'docker', install: true },
      { runCommand: async (command, args, context) => calls.push({ command, args, cwd: context.cwd }) }
    );
    assert.deepEqual(calls, [
      { command: 'git', args: ['init', '--initial-branch=main'], cwd: destination },
      { command: 'npx', args: ['--yes', 'npm@12.0.1', 'install'], cwd: destination },
    ]);
    assert.equal(result.gitInitialized, true);
    assert.equal(result.installed, true);
  });
});
