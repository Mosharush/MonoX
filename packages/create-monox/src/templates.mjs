import { WORKSPACE_RECIPES, assertWorkspaceTemplate } from './catalog.mjs';

const NODE_RANGE = '>=22.22.2 <23.0.0 || >=24.15.0 <25.0.0 || >=26.0.0 <27.0.0';

export function workspaceDirectory(selection) {
  const definition = assertWorkspaceTemplate(selection.template);
  return `${definition.kind === 'library' ? 'packages' : 'apps'}/${selection.name}`;
}

export function renderWorkspace(selection, project) {
  const definition = assertWorkspaceTemplate(selection.template);
  const directory = workspaceDirectory(selection);
  const files = new Map();
  const add = (path, contents) => files.set(`${directory}/${path}`, contents);

  if (definition.family === 'javascript') renderJavaScript(add, selection, project, definition);
  if (definition.family === 'python') renderPython(add, selection, project, definition);
  if (definition.family === 'php') renderPhp(add, selection, project, definition);
  if (definition.family === 'go') renderGo(add, selection, project, definition);

  add('README.md', workspaceReadme(selection, definition));
  if (definition.family === 'javascript') {
    add(
      'test/generated.test.mjs',
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\n\ntest('generated workspace is wired', () => assert.ok(true));\n"
    );
  }
  return files;
}

function renderJavaScript(add, selection, project, definition) {
  const packageName = `@${project.name}/${selection.name}`;
  const base = {
    name: packageName,
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: NODE_RANGE },
  };

  const deployment = deploymentFor(selection, definition);
  let manifest;

  switch (selection.template) {
    case 'node-http-api':
      manifest = nodeManifest(base, deployment);
      add('src/server.mjs', nodeHttpServer(definition.port));
      break;
    case 'node-fastify-api':
      manifest = nodeManifest(base, deployment, { fastify: '5.10.0' });
      add('src/server.mjs', fastifyServer(definition.port));
      break;
    case 'node-express-api':
      manifest = nodeManifest(base, deployment, { express: '5.2.1' });
      add('src/server.mjs', expressServer(definition.port));
      break;
    case 'node-nest-api':
      manifest = {
        ...base,
        scripts: {
          dev: 'tsx watch src/main.ts',
          build: 'tsc -p tsconfig.json',
          start: 'node dist/main.js',
          test: 'node --test',
        },
        dependencies: {
          '@nestjs/common': '11.1.28',
          '@nestjs/core': '11.1.28',
          '@nestjs/platform-express': '11.1.28',
          'reflect-metadata': '0.2.2',
          rxjs: '7.8.2',
        },
        devDependencies: { '@types/node': '26.1.1', tsx: '4.23.1', typescript: '6.0.3' },
        deployment,
      };
      add('src/main.ts', nestServer(definition.port));
      add(
        'tsconfig.json',
        json(
          typeScriptConfig({
            emitDecoratorMetadata: true,
            experimentalDecorators: true,
            types: ['node'],
            useDefineForClassFields: false,
          })
        )
      );
      break;
    case 'node-hono-api':
      manifest = nodeManifest(base, deployment, { '@hono/node-server': '2.0.11', hono: '4.12.32' });
      add('src/server.mjs', honoServer(definition.port));
      break;
    case 'node-worker':
      manifest = nodeManifest(base, deployment);
      add('src/worker.mjs', nodeWorker());
      manifest.scripts = {
        dev: 'node --watch src/worker.mjs',
        build: 'node --check src/worker.mjs',
        start: 'node src/worker.mjs',
        test: 'node --test',
      };
      break;
    case 'node-cron':
      manifest = nodeManifest(base, deployment);
      add('src/job.mjs', nodeCron());
      manifest.scripts = {
        build: 'node --check src/job.mjs',
        start: 'node src/job.mjs',
        test: 'node --test',
      };
      break;
    case 'react-vite-web':
      manifest = staticJsManifest(base, deployment, {
        dependencies: { react: '19.2.8', 'react-dom': '19.2.8' },
        devDependencies: { '@vitejs/plugin-react': '6.0.4', vite: '8.1.5' },
      });
      add('index.html', htmlEntry('app', '/src/main.jsx'));
      add('src/main.jsx', reactEntry(project.name));
      add('vite.config.mjs', reactViteConfig());
      break;
    case 'vue-vite-web':
      manifest = staticJsManifest(base, deployment, {
        dependencies: { vue: '3.5.40' },
        devDependencies: { '@vitejs/plugin-vue': '6.0.8', vite: '8.1.5' },
      });
      add('index.html', htmlEntry('app', '/src/main.js'));
      add('src/App.vue', vueApp(project.name));
      add(
        'src/main.js',
        "import { createApp } from 'vue';\nimport App from './App.vue';\n\ncreateApp(App).mount('#app');\n"
      );
      add('vite.config.mjs', vueViteConfig());
      break;
    case 'next-web':
      manifest = {
        ...base,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start', test: 'node --test' },
        dependencies: { next: '16.2.12', react: '19.2.8', 'react-dom': '19.2.8' },
        deployment,
      };
      add('app/layout.js', nextLayout(project.name));
      add('app/page.js', nextPage(project.name));
      add('app/health/route.js', "export function GET() { return Response.json({ status: 'ok' }); }\n");
      add('next.config.mjs', "export default { output: 'standalone' };\n");
      break;
    case 'nuxt-web':
      manifest = {
        ...base,
        scripts: {
          dev: 'nuxt dev',
          build: 'nuxt build',
          start: 'node .output/server/index.mjs',
          test: 'nuxt typecheck',
        },
        dependencies: { nuxt: '4.5.0', vue: '3.5.40' },
        devDependencies: { typescript: '6.0.3', 'vue-tsc': '3.3.8' },
        deployment,
      };
      add('app/app.vue', vueApp(project.name));
      add('server/routes/health.get.ts', "export default defineEventHandler(() => ({ status: 'ok' }));\n");
      add('nuxt.config.ts', "export default defineNuxtConfig({ compatibilityDate: '2026-07-01' });\n");
      add('tsconfig.json', json(nuxtTypeScriptConfig()));
      break;
    case 'sveltekit-web':
      manifest = {
        ...base,
        scripts: { dev: 'vite dev', build: 'vite build', start: 'node build', test: 'vite build' },
        devDependencies: {
          '@sveltejs/adapter-node': '5.5.7',
          '@sveltejs/kit': '2.70.1',
          '@sveltejs/vite-plugin-svelte': '7.2.0',
          svelte: '5.56.8',
          vite: '8.1.5',
        },
        deployment,
      };
      add(
        'src/routes/+page.svelte',
        `<svelte:head><title>${project.name}</title></svelte:head>\n<main><h1>${project.name}</h1><p>Generated by MonoX.</p></main>\n`
      );
      add(
        'src/routes/health/+server.js',
        "import { json } from '@sveltejs/kit';\n\nexport function GET() { return json({ status: 'ok' }); }\n"
      );
      add(
        'src/app.html',
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">%sveltekit.head%</head><body data-sveltekit-preload-data="hover"><div style="display: contents">%sveltekit.body%</div></body></html>\n'
      );
      add(
        'svelte.config.js',
        "import adapter from '@sveltejs/adapter-node';\n\nexport default { kit: { adapter: adapter() } };\n"
      );
      add(
        'vite.config.js',
        "import { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({ plugins: [sveltekit()] });\n"
      );
      break;
    case 'angular-web':
      manifest = angularManifest(base, deployment);
      add('angular.json', angularConfig(selection.name));
      add(
        'tsconfig.json',
        json(typeScriptConfig({ experimentalDecorators: true, useDefineForClassFields: false }))
      );
      add(
        'tsconfig.app.json',
        json({
          extends: './tsconfig.json',
          compilerOptions: { outDir: './dist/out-tsc' },
          files: ['src/main.ts'],
        })
      );
      add('src/index.html', htmlEntry('app-root', undefined));
      add('src/main.ts', angularEntry(project.name));
      break;
    case 'typescript-library':
      manifest = {
        ...base,
        exports: './dist/index.js',
        types: './dist/index.d.ts',
        scripts: { build: 'tsc -p tsconfig.json', test: 'node --test' },
        devDependencies: { typescript: '6.0.3' },
      };
      add('src/index.ts', `export const projectName = '${project.name}';\n`);
      add('tsconfig.json', json(typeScriptConfig({ declaration: true })));
      break;
    default:
      throw new Error(`No renderer exists for workspace template: ${selection.template}.`);
  }

  if (['react-vite-web', 'vue-vite-web', 'angular-web'].includes(selection.template)) {
    const outputDirectory = selection.template === 'angular-web' ? 'dist/browser' : 'dist';
    add('scripts/serve-static.mjs', staticServer(outputDirectory, definition.port));
  }
  add('package.json', json(manifest));
}

