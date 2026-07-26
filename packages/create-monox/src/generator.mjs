import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  expandAddonDependencies,
  localSecretFilesForAddons,
  renderAddonFiles,
  validateAddonsForEnvironment,
} from './addons.mjs';
import {
  ADDON_RECIPES,
  DELIVERY_TARGETS,
  WORKSPACE_RECIPES,
  assertAddon,
  assertDelivery,
  assertWorkspaceTemplate,
  catalogManifest,
  integrityFor,
} from './catalog.mjs';
import { pythonModuleName, renderWorkspace, workspaceDirectory } from './templates.mjs';

export const GENERATOR_VERSION = '0.2.0-alpha.1';
export const PACKAGE_MANAGERS = Object.freeze(['yarn', 'npm', 'pnpm']);
export const INFRA_OPTIONS = Object.freeze(['none', 'docker', 'kubernetes', 'all']);
export const ENVIRONMENTS = Object.freeze(['development', 'preview', 'staging', 'production']);
export const COREPACK_VERSION = '0.35.0';
export const NODE_VERSION_RANGE = '>=22.22.2 <23.0.0 || >=24.15.0 <25.0.0 || >=26.0.0 <27.0.0';
export const PACKAGE_MANAGER_VERSIONS = Object.freeze({
  yarn: 'yarn@4.9.1',
  npm: 'npm@12.0.1',
  pnpm: 'pnpm@10.13.1',
});
export const DEFAULT_WORKSPACES = Object.freeze([
  Object.freeze({ name: 'api', template: 'node-fastify-api' }),
  Object.freeze({ name: 'web', template: 'react-vite-web' }),
  Object.freeze({ name: 'shared', template: 'typescript-library' }),
]);

const LOCKFILE_NAMES = Object.freeze({ yarn: 'yarn.lock', npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml' });
const PROJECT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKSPACE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

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
  if (directory === undefined) return resolve(cwd, name);
  if (typeof directory !== 'string' || directory.trim() === '')
    throw new Error('Directory must be a nonempty path.');
  return isAbsolute(directory) ? resolve(directory) : resolve(cwd, directory);
}

export function parseWorkspaceSelection(value) {
  if (typeof value !== 'string') throw new Error('Workspace must use name=template syntax.');
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1 || value.indexOf('=', separator + 1) !== -1) {
    throw new Error('Workspace must use name=template syntax.');
  }
  const name = value.slice(0, separator);
  const template = value.slice(separator + 1);
  if (!WORKSPACE_NAME_PATTERN.test(name)) throw new Error(`Invalid workspace name: ${name}.`);
  assertWorkspaceTemplate(template);
  return Object.freeze({ name, template });
}

export async function runCommand(command, args, { cwd, env } = {}) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: 'inherit',
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolvePromise();
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      rejectPromise(new Error(`${command} failed with ${reason}.`));
    });
  });
}

export async function generateProject(options, dependencies = {}) {
  const normalized = normalizeOptions(options);
  const destination = resolveDestination(normalized);
  const execute = dependencies.runCommand ?? runCommand;
  const files = createProjectFiles(normalized);

  if (normalized.dryRun) return generationResult(normalized, destination, files, false, false);

  await prepareDestination(destination);
  for (const [relativePath, contents] of files) {
    const outputPath = join(destination, relativePath);
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, contents, { encoding: 'utf8', flag: 'wx' });
  }

  if (normalized.git) await execute('git', ['init', '--initial-branch=main'], { cwd: destination });
  if (normalized.install) {
    const invocation = packageManagerInvocation(normalized.packageManager, ['install']);
    await execute(invocation.command, invocation.args, {
      cwd: destination,
      ...(invocation.env ? { env: invocation.env } : {}),
    });
  }

  return generationResult(normalized, destination, files, normalized.git, normalized.install);
}

export function createGenerationPlan(options) {
  const normalized = normalizeOptions({ ...options, dryRun: true });
  const destination = resolveDestination(normalized);
  const files = createProjectFiles(normalized);
  return generationResult(normalized, destination, files, false, false);
}

