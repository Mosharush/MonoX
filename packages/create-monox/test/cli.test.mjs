import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { loadConfiguration, parseArguments } from '../src/cli.mjs';

const execFileAsync = promisify(execFile);
const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(packageDirectory, 'src', 'cli.mjs');

test('parses legacy and repeatable 0.2 options without collapsing selections', () => {
  assert.deepEqual(
    parseArguments([
      'demo-app',
      '--directory',
      './target',
      '--package-manager=pnpm',
      '--infra',
      'kubernetes',
      '--workspace',
      'api=node-fastify-api',
      '--workspace=worker=python-worker',
      '--addon',
      'redis',
      '--addon=rabbitmq',
      '--delivery',
      'kubernetes:gcp-gke',
      '--environment',
      'staging',
      '--yes',
      '--no-git',
      '--install',
      '--dry-run',
    ]),
    {
      name: 'demo-app',
      directory: './target',
      packageManager: 'pnpm',
      infra: 'kubernetes',
      workspaces: ['api=node-fastify-api', 'worker=python-worker'],
      addons: ['redis', 'rabbitmq'],
      delivery: 'kubernetes:gcp-gke',
      environment: 'staging',
      config: undefined,
      interactive: false,
      dryRun: true,
      yes: true,
      git: false,
      install: true,
      help: false,
      version: false,
    }
  );
});

test('accepts config-only and interactive entry modes', () => {
  assert.equal(parseArguments(['--config', 'monox.create.json']).config, 'monox.create.json');
  assert.equal(parseArguments(['--interactive']).interactive, true);
  assert.throws(() => parseArguments([]), /project name, --config, or --interactive/);
});

test('help separates executable and planned delivery targets', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, '--help']);
  assert.equal(stderr, '');
  assert.match(stdout, /Available delivery targets:[\s\S]*docker:local/);
  assert.match(stdout, /Planned for 0\.2\.0-alpha\.2[\s\S]*docker:generic-ssh/);
});

test('rejects unknown options, malformed selections and invalid enum values', () => {
  assert.throws(() => parseArguments(['demo-app', '--wat']), /Unknown option/);
  assert.throws(
    () => parseArguments(['demo-app', '--package-manager', 'bun']),
    /Package manager must be one of/
  );
  assert.throws(() => parseArguments(['demo-app', '--infra', 'cloud']), /Infrastructure must be one of/);
  assert.throws(() => parseArguments(['demo-app', '--workspace', 'api']), /name=template syntax/);
  assert.throws(() => parseArguments(['demo-app', '--addon', 'unknown']), /Add-on must be one of/);
  assert.throws(
    () => parseArguments(['demo-app', '--delivery', 'docker:somewhere']),
    /Delivery must be one of/
  );
});

test('loads strict JSON configuration and resolves its destination relative to the file', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'create-monox-config-'));
  try {
    const path = join(parent, 'create.json');
    await writeFile(
      path,
      JSON.stringify({
        name: 'config-app',
        directory: './output',
        packageManager: 'pnpm',
        workspaces: { api: 'node-hono-api' },
        addons: ['redis'],
        delivery: 'docker:local',
        install: false,
      })
    );
    const config = await loadConfiguration(path);
    assert.equal(config.directory, join(parent, 'output'));
    assert.deepEqual(config.workspaces, { api: 'node-hono-api' });

    await writeFile(join(parent, 'bad.json'), JSON.stringify({ name: 'bad', credentials: 'forbidden' }));
    await assert.rejects(
      loadConfiguration(join(parent, 'bad.json')),
      /Unsupported configuration property: credentials/
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('CLI generates a configured project and explicit CLI selections win', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'create-monox-cli-'));
  const destination = join(parent, 'output');
  const configPath = join(parent, 'create.json');
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        name: 'config-app',
        packageManager: 'yarn',
        workspaces: { api: 'node-http-api' },
        addons: ['redis'],
        delivery: 'docker:local',
        install: false,
        git: false,
      })
    );
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      'cli-app',
      '--config',
      configPath,
      '--directory',
      destination,
      '--package-manager',
      'npm',
      '--workspace',
      'api=node-fastify-api',
      '--yes',
      '--no-git',
      '--no-install',
    ]);
    assert.equal(stderr, '');
    assert.match(stdout, /Created cli-app/);
    assert.match(stdout, /api=node-fastify-api/);
    const root = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
    assert.equal(root.name, 'cli-app');
    assert.equal(root.packageManager, 'npm@12.0.1');
    const api = JSON.parse(await readFile(join(destination, 'apps/api/package.json'), 'utf8'));
    assert.equal(api.deployment.runtime.framework, 'fastify');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('CLI dry-run is side-effect free and does not require --yes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'create-monox-cli-'));
  const destination = join(parent, 'not-created');
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      'dry-app',
      '--directory',
      destination,
      '--workspace',
      'api=node-hono-api',
      '--dry-run',
    ]);
    assert.equal(stderr, '');
    assert.match(stdout, /Dry run for dry-app/);
    assert.match(stdout, /apps\/api\/package.json/);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('CLI prints pinned installation guidance when installation is skipped', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'create-monox-cli-'));
  const destination = join(parent, 'yarn-output');
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      'yarn-app',
      '--directory',
      destination,
      '--yes',
      '--no-git',
      '--no-install',
    ]);
    assert.equal(stderr, '');
    assert.match(stdout, /npx --yes corepack@0\.35\.0 yarn install/);
    assert.doesNotMatch(stdout, /corepack enable/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('CLI still requires explicit --yes for non-interactive writes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'create-monox-cli-'));
  const destination = join(parent, 'non-interactive-output');
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        'non-interactive-app',
        '--directory',
        destination,
        '--no-git',
        '--no-install',
      ]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--yes option is required in non-interactive mode/);
        return true;
      }
    );
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('CLI rejects unsafe names before writing', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, '../escape', '--yes', '--no-git', '--no-install']),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Project name must use/);
      return true;
    }
  );
});

test('CLI version works through a package-manager symlink', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'create-monox-bin-'));
  const executable = join(parent, 'create-monox');
  try {
    await symlink(cliPath, executable);
    const { stdout, stderr } = await execFileAsync(executable, ['--version']);
    assert.equal(stderr, '');
    assert.equal(stdout.trim(), '0.2.0-alpha.1');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