function renderPython(add, selection, project, definition) {
  const moduleName = pythonModuleName(selection.name);
  const distributionName = `${project.name}-${selection.name}`;
  const deployment = deploymentFor(selection, definition);
  const scripts = pythonScripts(selection.template, moduleName, definition.port);
  add(
    'package.json',
    json({
      name: `@${project.name}/${selection.name}`,
      version: '0.1.0',
      private: true,
      scripts,
      deployment,
    })
  );

  if (selection.template === 'python-django-api') {
    add('pyproject.toml', pythonProject(distributionName, moduleName, ['django==5.2.7']));
    add(`${moduleName}/__init__.py`, '');
    add(`${moduleName}/settings.py`, djangoSettings());
    add(`${moduleName}/urls.py`, djangoUrls());
    add(`${moduleName}/wsgi.py`, djangoWsgi(moduleName));
    add('manage.py', djangoManage(moduleName));
  } else if (selection.template === 'python-fastapi-api' || selection.template === 'python-model') {
    add(
      'pyproject.toml',
      pythonProject(distributionName, moduleName, ['fastapi==0.119.0', 'uvicorn==0.38.0'])
    );
    add(`${moduleName}/__init__.py`, '');
    add(`${moduleName}/main.py`, fastApiModule(selection.template === 'python-model'));
  } else if (selection.template === 'python-worker') {
    add('pyproject.toml', pythonProject(distributionName, moduleName));
    add(`${moduleName}/__init__.py`, '');
    add(`${moduleName}/worker.py`, pythonWorker());
  } else {
    add('pyproject.toml', pythonProject(distributionName, moduleName));
    add(`${moduleName}/__init__.py`, `def project_name() -> str:\n    return '${project.name}'\n`);
  }
  add('tests/test_smoke.py', pythonTest(moduleName, definition.kind));
}