function generationResult(options, destination, files, gitInitialized, installed) {
  return Object.freeze({
    name: options.name,
    directory: destination,
    packageManager: options.packageManager,
    infra: options.infra,
    environment: options.environment,
    delivery: options.delivery,
    workspaces: Object.freeze(options.workspaces.map((item) => Object.freeze({ ...item }))),
    addons: Object.freeze([...options.addons]),
    files: Object.freeze([...files.keys()]),
    fileDigests: Object.freeze(
      Object.fromEntries([...files].map(([path, contents]) => [path, integrityFor(contents)]))
    ),
    dryRun: options.dryRun,
    gitInitialized,
    installed,
  });
}

export function packageManagerInvocation(packageManager, args = []) {
  if (!PACKAGE_MANAGERS.includes(packageManager))
    throw new Error(`Package manager must be one of: ${PACKAGE_MANAGERS.join(', ')}.`);
  if (packageManager === 'npm')
    return { command: 'npx', args: ['--yes', PACKAGE_MANAGER_VERSIONS.npm, ...args] };
  return {
    command: 'npx',
    args: ['--yes', `corepack@${COREPACK_VERSION}`, packageManager, ...args],
    ...(packageManager === 'yarn'
      ? { env: { YARN_ENABLE_HARDENED_MODE: '0', YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' } }
      : {}),
  };
}

export function packageManagerShellCommand(packageManager, args = []) {
  const invocation = packageManagerInvocation(packageManager, args);
  return [invocation.command, ...invocation.args].join(' ');
}

export function normalizeOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new Error('Generator options must be an object.');
  const name = validateProjectName(options.name);
  const packageManager = options.packageManager ?? 'yarn';
  if (!PACKAGE_MANAGERS.includes(packageManager))
    throw new Error(`Package manager must be one of: ${PACKAGE_MANAGERS.join(', ')}.`);

  const workspaces = normalizeWorkspaces(options.workspaces);
  const environment = options.environment ?? 'development';
  if (!ENVIRONMENTS.includes(environment))
    throw new Error(`Environment must be one of: ${ENVIRONMENTS.join(', ')}.`);
  const addons = expandAddonDependencies(normalizeAddonIds(options.addons));
  validateAddonsForEnvironment(addons, environment);

  const deliveryWasSelected = options.delivery !== undefined;
  const delivery = options.delivery ?? defaultDelivery(options.infra);
  const deliveryDefinition = assertDelivery(delivery);
  const infra = options.infra ?? (deliveryWasSelected ? infraForDelivery(deliveryDefinition) : 'all');
  if (!INFRA_OPTIONS.includes(infra))
    throw new Error(`Infrastructure must be one of: ${INFRA_OPTIONS.join(', ')}.`);
  validateDeliveryCompatibility({ infra, delivery, deliveryDefinition, workspaces, addons });
  validateProductionGeneration({ environment, deliveryDefinition, workspaces, addons });

  return Object.freeze({
    name,
    cwd: options.cwd ?? process.cwd(),
    directory: options.directory,
    packageManager,
    infra,
    environment,
    delivery,
    deliveryDefinition,
    workspaces,
    addons,
    git: options.git ?? true,
    install: options.install ?? false,
    dryRun: options.dryRun ?? false,
  });
}

function normalizeWorkspaces(input) {
  const values =
    input === undefined
      ? DEFAULT_WORKSPACES
      : !Array.isArray(input) && input && typeof input === 'object'
        ? Object.entries(input).map(([name, template]) => ({ name, template }))
        : input;
  if (!Array.isArray(values) || values.length === 0) throw new Error('At least one workspace is required.');
  const seen = new Set();
  return Object.freeze(
    values.map((value) => {
      const selection =
        typeof value === 'string' ? parseWorkspaceSelection(value) : normalizeWorkspaceObject(value);
      if (seen.has(selection.name)) throw new Error(`Workspace names must be unique: ${selection.name}.`);
      seen.add(selection.name);
      return selection;
    })
  );
}

function normalizeWorkspaceObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Workspace entries must be name=template strings or objects.');
  return parseWorkspaceSelection(`${value.name ?? ''}=${value.template ?? ''}`);
}

function normalizeAddonIds(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('Add-ons must be an array.');
  const unique = [];
  const seen = new Set();
  for (const id of input) {
    if (typeof id !== 'string') throw new Error('Add-on IDs must be strings.');
    assertAddon(id);
    if (!seen.has(id)) unique.push(id);
    seen.add(id);
  }
  return unique;
}

