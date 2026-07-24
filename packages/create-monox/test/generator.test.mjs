import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateProject, resolveDestination, validateProjectName } from '../src/generator.mjs';

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'create-monox-test-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('generates the default workspace with Docker and Kubernetes templates', async () => {
  await withTemporaryDirectory(async (parent) => {
    const destination = join(parent, 'sample-app');
    const result = await generateProject({
      name: 'sample-app',
      directory: destination,
      git: false,
    });

    assert.equal(result.packageManager, 'yarn');
    assert.equal(result.infra, 'all');
    assert.equal(result.gitInitialized, false);

    const expectedFiles = [
      'AGENTS.md',
      'monox.config.json',
      '.github/workflows/ci.yml',
      'apps/api/src/server.mjs',
      'apps/web/src/server.mjs',
      'packages/shared/src/index.mjs',
      'infra/docker/compose.yaml',
      'infra/kubernetes/workloads.yaml',
    ];

    for (const relativePath of expectedFiles) {
      assert.equal((await stat(join(destination, relativePath))).isFile(), true, relativePath);
    }

    const packageJson = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
    assert.equal(packageJson.name, 'sample-app');
    assert.equal(packageJson.private, true);
    assert.equal(packageJson.packageManager, 'yarn@4.9.1');
    assert.equal(packageJson.engines.node, '^22.0.0 || ^24.0.0 || ^26.0.0');
    assert.deepEqual(packageJson.workspaces, ['apps/*', 'packages/*']);
    assert.equal(await readFile(join(destination, '.yarnrc.yml'), 'utf8'), 'nodeLinker: node-modules\n');

    const config = JSON.parse(await readFile(join(destination, 'monox.config.json'), 'utf8'));
    assert.deepEqual(config.infrastructure, {
      preset: 'all',
      docker: true,
      kubernetes: true,
    });

    const workflow = await readFile(join(destination, '.github/workflows/ci.yml'), 'utf8');
    assert.match(workflow, /actions\/checkout@[a-f0-9]{40}/);
    assert.match(workflow, /actions\/setup-node@[a-f0-9]{40}/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /node:\n\s+- 22\n\s+- 24\n\s+- 26/);
    assert.match(workflow, /node-version: \$\{\{ matrix\.node \}\}/);
    assert.match(workflow, /Require committed yarn\.lock/);
    assert.match(workflow, /npm install --global corepack@0\.35\.0/);
    assert.match(workflow, /yarn install --immutable/);

    const apiDockerfile = await readFile(join(destination, 'infra/docker/api.Dockerfile'), 'utf8');
    assert.match(apiDockerfile, /node:22\.23\.1-bookworm-slim@sha256:[a-f0-9]{64}/);
    assert.match(apiDockerfile, /Missing yarn\.lock/);
    assert.match(apiDockerfile, /yarn install --immutable/);
    assert.match(apiDockerfile, /USER node/);
    assert.match(apiDockerfile, /HEALTHCHECK/);

    const compose = await readFile(join(destination, 'infra/docker/compose.yaml'), 'utf8');
    assert.match(compose, /read_only: true/);
    assert.match(compose, /cap_drop: \[ALL\]/);

    const workloads = await readFile(join(destination, 'infra/kubernetes/workloads.yaml'), 'utf8');
    assert.doesNotMatch(workloads, /:latest/);
    assert.match(workloads, /runAsNonRoot: true/);
    assert.match(workloads, /kind: NetworkPolicy/);
    assert.match(workloads, /kind: PodDisruptionBudget/);
  });
});

test('supports pnpm and omits infrastructure for the none preset', async () => {
  await withTemporaryDirectory(async (parent) => {
    const destination = join(parent, 'minimal-app');
    await generateProject({
      name: 'minimal-app',
      directory: destination,
      packageManager: 'pnpm',
      infra: 'none',
      git: false,
    });

    assert.equal((await stat(join(destination, 'pnpm-workspace.yaml'))).isFile(), true);
    await assert.rejects(stat(join(destination, 'infra')), { code: 'ENOENT' });

    const apiPackage = JSON.parse(await readFile(join(destination, 'apps/api/package.json'), 'utf8'));
    assert.equal(apiPackage.dependencies['@minimal-app/shared'], 'workspace:*');

    const workflow = await readFile(join(destination, '.github/workflows/ci.yml'), 'utf8');
    assert.match(workflow, /pnpm install --frozen-lockfile/);
    assert.match(workflow, /corepack enable/);
  });
});

test('writes only the infrastructure family selected by the preset', async () => {
  await withTemporaryDirectory(async (parent) => {
    for (const infra of ['docker', 'kubernetes']) {
      const destination = join(parent, `${infra}-app`);
      await generateProject({
        name: `${infra}-app`,
        directory: destination,
        infra,
        git: false,
      });

      const included = infra === 'docker' ? 'docker' : 'kubernetes';
      const omitted = infra === 'docker' ? 'kubernetes' : 'docker';
      assert.equal((await stat(join(destination, 'infra', included))).isDirectory(), true);
      await assert.rejects(stat(join(destination, 'infra', omitted)), { code: 'ENOENT' });
    }
  });
});

test('refuses a nonempty destination without changing existing content', async () => {
  await withTemporaryDirectory(async (parent) => {
    const destination = join(parent, 'occupied');
    await mkdir(destination);
    const marker = join(destination, 'keep.txt');
    await writeFile(marker, 'keep me\n');

    await assert.rejects(
      generateProject({ name: 'occupied', directory: destination, git: false }),
      /Destination is not empty/
    );
    assert.equal(await readFile(marker, 'utf8'), 'keep me\n');
  });
});

test('validates project names before resolving or writing a destination', () => {
  for (const name of ['../escape', 'Uppercase', '-leading', 'trailing-', 'with space', 'a'.repeat(64)]) {
    assert.throws(() => validateProjectName(name), /Project name must use/);
  }

  assert.equal(validateProjectName('safe-project-22'), 'safe-project-22');
  assert.equal(
    resolveDestination({ cwd: '/tmp/work', name: 'safe-project-22' }),
    '/tmp/work/safe-project-22'
  );
});

test('runs Git initialization and the selected installer only when requested', async () => {
  await withTemporaryDirectory(async (parent) => {
    const calls = [];
    const destination = join(parent, 'command-app');

    const result = await generateProject(
      {
        name: 'command-app',
        directory: destination,
        packageManager: 'npm',
        infra: 'docker',
        install: true,
      },
      {
        runCommand: async (command, args, context) => {
          calls.push({ command, args, cwd: context.cwd });
        },
      }
    );

    assert.deepEqual(calls, [
      { command: 'git', args: ['init', '--initial-branch=main'], cwd: destination },
      { command: 'npm', args: ['install'], cwd: destination },
    ]);
    assert.equal(result.gitInitialized, true);
    assert.equal(result.installed, true);
  });
});

test('uses Corepack to install with Yarn and produce the generated lockfile', async () => {
  await withTemporaryDirectory(async (parent) => {
    const calls = [];

    const result = await generateProject(
      {
        name: 'yarn-app',
        directory: join(parent, 'yarn-app'),
        packageManager: 'yarn',
        infra: 'none',
        git: false,
        install: true,
      },
      {
        runCommand: async (command, args, context) => {
          calls.push({ command, args, cwd: context.cwd });
        },
      }
    );

    assert.deepEqual(calls, [
      {
        command: 'corepack',
        args: ['yarn', 'install'],
        cwd: join(parent, 'yarn-app'),
      },
    ]);
    assert.equal(result.installed, true);
  });
});