function renderPhp(add, selection, project, definition) {
  const namespace = pascalCase(selection.name);
  const deployment = deploymentFor(selection, definition);
  const library = definition.kind === 'library';
  add(
    'package.json',
    json({
      name: `@${project.name}/${selection.name}`,
      version: '0.1.0',
      private: true,
      scripts: library
        ? {
            bootstrap: 'composer install --no-interaction',
            build: 'composer validate --strict',
            test: 'php tests/smoke.php',
          }
        : {
            bootstrap: 'composer install --no-interaction --no-progress --prefer-dist',
            build: 'composer validate --strict',
            start: 'php artisan serve --host=0.0.0.0 --port=8080',
            test: 'php tests/smoke.php',
          },
      ...(deployment ? { deployment } : {}),
    })
  );
  if (library) {
    add(
      'composer.json',
      json({
        name: `${project.name}/${selection.name}`,
        description: `MonoX generated ${selection.template} workspace.`,
        type: 'library',
        license: 'proprietary',
        require: { php: '^8.4' },
        autoload: { 'psr-4': { [`${namespace}\\`]: 'src/' } },
      })
    );
    add('src/ProjectInfo.php', phpClass(namespace, project.name));
    add('tests/smoke.php', phpTest(namespace));
    return;
  }

  add('composer.json', json(laravelComposerManifest(project, selection)));
  add('.env.example', laravelEnvironment(project.name));
  add('artisan', laravelArtisan());
  add('app/Providers/AppServiceProvider.php', laravelAppServiceProvider());
  add('app/Support/ProjectInfo.php', phpClass('App\\Support', project.name));
  add('bootstrap/app.php', laravelBootstrapApplication());
  add('bootstrap/providers.php', laravelProviders());
  add('bootstrap/cache/.gitignore', directoryKeepFile());
  add('config/app.php', laravelAppConfig(project.name));
  add('config/logging.php', laravelLoggingConfig());
  add('config/view.php', laravelViewConfig());
  add('public/index.php', laravelPublicIndex());
  add('routes/api.php', laravelApiRoutes());
  add('routes/console.php', laravelConsoleRoutes());
  add('scripts/bootstrap-environment.php', laravelEnvironmentBootstrap());
  add('storage/framework/cache/data/.gitignore', directoryKeepFile());
  add('storage/framework/sessions/.gitignore', directoryKeepFile());
  add('storage/framework/views/.gitignore', directoryKeepFile());
  add('storage/logs/.gitignore', directoryKeepFile());
  add('tests/smoke.php', laravelSmokeTest());
}

function renderGo(add, selection, project, definition) {
  const module = `example.invalid/${project.name}/${selection.name}`;
  const deployment = deploymentFor(selection, definition);
  add(
    'package.json',
    json({
      name: `@${project.name}/${selection.name}`,
      version: '0.1.0',
      private: true,
      scripts: {
        bootstrap: 'go mod tidy',
        build: definition.kind === 'library' ? 'go test ./...' : 'go build ./...',
        test: 'go test ./...',
        ...(definition.kind !== 'library' ? { start: 'go run ./cmd/app' } : {}),
      },
      ...(deployment ? { deployment } : {}),
    })
  );
  add(
    'go.mod',
    `module ${module}\n\ngo 1.25\n${selection.template === 'go-chi-api' ? '\nrequire github.com/go-chi/chi/v5 v5.2.3\n' : ''}`
  );
  if (selection.template === 'go-chi-api') add('cmd/app/main.go', goChiServer(definition.port));
  if (selection.template === 'go-worker') add('cmd/app/main.go', goWorker());
  if (selection.template === 'go-library')
    add('project.go', `package ${goPackage(selection.name)}\n\nconst Name = "${project.name}"\n`);
  add('project_test.go', goTest(selection));
}

function deploymentFor(selection, definition) {
  if (definition.kind === 'library') return undefined;
  const isNetworked = ['service', 'model', 'static'].includes(definition.kind);
  const command = runtimeCommand(selection, definition);
  const probes = probeContract(selection, definition);
  const preStopCommand = drainCommand(selection, definition);
  const deployment = {
    schemaVersion: '2',
    enabled: true,
    id: selection.name,
    kind: definition.kind,
    build: buildContract(selection.template),
    runtime: {
      language: definition.language,
      framework: definition.framework,
      command,
      workingDirectory: workspaceDirectory(selection),
      ...(definition.schedule ? { cron: definition.schedule } : {}),
    },
    network: {
      exposure: isNetworked ? 'internal' : 'none',
      ports: isNetworked ? [{ name: 'http', containerPort: definition.port, protocol: 'TCP' }] : [],
    },
    probes,
    env: {
      values: {
        ...(isNetworked ? { PORT: String(definition.port) } : {}),
        ...(selection.template === 'php-laravel-api' ? { VIEW_COMPILED_PATH: '/tmp' } : {}),
      },
      secretRefs:
        selection.template === 'python-django-api'
          ? [{ name: 'django-secret', target: 'DJANGO_SECRET_KEY' }]
          : selection.template === 'php-laravel-api'
            ? [{ name: 'laravel-app-key', target: 'APP_KEY' }]
            : [],
    },
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
      accelerators: [],
    },
    storage: [],
    identity: { serviceAccount: selection.name, automountServiceAccountToken: false },
    telemetry: {
      logs: { enabled: true },
      metrics: { enabled: false },
      traces: { enabled: false },
    },
    lifecycle: {
      terminationGracePeriodSeconds: definition.kind === 'worker' ? 300 : 60,
      preStopCommand,
      drain: {
        enabled: definition.kind === 'worker',
        timeoutSeconds: definition.kind === 'worker' ? 240 : 30,
      },
    },
    scaling: {
      mode: 'none',
      minReplicas: 1,
      maxReplicas: 1,
      metrics: [],
    },
    suspended: false,
    variants: {},
    environments: {},
  };
  return deployment;
}

function buildContract(template) {
  if (['react-vite-web', 'vue-vite-web', 'angular-web'].includes(template)) {
    return { strategy: 'static', script: 'build', context: '.', output: 'dist' };
  }
  if (template === 'next-web')
    return { strategy: 'buildpack', script: 'build', context: '.', output: '.next' };
  if (template === 'nuxt-web')
    return { strategy: 'buildpack', script: 'build', context: '.', output: '.output' };
  if (template === 'sveltekit-web')
    return { strategy: 'buildpack', script: 'build', context: '.', output: 'build' };
  return { strategy: 'buildpack', script: 'build', context: '.' };
}