function defaultDelivery(infra) {
  if (infra === 'kubernetes') return 'kubernetes:existing-kubernetes';
  return 'docker:local';
}

function infraForDelivery(delivery) {
  if (delivery.runtime === 'kubernetes') return 'kubernetes';
  if (delivery.runtime === 'docker' || delivery.runtime === 'coolify') return 'docker';
  return 'none';
}

function validateDeliveryCompatibility({ infra, delivery, deliveryDefinition, workspaces, addons }) {
  if (deliveryDefinition.runtime === 'docker' && deliveryDefinition.transport !== 'local') {
    throw new Error(
      `Delivery ${delivery} is cataloged for 0.2.0-alpha.2 but is not executable in 0.2.0-alpha.1. ` +
        'Use docker:local, or select PM2, Coolify or Kubernetes with an explicitly configured adapter.'
    );
  }
  if (deliveryDefinition.runtime === 'kubernetes' && !['kubernetes', 'all'].includes(infra)) {
    throw new Error(`Delivery ${delivery} requires kubernetes or all infrastructure.`);
  }
  if (deliveryDefinition.runtime === 'docker' && !['none', 'docker', 'all'].includes(infra)) {
    throw new Error(`Delivery ${delivery} requires docker or all infrastructure.`);
  }
  const hasKubernetesAddon = addons.some((id) => ADDON_RECIPES[id].kubernetes);
  if (hasKubernetesAddon && !['kubernetes', 'all'].includes(infra)) {
    throw new Error('Kubernetes add-ons require kubernetes or all infrastructure.');
  }
  const deployableKinds = workspaces
    .map((item) => WORKSPACE_RECIPES[item.template].kind)
    .filter((kind) => kind !== 'library');
  if (deliveryDefinition.runtime === 'static' && deployableKinds.some((kind) => kind !== 'static')) {
    throw new Error('Static delivery supports only static workspaces.');
  }
  if (deliveryDefinition.runtime === 'pm2' && deployableKinds.includes('static')) {
    throw new Error(
      'PM2 delivery does not serve static workspace artifacts; select docker, coolify, kubernetes, or static delivery.'
    );
  }
}

function validateProductionGeneration({ environment, deliveryDefinition, workspaces, addons }) {
  if (environment !== 'production') return;

  const unverifiedAddon = addons.find(
    (id) => ADDON_RECIPES[id].kubernetes && ADDON_RECIPES[id].install?.status !== 'verified'
  );
  if (unverifiedAddon) {
    throw new Error(
      `Production generation rejects ${unverifiedAddon}: its OCI chart coordinate and digest are not verified.`
    );
  }
  if (deliveryDefinition.transport === 'local') {
    throw new Error(
      'Production generation rejects local delivery because no protected CI/OIDC identity is bound.'
    );
  }
  if (workspaces.some((item) => WORKSPACE_RECIPES[item.template].kind !== 'library')) {
    throw new Error(
      'Production generation requires target-derived, digest-pinned workload images and a protected CI/OIDC identity. Use staging as the generator default, then bind verified production artifacts during planning.'
    );
  }
}