function probeContract(selection, definition) {
  if (['service', 'model', 'static'].includes(definition.kind)) {
    const path = definition.kind === 'static' ? '/' : '/health';
    return {
      startup: { type: 'http', path, port: 'http' },
      readiness: { type: 'http', path, port: 'http' },
      liveness: { type: 'http', path, port: 'http' },
    };
  }
  const command = healthcheckCommand(selection, definition);
  return {
    startup: { type: 'exec', command },
    readiness: { type: 'exec', command },
    liveness: { type: 'exec', command },
  };
}

function healthcheckCommand(_selection, definition) {
  if (definition.language === 'python') return ['python', '-c', 'raise SystemExit(0)'];
  if (definition.language === 'php') return ['php', '-r', 'exit(0);'];
  if (definition.language === 'go') return ['/app', '--healthcheck'];
  return ['node', '-e', 'process.exit(0)'];
}

function drainCommand(_selection, definition) {
  if (definition.kind !== 'worker') return [];
  if (definition.language === 'python')
    return ['python', '-c', 'import os, signal; os.kill(1, signal.SIGTERM)'];
  if (definition.language === 'go') return ['/app', '--drain'];
  return ['node', '-e', "process.kill(1, 'SIGTERM')"];
}

function runtimeCommand(selection, definition) {
  const template = selection.template;
  const moduleName = pythonModuleName(selection.name);
  if (definition.language === 'python') {
    if (template === 'python-django-api')
      return ['uv', 'run', 'python', 'manage.py', 'runserver', '0.0.0.0:8000'];
    if (template === 'python-fastapi-api' || template === 'python-model') {
      return ['uv', 'run', 'uvicorn', `${moduleName}.main:app`, '--host', '0.0.0.0', '--port', '8000'];
    }
    return ['uv', 'run', 'python', '-m', `${moduleName}.worker`];
  }
  if (template === 'php-laravel-api') return ['php', 'artisan', 'serve', '--host=0.0.0.0', '--port=8080'];
  if (definition.language === 'php') return ['php', '-S', '0.0.0.0:8080', '-t', 'public'];
  if (definition.language === 'go') return ['/app'];
  if (template === 'node-worker') return ['node', 'src/worker.mjs'];
  if (template === 'node-cron') return ['node', 'src/job.mjs'];
  if (template === 'next-web') return ['next', 'start'];
  if (template === 'nuxt-web') return ['node', '.output/server/index.mjs'];
  if (template === 'sveltekit-web') return ['node', 'build'];
  if (['react-vite-web', 'vue-vite-web', 'angular-web'].includes(template))
    return ['node', 'scripts/serve-static.mjs'];
  return template === 'node-nest-api' ? ['node', 'dist/main.js'] : ['node', 'src/server.mjs'];
}

function nodeManifest(base, deployment, dependencies = {}) {
  return {
    ...base,
    scripts: {
      dev: 'node --watch src/server.mjs',
      build: 'node --check src/server.mjs',
      start: 'node src/server.mjs',
      test: 'node --test',
    },
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
    deployment,
  };
}

function staticJsManifest(base, deployment, { dependencies, devDependencies }) {
  return {
    ...base,
    scripts: { dev: 'vite', build: 'vite build', start: 'node scripts/serve-static.mjs', test: 'vite build' },
    dependencies,
    devDependencies,
    deployment,
  };
}

function angularManifest(base, deployment) {
  return {
    ...base,
    scripts: { dev: 'ng serve', build: 'ng build', start: 'node scripts/serve-static.mjs', test: 'ng build' },
    dependencies: {
      '@angular/common': '22.0.8',
      '@angular/compiler': '22.0.8',
      '@angular/core': '22.0.8',
      '@angular/platform-browser': '22.0.8',
      rxjs: '7.8.2',
      tslib: '2.8.1',
      'zone.js': '0.16.2',
    },
    devDependencies: {
      '@angular/build': '22.0.8',
      '@angular/cli': '22.0.8',
      '@angular/compiler-cli': '22.0.8',
      typescript: '6.0.3',
    },
    deployment,
  };
}

function nodeHttpServer(port) {
  return `import { createServer } from 'node:http';

const port = Number.parseInt(process.env.PORT ?? '${port}', 10);
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not_found' }));
});
server.listen(port, '0.0.0.0', () => console.log(\`HTTP API listening on \${port}\`));
`;
}

function staticServer(outputDirectory, port) {
  return `import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../${outputDirectory}/', import.meta.url));
const contentTypes = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
});
const securityHeaders = Object.freeze({
  'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root + sep);
}

async function existingPath(candidate) {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

async function staticFile(root, requestPath) {
  const candidate = resolve(root, requestPath);
  if (!inside(root, candidate)) return undefined;
  let canonical = await existingPath(candidate);
  if (!canonical || !inside(root, canonical)) return undefined;
  let metadata = await stat(canonical);
  if (metadata.isDirectory()) {
    canonical = await existingPath(join(canonical, 'index.html'));
    if (!canonical || !inside(root, canonical)) return undefined;
    metadata = await stat(canonical);
  }
  return metadata.isFile() ? canonical : undefined;
}

function requestPath(url) {
  try {
    const pathname = decodeURIComponent(new URL(url ?? '/', 'http://localhost').pathname);
    const segments = pathname.split('/');
    if (pathname.includes('\\0') || pathname.includes('\\\\') || segments.includes('..')) return undefined;
    return pathname.replace(/^\\/+/, '');
  } catch {
    return undefined;
  }
}

function textResponse(response, method, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    ...securityHeaders,
    'content-type': 'text/plain; charset=utf-8',
    ...extraHeaders,
  });
  response.end(method === 'HEAD' ? undefined : body);
}

export async function createStaticServer({ root = defaultRoot } = {}) {
  const canonicalRoot = await realpath(root);
  const fallback = await staticFile(canonicalRoot, 'index.html');
  if (!fallback) throw new Error('Static output is missing index.html. Run the workspace build first.');

  return createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      textResponse(response, method, 405, 'Method not allowed', { allow: 'GET, HEAD' });
      return;
    }

    const relative = requestPath(request.url);
    if (relative === undefined) {
      textResponse(response, method, 400, 'Bad request');
      return;
    }

    try {
      let file = await staticFile(canonicalRoot, relative);
      if (!file && extname(relative) === '') file = fallback;
      if (!file) {
        textResponse(response, method, 404, 'Not found');
        return;
      }

      const extension = extname(file).toLowerCase();
      response.writeHead(200, {
        ...securityHeaders,
        'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=3600',
        'content-type': contentTypes[extension] ?? 'application/octet-stream',
      });
      if (method === 'HEAD') {
        response.end();
        return;
      }
      const stream = createReadStream(file);
      stream.once('error', () => response.destroy());
      stream.pipe(response);
    } catch {
      textResponse(response, method, 500, 'Internal server error');
    }
  });
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const port = Number.parseInt(process.env.PORT ?? '${port}', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be from 1 to 65535.');
  const server = await createStaticServer();
  server.listen(port, '0.0.0.0', () => console.log('Static server listening on port ' + port));
}
`;
}

function fastifyServer(port) {
  return `import Fastify from 'fastify';

const app = Fastify({ logger: true });
app.get('/health', async () => ({ status: 'ok' }));
await app.listen({ host: '0.0.0.0', port: Number.parseInt(process.env.PORT ?? '${port}', 10) });
`;
}

function expressServer(port) {
  return `import express from 'express';

const app = express();
app.disable('x-powered-by');
app.get('/health', (_request, response) => response.json({ status: 'ok' }));
app.use((_request, response) => response.status(404).json({ error: 'not_found' }));
app.listen(Number.parseInt(process.env.PORT ?? '${port}', 10), '0.0.0.0');
`;
}

function nestServer(port) {
  return `import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

@Controller()
class HealthController {
  @Get('health') health() { return { status: 'ok' }; }
}

@Module({ controllers: [HealthController] })
class AppModule {}

const app = await NestFactory.create(AppModule);
await app.listen(Number.parseInt(process.env.PORT ?? '${port}', 10), '0.0.0.0');
`;
}

function honoServer(port) {
  return `import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();
app.get('/health', (context) => context.json({ status: 'ok' }));
serve({ fetch: app.fetch, hostname: '0.0.0.0', port: Number.parseInt(process.env.PORT ?? '${port}', 10) });
`;
}

function nodeWorker() {
  return `let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });

while (!stopping) {
  console.log(JSON.stringify({ event: 'worker_heartbeat', at: new Date().toISOString() }));
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
`;
}

function nodeCron() {
  return "console.log(JSON.stringify({ event: 'scheduled_job_completed', at: new Date().toISOString() }));\n";
}

function htmlEntry(root = 'app', script = '/src/main.jsx') {
  return `<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MonoX app</title></head><body><${root}></${root}>${script ? `<script type="module" src="${script}"></script>` : ''}</body></html>\n`;
}

function reactEntry(name) {
  return `import React from 'react';\nimport { createRoot } from 'react-dom/client';\n\ncreateRoot(document.getElementById('app')).render(<main><h1>${name}</h1><p>Generated by MonoX.</p></main>);\n`;
}

function reactViteConfig() {
  return "import react from '@vitejs/plugin-react';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({ plugins: [react()] });\n";
}

function vueApp(name) {
  return `<template><main><h1>${name}</h1><p>Generated by MonoX.</p></main></template>\n`;
}

function vueViteConfig() {
  return "import vue from '@vitejs/plugin-vue';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({ plugins: [vue()] });\n";
}

function nextLayout(name) {
  return `export const metadata = { title: '${name}' };\nexport default function Layout({ children }) { return <html lang="en"><body>{children}</body></html>; }\n`;
}

function nextPage(name) {
  return `export default function Page() { return <main><h1>${name}</h1><p>Generated by MonoX.</p></main>; }\n`;
}

function angularConfig(project) {
  return json({
    version: 1,
    projects: {
      [project]: {
        projectType: 'application',
        root: '',
        sourceRoot: 'src',
        architect: {
          build: {
            builder: '@angular/build:application',
            options: {
              outputPath: 'dist',
              index: 'src/index.html',
              browser: 'src/main.ts',
              tsConfig: 'tsconfig.app.json',
            },
          },
          serve: {
            builder: '@angular/build:dev-server',
            configurations: { development: { buildTarget: `${project}:build` } },
            defaultConfiguration: 'development',
          },
        },
      },
    },
  });
}

function nuxtTypeScriptConfig() {
  return {
    files: [],
    references: [
      { path: './.nuxt/tsconfig.app.json' },
      { path: './.nuxt/tsconfig.server.json' },
      { path: './.nuxt/tsconfig.shared.json' },
      { path: './.nuxt/tsconfig.node.json' },
    ],
  };
}

function angularEntry(name) {
  return `import { Component } from '@angular/core';\nimport { bootstrapApplication } from '@angular/platform-browser';\n\n@Component({ selector: 'app-root', standalone: true, template: '<main><h1>${name}</h1><p>Generated by MonoX.</p></main>' })\nclass AppComponent {}\n\nbootstrapApplication(AppComponent).catch(console.error);\n`;
}

function typeScriptConfig(extra = {}) {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      ...extra,
    },
    include: ['src/**/*.ts'],
  };
}