async function prepareDestination(destination) {
  let entry;
  try {
    entry = await lstat(destination);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (entry) {
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error(`Destination is not a directory: ${destination}`);
    if ((await readdir(destination)).length > 0) throw new Error(`Destination is not empty: ${destination}`);
  } else {
    await mkdir(destination, { recursive: true });
  }
}

function createProjectFiles(options) {
  const files = new Map([
    ['package.json', json(rootPackage(options))],
    ['monox.config.json', json(monoxConfig(options))],
    ['monox.lock', json(monoxLock(options))],
    ['AGENTS.md', agentsGuide(options)],
    ['README.md', projectReadme(options)],
    ['.gitignore', gitignore()],
    ['.editorconfig', editorConfig()],
    ['.github/workflows/ci.yml', ciWorkflow(options)],
    ['scripts/verify-monox-lock.mjs', lockVerifier()],
    ['test/generated.test.mjs', smokeTest(options)],
  ]);

  for (const selection of options.workspaces) {
    for (const [path, contents] of renderWorkspace(selection, options)) files.set(path, contents);
  }
  for (const [path, contents] of renderAddonFiles(options.addons)) files.set(path, contents);
  if (options.workspaces.some((workspace) => workspace.template === 'python-django-api')) {
    files.set('.env.example', `${files.get('.env.example') ?? ''}DJANGO_SECRET_KEY=\n`);
  }
  if (options.packageManager === 'pnpm')
    files.set('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  if (options.packageManager === 'yarn') files.set('.yarnrc.yml', 'nodeLinker: node-modules\n');
  if (options.infra === 'docker' || options.infra === 'all') {
    for (const [path, contents] of dockerFiles(options)) files.set(path, contents);
  }
  if (options.infra === 'kubernetes' || options.infra === 'all') {
    for (const [path, contents] of kubernetesFiles(options)) files.set(path, contents);
  }
  return files;
}

function rootPackage(options) {
  const scripts = {
    test: 'node --test test/generated.test.mjs',
    'catalog:verify': 'node scripts/verify-monox-lock.mjs',
  };
  if (localSecretFilesForAddons(options.addons).length > 0) {
    scripts['local:secrets'] = 'node scripts/init-local-secrets.mjs';
  }
  const buildScripts = [];
  const testScripts = [];
  const bootstrapScripts = [];
  for (const workspace of options.workspaces) {
    const definition = WORKSPACE_RECIPES[workspace.template];
    if (definition.kind !== 'library')
      scripts[`start:${workspace.name}`] = workspaceScript(options, workspace.name, 'start');
    scripts[`test:${workspace.name}`] = workspaceScript(options, workspace.name, 'test');
    if (
      definition.family === 'javascript' ||
      definition.language === 'go' ||
      definition.language === 'python' ||
      definition.language === 'php'
    ) {
      scripts[`build:${workspace.name}`] = workspaceScript(options, workspace.name, 'build');
      buildScripts.push(
        packageManagerShellCommand(options.packageManager, ['run', `build:${workspace.name}`])
      );
    }
    testScripts.push(packageManagerShellCommand(options.packageManager, ['run', `test:${workspace.name}`]));
    if (definition.family !== 'javascript') {
      scripts[`bootstrap:${workspace.name}`] = workspaceScript(options, workspace.name, 'bootstrap');
      bootstrapScripts.push(
        packageManagerShellCommand(options.packageManager, ['run', `bootstrap:${workspace.name}`])
      );
    }
  }
  scripts.build = buildScripts.join(' && ');
  scripts['test:workspaces'] = testScripts.join(' && ');
  if (bootstrapScripts.length > 0) scripts['bootstrap:toolchains'] = bootstrapScripts.join(' && ');
  return {
    name: options.name,
    version: '0.1.0',
    private: true,
    type: 'module',
    packageManager: PACKAGE_MANAGER_VERSIONS[options.packageManager],
    engines: { node: NODE_VERSION_RANGE },
    workspaces: ['apps/*', 'packages/*'],
    scripts,
  };
}

function workspaceScript(options, workspace, script) {
  const name = `@${options.name}/${workspace}`;
  if (options.packageManager === 'npm') {
    return packageManagerShellCommand('npm', ['run', script, '--workspace', name]);
  }
  if (options.packageManager === 'pnpm') {
    return packageManagerShellCommand('pnpm', ['--filter', name, 'run', script]);
  }
  return packageManagerShellCommand('yarn', ['workspace', name, 'run', script]);
}

function monoxConfig(options) {
  const targetId = targetIdFor(options.delivery);
  return {
    schemaVersion: '2',
    project: {
      name: options.name,
      workspaceGlobs: ['apps/*', 'packages/*'],
      defaultEnvironment: options.environment,
    },
    boundaries: {
      apps: ['packages'],
      packages: ['packages'],
      infra: ['packages'],
    },
    workloadProfiles: {},
    environments: {
      development: {
        production: false,
        bindings: [{ target: targetId, selector: { workloads: ['*'] } }],
      },
      preview: {
        production: false,
        bindings: [{ target: targetId, selector: { workloads: ['*'] } }],
      },
      staging: {
        production: false,
        bindings: [{ target: targetId, selector: { workloads: ['*'] } }],
      },
      production: {
        production: true,
        protected: true,
        bindings: [{ target: targetId, selector: { workloads: ['*'] } }],
      },
    },
    targets: {
      [targetId]: { ...options.deliveryDefinition },
    },
    addons: Object.fromEntries(
      options.addons.map((id) => [
        id,
        {
          recipe: id,
          enabled: true,
          mode: 'bundled',
          environments: ['development', 'preview'],
          config: {},
          secretRefs: [],
        },
      ])
    ),
  };
}

function targetIdFor(delivery) {
  return delivery.replace(':', '-').replaceAll(/[^a-z0-9-]/g, '-');
}

function monoxLock(options) {
  const catalog = catalogManifest();
  const selection = {
    workspaces: options.workspaces.map(({ name, template }) => ({
      name,
      template,
      ...catalog.workspaces[template],
    })),
    addons: options.addons.map((id) => ({ id, ...catalog.addons[id] })),
    delivery: {
      id: options.delivery,
      integrity: integrityFor({ id: options.delivery, ...DELIVERY_TARGETS[options.delivery] }),
    },
  };
  return {
    lockfileVersion: 1,
    generator: { name: 'create-monox', version: GENERATOR_VERSION },
    catalog: { version: catalog.version, integrity: catalog.integrity },
    selection,
    selectionIntegrity: integrityFor(selection),
  };
}

function projectReadme(options) {
  const install = packageManagerShellCommand(options.packageManager, ['install']);
  const localSecrets =
    localSecretFilesForAddons(options.addons).length > 0
      ? `${packageManagerShellCommand(options.packageManager, ['run', 'local:secrets'])}\n`
      : '';
  const bootstrap = options.workspaces.some(
    (workspace) => WORKSPACE_RECIPES[workspace.template].family !== 'javascript'
  )
    ? `${packageManagerShellCommand(options.packageManager, ['run', 'bootstrap:toolchains'])}\n`
    : '';
  const starts = options.workspaces
    .filter((workspace) => WORKSPACE_RECIPES[workspace.template].kind !== 'library')
    .map((workspace) =>
      packageManagerShellCommand(options.packageManager, ['run', `start:${workspace.name}`])
    );
  return `# ${options.name}\n\nGenerated by MonoX from bundled, versioned recipes. The project contains ${options.workspaces.length} workspace(s), ${options.addons.length} add-on(s), CI, explicit agent boundaries and a \`${options.delivery}\` delivery contract.\n\n## Start\n\n\`\`\`sh\n${install}\n${localSecrets}${bootstrap}${starts.join('\n')}\n\`\`\`\n\nRun one start command per terminal. Polyglot workspaces require the tool named in their local README. The bootstrap command creates their \`uv.lock\`, \`composer.lock\` or \`go.sum\` state before container builds.${localSecrets ? ' The local secrets command creates ignored, random files without replacing existing values.' : ''}\n\n## Verify\n\n\`\`\`sh\n${packageManagerShellCommand(options.packageManager, ['run', 'catalog:verify'])}\n${packageManagerShellCommand(options.packageManager, ['test'])}\n${packageManagerShellCommand(options.packageManager, ['run', 'test:workspaces'])}\n${packageManagerShellCommand(options.packageManager, ['run', 'build'])}\n\`\`\`\n\n\`package.json.deployment\` is the source of truth for every runnable workspace. \`monox.config.json\` owns project boundaries, environments, targets and add-ons; it does not duplicate an application list.\n\nDo not commit \`.env\`, \`.monox\`, credentials, provider account identifiers or private endpoints.\n`;
}

function agentsGuide(options) {
  const rows = options.workspaces
    .map((workspace) => `- \`${workspaceDirectory(workspace)}\`: \`${workspace.template}\`.`)
    .join('\n');
  return `# AGENTS.md\n\n## Mission\n\nKeep ${options.name} composable, deterministic and safe to deliver. Prefer explicit contracts over hidden conventions.\n\n## Workspace map\n\n${rows}\n\nApps may depend on packages. Packages must never import from apps. Update a runnable workspace's \`package.json.deployment\` when its runtime contract changes. Root config owns targets and boundaries only.\n\n## Required checks\n\n1. Run \`node --test\`.\n2. Run \`node scripts/verify-monox-lock.mjs\`.\n3. Never place credentials in manifests, command arguments, logs or fixtures.\n4. Review generated infrastructure before production use.\n`;
}

function ciWorkflow(options) {
  const lockfile = LOCKFILE_NAMES[options.packageManager];
  const install = {
    yarn: packageManagerShellCommand('yarn', ['install', '--immutable']),
    npm: packageManagerShellCommand('npm', ['ci']),
    pnpm: packageManagerShellCommand('pnpm', ['install', '--frozen-lockfile']),
  }[options.packageManager];
  const hasPython = options.workspaces.some(
    (workspace) => WORKSPACE_RECIPES[workspace.template].family === 'python'
  );
  const hasGo = options.workspaces.some((workspace) => WORKSPACE_RECIPES[workspace.template].family === 'go');
  const hasPhp = options.workspaces.some(
    (workspace) => WORKSPACE_RECIPES[workspace.template].family === 'php'
  );
  const hasPolyglot = options.workspaces.some(
    (workspace) => WORKSPACE_RECIPES[workspace.template].family !== 'javascript'
  );
  const goSetup = hasGo
    ? '      - uses: actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16 # v6.5.0\n        with:\n          go-version: 1.25.3\n          cache: false\n'
    : '';
  const phpSetup = hasPhp
    ? "      - uses: shivammathur/setup-php@f3e473d116dcccaddc5834248c87452386958240 # 2.37.2\n        with:\n          php-version: '8.4'\n          tools: composer:2.10.2\n          coverage: none\n"
    : '';
  const pythonSetup = hasPython
    ? '      - run: python3 -m pip install --disable-pip-version-check uv==0.9.7\n      - run: uv python install 3.13.9\n'
    : '';
  const bootstrap = hasPolyglot
    ? `      - run: ${packageManagerShellCommand(options.packageManager, ['run', 'bootstrap:toolchains'])}\n`
    : '';
  return `name: CI\n\non:\n  pull_request:\n  push:\n    branches: [main]\n\npermissions:\n  contents: read\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      fail-fast: false\n      matrix:\n        node: [22, 24, 26]\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version: \${{ matrix.node }}\n      - name: Require committed ${lockfile}\n        run: test -f ${lockfile}\n${goSetup}${phpSetup}      - run: ${install}\n${pythonSetup}${bootstrap}      - run: node scripts/verify-monox-lock.mjs\n      - run: ${packageManagerShellCommand(options.packageManager, ['test'])}\n      - run: ${packageManagerShellCommand(options.packageManager, ['run', 'test:workspaces'])}\n      - run: ${packageManagerShellCommand(options.packageManager, ['run', 'build'])}\n`;
}

function lockVerifier() {
  return `import assert from 'node:assert/strict';\nimport { createHash } from 'node:crypto';\nimport { readFile } from 'node:fs/promises';\n\nfunction canonical(value) {\n  if (Array.isArray(value)) return \`[\${value.map(canonical).join(',')}]\`;\n  if (value && typeof value === 'object') return \`{\${Object.keys(value).sort().map((key) => \`\${JSON.stringify(key)}:\${canonical(value[key])}\`).join(',')}}\`;\n  return JSON.stringify(value);\n}\nconst lock = JSON.parse(await readFile(new URL('../monox.lock', import.meta.url), 'utf8'));\nconst actual = \`sha256-\${createHash('sha256').update(canonical(lock.selection)).digest('base64')}\`;\nassert.equal(lock.lockfileVersion, 1);\nassert.equal(actual, lock.selectionIntegrity, 'monox.lock selection was changed without regeneration');\nconsole.log('MonoX lock verified');\n`;
}

function smokeTest(options) {
  const expected = options.workspaces.map((item) => workspaceDirectory(item));
  return `import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport test from 'node:test';\n\ntest('generated workspaces have deterministic package manifests', async () => {\n  const paths = ${JSON.stringify(expected)};\n  for (const path of paths) {\n    const manifest = JSON.parse(await readFile(new URL(\`../\${path}/package.json\`, import.meta.url), 'utf8'));\n    assert.equal(manifest.private, true);\n    if (manifest.deployment) assert.equal(manifest.deployment.schemaVersion, '2');\n  }\n});\n`;
}

function dockerFiles(options) {
  const localSecretsCommand =
    localSecretFilesForAddons(options.addons).length > 0
      ? `\nBefore the first start, create the ignored file-backed add-on credentials:\n\n\`\`\`sh\n${packageManagerShellCommand(options.packageManager, ['run', 'local:secrets'])}\n\`\`\`\n`
      : '';
  const services = options.workspaces
    .filter((workspace) => WORKSPACE_RECIPES[workspace.template].kind !== 'library')
    .map((workspace) => {
      const definition = WORKSPACE_RECIPES[workspace.template];
      const port = definition.port;
      const environment =
        workspace.template === 'python-django-api'
          ? '    environment:\n      DJANGO_SECRET_KEY: ${DJANGO_SECRET_KEY:?Set DJANGO_SECRET_KEY}\n'
          : workspace.template === 'php-laravel-api'
            ? `    env_file: [../../${workspaceDirectory(workspace)}/.env]\n`
            : '';
      return `  ${workspace.name}:\n    build:\n      context: ../..\n      dockerfile: infra/docker/${workspace.name}.Dockerfile\n    init: true\n    read_only: true\n    tmpfs: [/tmp]\n    cap_drop: [ALL]\n    security_opt: [no-new-privileges:true]\n${environment}${port ? `    ports: ["127.0.0.1:${port}:${port}"]\n` : ''}`;
    })
    .join('');
  const files = new Map([
    [
      '.dockerignore',
      'node_modules\n**/node_modules\n.git\n.env*\n**/.env*\n.monox\n**/.venv\n**/vendor\n*.log\ncoverage\n**/coverage\ndist\n**/dist\n',
    ],
    ['infra/local/docker-compose.yml', `name: ${options.name}\nservices:\n${services}`],
    [
      'infra/local/README.md',
      `# Local Docker\n${localSecretsCommand}\n${options.workspaces.some((workspace) => WORKSPACE_RECIPES[workspace.template].family !== 'javascript') ? `Run \`${packageManagerShellCommand(options.packageManager, ['run', 'bootstrap:toolchains'])}\` first so generated lockfiles and ignored local environment files exist. ` : ''}Run \`docker compose -f infra/local/docker-compose.yml up --build\`. Generated add-ons live in \`infra/docker/addons.compose.yaml\` and can be included with a second \`-f\` flag. All published ports bind to loopback by default.\n`,
    ],
  ]);
  for (const workspace of options.workspaces) {
    if (WORKSPACE_RECIPES[workspace.template].kind === 'library') continue;
    files.set(`infra/docker/${workspace.name}.Dockerfile`, dockerfileFor(options, workspace));
  }
  return files;
}

function dockerfileFor(options, workspace) {
  const definition = WORKSPACE_RECIPES[workspace.template];
  const directory = workspaceDirectory(workspace);
  const command = deploymentCommand(workspace, definition);
  if (definition.family === 'python') {
    return `FROM python:3.13.9-slim-bookworm@sha256:b685a4fa58bb19d1814d78a1ec0f0208f351452724f78b20212c984d6e124a34\nWORKDIR /workspace\nRUN pip install --no-cache-dir uv==0.9.7\nCOPY ${directory} .\nRUN uv sync\nUSER 10001:10001\nCMD ${JSON.stringify(command)}\n`;
  }
  if (definition.family === 'php') {
    const laravelBootstrap =
      workspace.template === 'php-laravel-api' ? 'RUN php artisan package:discover --ansi\n' : '';
    const laravelRuntime =
      workspace.template === 'php-laravel-api'
        ? 'ENV APP_ENV=production APP_DEBUG=false LOG_CHANNEL=stderr VIEW_COMPILED_PATH=/tmp\n'
        : '';
    return `FROM composer:2.10.2@sha256:5946476338742b200bb9ff88f8be56275ddae4b3949c72305cb0dbf10cfcb760 AS dependencies\nWORKDIR /workspace\nCOPY ${directory} .\nRUN test -f composer.lock\nRUN composer install --no-dev --no-interaction --classmap-authoritative --no-scripts\n${laravelBootstrap}FROM php:8.4.13-cli-bookworm@sha256:e61b50da049acc7b991e3dedac62523924a363c4d7ffae508b8a2d082686861c\nWORKDIR /workspace\nCOPY --from=dependencies /workspace .\n${laravelRuntime}USER 10001:10001\nCMD ${JSON.stringify(command)}\n`;
  }
  if (definition.family === 'go') {
    const checksumGate = workspace.template === 'go-chi-api' ? 'RUN test -f go.sum\n' : '';
    return `FROM golang:1.25.3-bookworm@sha256:4f43b271f9673eb7bd0cb3a49cc17b08d8d6ee110277e26dbacc93c43a5a7793 AS build\nWORKDIR /src\nCOPY ${directory} .\n${checksumGate}RUN GOFLAGS=-mod=readonly go mod download\nRUN CGO_ENABLED=0 go build -mod=readonly -o /out/app ./cmd/app\nFROM gcr.io/distroless/static-debian12:nonroot@sha256:f5b485ea962d9bd1186b2f6b3a061191539b905b82ec395de78cbfae51f20e35\nCOPY --from=build /out/app /app\nENTRYPOINT ["/app"]\n`;
  }
  const lockfile = LOCKFILE_NAMES[options.packageManager];
  const install =
    options.packageManager === 'npm'
      ? packageManagerShellCommand('npm', ['ci'])
      : packageManagerShellCommand(options.packageManager, [
          'install',
          options.packageManager === 'yarn' ? '--immutable' : '--frozen-lockfile',
        ]);
  const build = packageManagerShellCommand(options.packageManager, ['run', `build:${workspace.name}`]);
  return `FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3\nWORKDIR /workspace\nCOPY . .\nRUN test -f ${lockfile}\nRUN ${install}\nRUN ${build}\nWORKDIR /workspace/${directory}\nENV NODE_ENV=production\nUSER 10001:10001\nCMD ${JSON.stringify(command)}\n`;
}

function deploymentCommand(workspace, definition) {
  const moduleName = pythonModuleName(workspace.name);
  if (definition.language === 'python') {
    if (workspace.template === 'python-django-api')
      return ['uv', 'run', 'python', 'manage.py', 'runserver', '0.0.0.0:8000'];
    if (workspace.template === 'python-fastapi-api' || workspace.template === 'python-model')
      return ['uv', 'run', 'uvicorn', `${moduleName}.main:app`, '--host', '0.0.0.0', '--port', '8000'];
    return ['uv', 'run', 'python', '-m', `${moduleName}.worker`];
  }
  if (workspace.template === 'php-laravel-api')
    return ['php', 'artisan', 'serve', '--host=0.0.0.0', '--port=8080'];
  if (definition.language === 'php') return ['php', '-S', '0.0.0.0:8080', '-t', 'public'];
  if (definition.language === 'go') return ['/app'];
  if (workspace.template === 'node-nest-api') return ['node', 'dist/main.js'];
  if (workspace.template === 'next-web') return ['npx', '--no-install', 'next', 'start'];
  if (workspace.template === 'nuxt-web') return ['node', '.output/server/index.mjs'];
  if (workspace.template === 'sveltekit-web') return ['node', 'build'];
  if (['react-vite-web', 'vue-vite-web', 'angular-web'].includes(workspace.template))
    return ['node', 'scripts/serve-static.mjs'];
  const file =
    workspace.template === 'node-worker'
      ? 'worker.mjs'
      : workspace.template === 'node-cron'
        ? 'job.mjs'
        : 'server.mjs';
  return ['node', `src/${file}`];
}

function kubernetesFiles(options) {
  const workloadIds = options.workspaces
    .filter((workspace) => ['service', 'model'].includes(WORKSPACE_RECIPES[workspace.template].kind))
    .map((workspace) => `${options.name}-${workspace.name}`);
  const intent = [
    '# MonoX Kubernetes render gate',
    '#',
    '# This file intentionally contains no runnable Kubernetes resources.',
    '# A target registry and an immutable image reference from the build receipt must be resolved first.',
    '# Use `monox plan` and `monox render` after binding the selected environment and target.',
    ...workloadIds.map((id) => `# pending workload: ${id}`),
    '',
  ].join('\n');
  return new Map([
    ['infra/kubernetes/workloads.yaml', intent],
    [
      'infra/kubernetes/README.md',
      '# Kubernetes\n\n`workloads.yaml` is a fail-closed render gate, not a manifest to apply. Bind an environment target and an immutable image reference from the build receipt, then use `monox plan` and `monox render` to produce deployable resources. The generator never emits a guessed or mutable workload image.\n',
    ],
  ]);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function gitignore() {
  return 'node_modules/\n.env\n.env.*\n!.env.example\ncoverage/\ndist/\n.venv/\nvendor/\n*.log\n.DS_Store\n.monox/\n';
}

function editorConfig() {
  return 'root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\ninsert_final_newline = true\nindent_style = space\nindent_size = 2\ntrim_trailing_whitespace = true\n';
}