function pythonScripts(template, moduleName, port) {
  const scripts = {
    bootstrap: 'uv sync',
    build: 'uv build',
    test: 'uv run python -m unittest discover -s tests',
  };
  if (template === 'python-django-api') scripts.start = `uv run python manage.py runserver 0.0.0.0:${port}`;
  if (template === 'python-fastapi-api' || template === 'python-model')
    scripts.start = `uv run uvicorn ${moduleName}.main:app --host 0.0.0.0 --port ${port}`;
  if (template === 'python-worker') scripts.start = `uv run python -m ${moduleName}.worker`;
  return scripts;
}

function pythonProject(name, moduleName, dependencies = []) {
  return `[project]\nname = "${name}"\nversion = "0.1.0"\nrequires-python = ">=3.13"\ndependencies = [${dependencies.map((item) => `"${item}"`).join(', ')}]\n\n[build-system]\nrequires = ["hatchling==1.27.0"]\nbuild-backend = "hatchling.build"\n\n[tool.hatch.build.targets.wheel]\npackages = ["${moduleName}"]\n`;
}

function fastApiModule(model) {
  return `from fastapi import FastAPI\n\napp = FastAPI(title="MonoX ${model ? 'model' : 'API'}")\n\n@app.get("/health")\ndef health() -> dict[str, str]:\n    return {"status": "ok"}\n`;
}

function pythonWorker() {
  return 'import signal\nimport time\n\nstopping = False\n\ndef stop(_signal, _frame):\n    global stopping\n    stopping = True\n\nsignal.signal(signal.SIGTERM, stop)\nsignal.signal(signal.SIGINT, stop)\n\nif __name__ == "__main__":\n    while not stopping:\n        print("worker heartbeat", flush=True)\n        time.sleep(1)\n';
}

function pythonTest(moduleName, kind) {
  if (kind === 'library')
    return `import unittest\nfrom ${moduleName} import project_name\n\nclass SmokeTest(unittest.TestCase):\n    def test_name(self):\n        self.assertTrue(project_name())\n`;
  return 'import unittest\n\nclass SmokeTest(unittest.TestCase):\n    def test_truth(self):\n        self.assertTrue(True)\n';
}

function djangoSettings() {
  return "import os\n\nSECRET_KEY = os.environ['DJANGO_SECRET_KEY']\nDEBUG = False\nROOT_URLCONF = __package__ + '.urls'\nALLOWED_HOSTS = ['127.0.0.1', 'localhost']\nMIDDLEWARE = []\nINSTALLED_APPS = []\n";
}

function djangoUrls() {
  return "from django.http import JsonResponse\nfrom django.urls import path\n\ndef health(_request):\n    return JsonResponse({'status': 'ok'})\n\nurlpatterns = [path('health', health)]\n";
}

function djangoWsgi(moduleName) {
  return `import os\nfrom django.core.wsgi import get_wsgi_application\n\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', '${moduleName}.settings')\napplication = get_wsgi_application()\n`;
}

function djangoManage(moduleName) {
  return `#!/usr/bin/env python3\nimport os\nimport sys\nfrom django.core.management import execute_from_command_line\n\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', '${moduleName}.settings')\nexecute_from_command_line(sys.argv)\n`;
}

function pascalCase(value) {
  return value
    .split('-')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

function phpClass(namespace, project) {
  return `<?php\ndeclare(strict_types=1);\nnamespace ${namespace};\n\nfinal class ProjectInfo { public static function name(): string { return '${project}'; } }\n`;
}

function phpTest(namespace) {
  return `<?php\nrequire __DIR__ . '/../vendor/autoload.php';\nassert(${namespace}\\ProjectInfo::name() !== '');\n`;
}

function laravelComposerManifest(project, selection) {
  return {
    $schema: 'https://getcomposer.org/schema.json',
    name: `${project.name}/${selection.name}`,
    description: `MonoX generated ${selection.template} workspace.`,
    type: 'project',
    license: 'proprietary',
    require: { php: '^8.4', 'laravel/framework': '^12.0' },
    autoload: { 'psr-4': { 'App\\': 'app/' } },
    scripts: {
      'post-autoload-dump': [
        '@php scripts/bootstrap-environment.php',
        'Illuminate\\Foundation\\ComposerScripts::postAutoloadDump',
        '@php artisan package:discover --ansi',
      ],
      'pre-package-uninstall': ['Illuminate\\Foundation\\ComposerScripts::prePackageUninstall'],
    },
    extra: { laravel: { 'dont-discover': [] } },
    config: {
      'optimize-autoloader': true,
      'preferred-install': 'dist',
      'sort-packages': true,
      lock: true,
      'allow-plugins': {},
    },
    'minimum-stability': 'stable',
    'prefer-stable': true,
  };
}

function laravelEnvironment(projectName) {
  return `APP_NAME=${projectName}\nAPP_ENV=local\nAPP_KEY=\nAPP_DEBUG=false\nAPP_URL=http://localhost:8080\nLOG_CHANNEL=stderr\nLOG_LEVEL=debug\nVIEW_COMPILED_PATH=/tmp\n`;
}

function laravelArtisan() {
  return `#!/usr/bin/env php
<?php

declare(strict_types=1);

use Illuminate\\Foundation\\Application;
use Symfony\\Component\\Console\\Input\\ArgvInput;

define('LARAVEL_START', microtime(true));

require __DIR__.'/vendor/autoload.php';

/** @var Application $app */
$app = require_once __DIR__.'/bootstrap/app.php';

$status = $app->handleCommand(new ArgvInput());

exit($status);
`;
}

function laravelAppServiceProvider() {
  return `<?php

declare(strict_types=1);

namespace App\\Providers;

use Illuminate\\Support\\ServiceProvider;

final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
    }

    public function boot(): void
    {
    }
}
`;
}

function laravelBootstrapApplication() {
  return `<?php

declare(strict_types=1);

use Illuminate\\Foundation\\Application;
use Illuminate\\Foundation\\Configuration\\Exceptions;
use Illuminate\\Foundation\\Configuration\\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        apiPrefix: '',
    )
    ->withMiddleware(static function (Middleware $middleware): void {
    })
    ->withExceptions(static function (Exceptions $exceptions): void {
    })
    ->create();
`;
}

function laravelProviders() {
  return `<?php

declare(strict_types=1);

use App\\Providers\\AppServiceProvider;

return [
    AppServiceProvider::class,
];
`;
}

function laravelAppConfig(projectName) {
  return `<?php

declare(strict_types=1);

return [
    'name' => env('APP_NAME', '${projectName}'),
    'env' => env('APP_ENV', 'production'),
    'debug' => (bool) env('APP_DEBUG', false),
    'url' => env('APP_URL', 'http://localhost'),
    'timezone' => 'UTC',
    'locale' => env('APP_LOCALE', 'en'),
    'fallback_locale' => env('APP_FALLBACK_LOCALE', 'en'),
    'cipher' => 'AES-256-CBC',
    'key' => env('APP_KEY'),
    'previous_keys' => [
        ...array_filter(explode(',', (string) env('APP_PREVIOUS_KEYS', ''))),
    ],
    'maintenance' => [
        'driver' => env('APP_MAINTENANCE_DRIVER', 'file'),
    ],
];
`;
}

function laravelLoggingConfig() {
  return `<?php

declare(strict_types=1);

use Monolog\\Handler\\NullHandler;
use Monolog\\Handler\\StreamHandler;

return [
    'default' => env('LOG_CHANNEL', 'stderr'),
    'channels' => [
        'stderr' => [
            'driver' => 'monolog',
            'handler' => StreamHandler::class,
            'with' => ['stream' => 'php://stderr'],
            'level' => env('LOG_LEVEL', 'info'),
        ],
        'null' => [
            'driver' => 'monolog',
            'handler' => NullHandler::class,
        ],
        'emergency' => [
            'path' => storage_path('logs/laravel.log'),
        ],
    ],
];
`;
}

function laravelViewConfig() {
  return `<?php

declare(strict_types=1);

return [
    'paths' => [resource_path('views')],
    'compiled' => env('VIEW_COMPILED_PATH', '/tmp'),
];
`;
}

function laravelPublicIndex() {
  return `<?php

declare(strict_types=1);

use Illuminate\\Foundation\\Application;
use Illuminate\\Http\\Request;

define('LARAVEL_START', microtime(true));

if (file_exists($maintenance = __DIR__.'/../storage/framework/maintenance.php')) {
    require $maintenance;
}

require __DIR__.'/../vendor/autoload.php';

/** @var Application $app */
$app = require_once __DIR__.'/../bootstrap/app.php';

$app->handleRequest(Request::capture());
`;
}

function laravelApiRoutes() {
  return `<?php

declare(strict_types=1);

use App\\Support\\ProjectInfo;
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Support\\Facades\\Route;

Route::get('/', static fn (): JsonResponse => response()->json([
    'name' => ProjectInfo::name(),
    'framework' => 'laravel',
]));

Route::get('/health', static fn (): JsonResponse => response()->json([
    'status' => 'ok',
]))->name('health');
`;
}

function laravelConsoleRoutes() {
  return `<?php

declare(strict_types=1);

use Illuminate\\Support\\Facades\\Artisan;

Artisan::command('monox:ready', function (): void {
    $this->info('ready');
})->purpose('Verify that the generated application can boot');
`;
}

function laravelEnvironmentBootstrap() {
  return `<?php

declare(strict_types=1);

$root = dirname(__DIR__);
$example = $root.'/.env.example';
$environment = $root.'/.env';

function monoxFileType(array $metadata): int
{
    return $metadata['mode'] & 0170000;
}

function monoxWriteExclusive(string $path, string $contents): void
{
    $previousUmask = umask(0077);
    try {
        $handle = @fopen($path, 'xb');
    } finally {
        umask($previousUmask);
    }

    if ($handle === false) {
        throw new RuntimeException('Unable to create a protected environment file.');
    }

    try {
        $offset = 0;
        $length = strlen($contents);
        while ($offset < $length) {
            $written = fwrite($handle, substr($contents, $offset));
            if ($written === false || $written === 0) {
                throw new RuntimeException('Unable to write a protected environment file.');
            }
            $offset += $written;
        }
        if (!fflush($handle)) {
            throw new RuntimeException('Unable to flush a protected environment file.');
        }
        if (function_exists('fsync') && !fsync($handle)) {
            throw new RuntimeException('Unable to sync a protected environment file.');
        }
    } catch (Throwable $error) {
        fclose($handle);
        @unlink($path);
        throw $error;
    }

    if (!fclose($handle)) {
        @unlink($path);
        throw new RuntimeException('Unable to close a protected environment file.');
    }

    clearstatcache(true, $path);
    $metadata = @lstat($path);
    if ($metadata === false || monoxFileType($metadata) !== 0100000) {
        @unlink($path);
        throw new RuntimeException('The protected environment path is not a regular file.');
    }
    if (DIRECTORY_SEPARATOR === '/' && ($metadata['mode'] & 0777) !== 0600) {
        @unlink($path);
        throw new RuntimeException('The protected environment file does not have mode 0600.');
    }
}

function monoxProtectEnvironment(string $root, string $environment, string $contents): void
{
    $temporary = null;
    for ($attempt = 0; $attempt < 10; $attempt++) {
        $candidate = $root.'/.env.monox-'.bin2hex(random_bytes(16));
        try {
            monoxWriteExclusive($candidate, $contents);
            $temporary = $candidate;
            break;
        } catch (RuntimeException $error) {
            clearstatcache(true, $candidate);
            if (file_exists($candidate) || is_link($candidate)) {
                continue;
            }
            throw $error;
        }
    }

    if ($temporary === null) {
        throw new RuntimeException('Unable to allocate a protected environment file.');
    }

    try {
        clearstatcache(true, $environment);
        $metadata = @lstat($environment);
        if ($metadata === false || monoxFileType($metadata) !== 0100000) {
            throw new RuntimeException('Refusing to replace a non-regular .env path.');
        }
        if (!@rename($temporary, $environment)) {
            throw new RuntimeException('Unable to atomically protect the local .env file.');
        }
        $temporary = null;
    } finally {
        if ($temporary !== null) {
            @unlink($temporary);
        }
    }
}

function monoxWithApplicationKey(string $contents): string
{
    if (!preg_match('/^APP_KEY=(.*)$/m', $contents, $matches)) {
        throw new RuntimeException('APP_KEY is missing from the local .env file.');
    }
    if (trim($matches[1]) !== '') {
        return $contents;
    }

    $key = 'base64:'.base64_encode(random_bytes(32));
    $updated = preg_replace('/^APP_KEY=.*$/m', 'APP_KEY='.$key, $contents, 1, $count);
    if ($updated === null || $count !== 1) {
        throw new RuntimeException('Unable to prepare APP_KEY for the local .env file.');
    }
    return $updated;
}

$exampleMetadata = @lstat($example);
if ($exampleMetadata === false || monoxFileType($exampleMetadata) !== 0100000) {
    throw new RuntimeException('The .env.example path must be a regular file.');
}
$exampleContents = file_get_contents($example);
if ($exampleContents === false) {
    throw new RuntimeException('Unable to read the .env.example file.');
}

clearstatcache(true, $environment);
$environmentMetadata = @lstat($environment);
if ($environmentMetadata === false) {
    monoxWriteExclusive($environment, monoxWithApplicationKey($exampleContents));
    exit(0);
}
if (monoxFileType($environmentMetadata) !== 0100000) {
    throw new RuntimeException('Refusing to use a non-regular .env path.');
}

$contents = file_get_contents($environment);
if ($contents === false) {
    throw new RuntimeException('Unable to read the local .env file.');
}
$updated = monoxWithApplicationKey($contents);
$needsProtectedMode = DIRECTORY_SEPARATOR === '/' && ($environmentMetadata['mode'] & 0777) !== 0600;
if ($updated !== $contents || $needsProtectedMode) {
    monoxProtectEnvironment($root, $environment, $updated);
}
`;
}

function laravelSmokeTest() {
  return `<?php

declare(strict_types=1);

use App\\Support\\ProjectInfo;
use Illuminate\\Contracts\\Http\\Kernel;
use Illuminate\\Foundation\\Application;
use Illuminate\\Http\\Request;

require __DIR__.'/../vendor/autoload.php';

/** @var Application $app */
$app = require __DIR__.'/../bootstrap/app.php';
/** @var Kernel $kernel */
$kernel = $app->make(Kernel::class);

$root = $kernel->handle(Request::create('/', 'GET', server: ['HTTP_ACCEPT' => 'application/json']));
if ($root->getStatusCode() !== 200 || json_decode($root->getContent(), true)['name'] !== ProjectInfo::name()) {
    throw new RuntimeException('The generated Laravel API route did not boot correctly.');
}
$kernel->terminate(Request::create('/', 'GET'), $root);

$healthRequest = Request::create('/health', 'GET');
$health = $kernel->handle($healthRequest);
if ($health->getStatusCode() !== 200 || json_decode($health->getContent(), true)['status'] !== 'ok') {
    throw new RuntimeException('The generated Laravel health route is not ready.');
}
$kernel->terminate($healthRequest, $health);
`;
}

function directoryKeepFile() {
  return '*\n!.gitignore\n';
}

function goChiServer(port) {
  return `package main\n\nimport (\n  "encoding/json"\n  "net/http"\n  "os"\n  "github.com/go-chi/chi/v5"\n)\n\nfunc main() {\n  router := chi.NewRouter()\n  router.Get("/health", func(writer http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(writer).Encode(map[string]string{"status": "ok"}) })\n  port := os.Getenv("PORT")\n  if port == "" { port = "${port}" }\n  if err := http.ListenAndServe(":"+port, router); err != nil { panic(err) }\n}\n`;
}

function goWorker() {
  return `package main

import (
  "fmt"
  "os"
  "os/signal"
  "syscall"
  "time"
)

func main() {
  if len(os.Args) > 1 && os.Args[1] == "--healthcheck" { return }
  if len(os.Args) > 1 && os.Args[1] == "--drain" {
    _ = syscall.Kill(1, syscall.SIGTERM)
    return
  }
  signals := make(chan os.Signal, 1)
  signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
  ticker := time.NewTicker(time.Second)
  defer ticker.Stop()
  for {
    select {
    case <-signals:
      return
    case <-ticker.C:
      fmt.Println("worker heartbeat")
    }
  }
}
`;
}

function goPackage(name) {
  return name.replaceAll('-', '_');
}

export function pythonModuleName(name) {
  return `monox_${name.replaceAll('-', '_')}`;
}

function goTest(selection) {
  const packageName = selection.template === 'go-library' ? goPackage(selection.name) : 'main';
  return `package ${packageName}\n\nimport "testing"\n\nfunc TestGeneratedWorkspace(t *testing.T) {}\n`;
}

function workspaceReadme(selection, definition) {
  return `# ${selection.name}\n\nGenerated from the versioned \`${selection.template}\` MonoX recipe.\n\n- Language: ${definition.language}\n- Framework: ${definition.framework}\n- Workload kind: ${definition.kind}\n\nThe package manifest is the deployment source of truth for runnable workspaces. Secret values do not belong in the manifest.\n`;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function recipeSummary() {
  return Object.entries(WORKSPACE_RECIPES).map(([id, definition]) => ({ id, ...definition }));
}
