import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';
import { executePlan, formatPlan, planRepository, planTaskGraph } from '../src/index.mjs';

const graph = {
  schemaVersion: '1',
  tasks: {
    build: {
      dependsOn: ['^build'],
      inputs: ['package.json', 'src/**'],
      outputs: ['dist/**'],
      env: ['MONOX_TEST_TOKEN'],
    },
    test: {
      dependsOn: ['build'],
      inputs: ['package.json', 'src/**', 'test/**'],
      outputs: [],
    },
  },
};

async function withTemp(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monox-tasks-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(root, relative, value) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePackage(root, location, manifest, files = {}) {
  await writeJson(root, path.join(location, 'package.json'), manifest);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, location, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

async function writeRepo(root) {
  await writeJson(root, 'package.json', {
    name: 'fixture',
    private: true,
    workspaces: ['packages/*'],
  });
  await writePackage(
    root,
    'packages/shared',
    { name: '@monox/shared', private: true, scripts: { build: 'node build.mjs' } },
    { 'src/index.mjs': 'export const value = 1;\n' }
  );
  await writePackage(
    root,
    'packages/api',
    {
      name: '@monox/api',
      private: true,
      scripts: { build: 'node build.mjs', test: 'node test.mjs' },
      dependencies: { '@monox/shared': 'workspace:^' },
    },
    { 'src/server.mjs': 'export const server = true;\n', 'test/server.test.mjs': 'test();\n' }
  );
  await writePackage(
    root,
    'packages/web',
    {
      name: '@monox/web',
      private: true,
      scripts: { build: 'node build.mjs' },
      devDependencies: { '@monox/shared': 'workspace:^' },
    },
    { 'src/app.mjs': 'export const app = true;\n' }
  );
  await writeJson(root, 'monox.tasks.json', graph);
}

function byId(plan, id) {
  const task = plan.tasks.find((item) => item.id === id);
  assert.ok(task, `missing ${id}`);
  return task;
}

async function executeBuilds(root, plan, calls) {
  return executePlan(plan, {
    root,
    async runTask({ root: taskRoot, id }) {
      calls.push(id);
      if (!id.endsWith('#build')) return;
      const location = id.slice(0, id.indexOf('#'));
      const workspace = plan.tasks.find((task) => task.id === id);
      const file = path.join(taskRoot, workspace.location, 'dist/index.mjs');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${location}\n`);
    },
  });
}

test('task identity follows package name and declared dependency rules', async () => {
  await withTemp(async (root) => {
    await writeRepo(root);
    const plan = await planTaskGraph({ root, graph, changedPaths: [] });
    assert.equal(plan.failOpen, false);
    assert.equal(plan.execution, 'selective');
    assert.deepEqual(
      plan.tasks.map((task) => task.id),
      ['@monox/shared#build', '@monox/api#build', '@monox/api#test', '@monox/web#build']
    );
    assert.deepEqual(byId(plan, '@monox/shared#build').dependencies, []);
    assert.deepEqual(byId(plan, '@monox/api#build').dependencies, ['@monox/shared#build']);
    assert.deepEqual(byId(plan, '@monox/web#build').dependencies, ['@monox/shared#build']);
    assert.deepEqual(byId(plan, '@monox/api#test').dependencies, ['@monox/api#build']);
    assert.equal(plan.cache.mode, 'local');
    assert.equal(plan.cache.remote, false);
  });
});

test('upstream edges follow dependencies, devDependencies, optionalDependencies and peerDependencies', async () => {
  await withTemp(async (root) => {
    await writeJson(root, 'package.json', { name: 'fixture', private: true, workspaces: ['packages/*'] });
    await writePackage(root, 'packages/lib', {
      name: '@monox/lib',
      scripts: { build: 'node build.mjs' },
    });
    for (const [location, field] of [
      ['packages/app', 'dependencies'],
      ['packages/tool', 'devDependencies'],
      ['packages/extra', 'optionalDependencies'],
      ['packages/plugin', 'peerDependencies'],
    ]) {
      await writePackage(root, location, {
        name: `@monox/${path.basename(location)}`,
        scripts: { build: 'node build.mjs' },
        [field]: { '@monox/lib': 'workspace:^' },
      });
    }
    const plan = await planTaskGraph({
      root,
      graph: { schemaVersion: '1', tasks: { build: { dependsOn: ['^build'], inputs: ['package.json'] } } },
      changedPaths: [],
    });
    assert.equal(plan.failOpen, false);
    for (const name of ['@monox/app', '@monox/extra', '@monox/plugin', '@monox/tool']) {
      assert.deepEqual(byId(plan, `${name}#build`).dependencies, ['@monox/lib#build']);
    }
  });
});

test('cache keys include every declared input and change when any input or env value changes', async () => {
  await withTemp(async (root) => {
    await writeRepo(root);
    const secret = 'super-secret-cache-value';
    const first = await planTaskGraph({
      root,
      graph,
      selectAll: true,
      env: { MONOX_TEST_TOKEN: secret },
    });
    const build = byId(first, '@monox/api#build');
    assert.deepEqual(
      build.inputs.map((input) => input.path),
      ['packages/api/package.json', 'packages/api/src/server.mjs']
    );
    assert.equal(
      build.inputs.every((input) => input.sha256 && input.sha256.length === 64),
      true
    );
    assert.equal(build.keyMaterial.inputs.length, build.inputs.length);
    assert.equal(build.keyMaterial.definition.inputs.includes('package.json'), true);
    assert.equal(build.keyMaterial.definition.inputs.includes('src/**'), true);
    assert.equal(JSON.stringify(first).includes(secret), false);
    assert.deepEqual(
      build.env.map((item) => item.name),
      ['MONOX_TEST_TOKEN']
    );

    await writeFile(path.join(root, 'packages/api/src/server.mjs'), 'export const server = false;\n');
    const changed = await planTaskGraph({
      root,
      graph,
      selectAll: true,
      env: { MONOX_TEST_TOKEN: secret },
    });
    assert.notEqual(byId(changed, '@monox/api#build').cacheKey, build.cacheKey);
    assert.notEqual(byId(changed, '@monox/api#test').cacheKey, byId(first, '@monox/api#test').cacheKey);

    const otherEnv = await planTaskGraph({
      root,
      graph,
      selectAll: true,
      env: { MONOX_TEST_TOKEN: 'other-secret-value' },
    });
    assert.notEqual(byId(otherEnv, '@monox/api#build').cacheKey, byId(changed, '@monox/api#build').cacheKey);
    assert.equal(JSON.stringify(otherEnv).includes('other-secret-value'), false);

    const absent = await planTaskGraph({
      root,
      graph: {
        schemaVersion: '1',
        tasks: { build: { inputs: ['package.json', 'README.md'], outputs: [] } },
      },
      changedPaths: [],
    });
    const shared = byId(absent, '@monox/shared#build');
    assert.deepEqual(
      shared.inputs.map((input) => [input.glob, input.path]),
      [
        ['package.json', 'packages/shared/package.json'],
        ['README.md', null],
      ]
    );
  });
});

test('dry-run explains skip, run and restore without executing or writing the cache', async () => {
  await withTemp(async (root) => {
    await writeRepo(root);
    const calls = [];
    const warmed = await planTaskGraph({ root, graph, selectAll: true });
    await executeBuilds(root, warmed, calls);
    assert.deepEqual(calls, [
      '@monox/shared#build',
      '@monox/api#build',
      '@monox/api#test',
      '@monox/web#build',
    ]);

    await writeFile(path.join(root, 'packages/api/src/server.mjs'), 'export const server = false;\n');
    await rm(path.join(root, 'packages/web/dist/index.mjs'));
    const plan = await planTaskGraph({
      root,
      graph,
      changedPaths: ['packages/api/src/server.mjs'],
    });
    assert.equal(plan.failOpen, false);
    assert.equal(byId(plan, '@monox/shared#build').status, 'skip');
    assert.match(byId(plan, '@monox/shared#build').reason, /no declared input changed/);
    assert.equal(byId(plan, '@monox/api#build').status, 'run');
    assert.match(
      byId(plan, '@monox/api#build').reason,
      /declared input changed: packages\/api\/src\/server\.mjs/
    );
    assert.match(byId(plan, '@monox/api#build').reason, /no local cache entry/);
    assert.equal(byId(plan, '@monox/api#test').status, 'run');
    assert.match(byId(plan, '@monox/api#test').reason, /dependency @monox\/api#build will run/);
    assert.equal(byId(plan, '@monox/web#build').status, 'restore');
    assert.match(byId(plan, '@monox/web#build').reason, /declared output is missing/);
    assert.match(byId(plan, '@monox/web#build').reason, /local cache hit/);

    const text = formatPlan(plan);
    assert.match(text, /@monox\/shared#build skip/);
    assert.match(text, /@monox\/api#build run/);
    assert.match(text, /@monox\/web#build restore/);
    assert.match(text, /cache: local \.monox\/cache\/tasks/);
    for (const input of byId(plan, '@monox/api#build').inputs) {
      assert.match(text, new RegExp(input.path.replaceAll('/', '\\/')));
    }

    const before = calls.length;
    const stdout = [];
    const code = await runCli(
      ['plan', '--root', root, '--changed', 'packages/api/src/server.mjs', '--json'],
      {
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write() {} },
      }
    );
    assert.equal(code, 0);
    assert.equal(calls.length, before);
    const parsed = JSON.parse(stdout.join(''));
    assert.equal(parsed.cache.remote, false);
    assert.equal(parsed.tasks.find((task) => task.id === '@monox/web#build').status, 'restore');
  });
});

test('run restores local cache entries in dependency order and records a transparent manifest', async () => {
  await withTemp(async (root) => {
    await writeRepo(root);
    const calls = [];
    const warmed = await planTaskGraph({ root, graph, selectAll: true, env: { MONOX_TEST_TOKEN: 'hidden' } });
    await executeBuilds(root, warmed, calls);
    const manifestPath = path.join(
      root,
      '.monox/cache/tasks',
      byId(warmed, '@monox/api#build').cacheKey,
      'manifest.json'
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.taskId, '@monox/api#build');
    assert.deepEqual(
      manifest.keyMaterial.inputs.map((input) => input.path),
      ['packages/api/package.json', 'packages/api/src/server.mjs']
    );
    assert.equal(JSON.stringify(manifest).includes('hidden'), false);
    assert.equal(manifest.keyMaterial.dependencies[0].id, '@monox/shared#build');

    await rm(path.join(root, 'packages/api/dist/index.mjs'));
    const restored = await planTaskGraph({
      root,
      graph,
      changedPaths: [],
      env: { MONOX_TEST_TOKEN: 'hidden' },
    });
    assert.equal(byId(restored, '@monox/api#build').status, 'restore');
    const result = await executeBuilds(root, restored, calls);
    assert.deepEqual(result.restored, ['@monox/api#build']);
    assert.equal(calls.length, 4);
    assert.equal(await readFile(path.join(root, 'packages/api/dist/index.mjs'), 'utf8'), '@monox/api\n');
  });
});

test('a dependency input change selects downstream tasks and changes their cache keys', async () => {
  await withTemp(async (root) => {
    await writeRepo(root);
    const before = await planTaskGraph({ root, graph, changedPaths: [], env: {} });
    await writeFile(path.join(root, 'packages/shared/src/index.mjs'), 'export const value = 2;\n');
    const after = await planTaskGraph({
      root,
      graph,
      changedPaths: ['packages/shared/src/index.mjs'],
      env: {},
    });
    assert.equal(byId(after, '@monox/shared#build').status, 'run');
    assert.equal(byId(after, '@monox/api#build').status, 'run');
    assert.equal(byId(after, '@monox/web#build').status, 'run');
    assert.match(byId(after, '@monox/web#build').reason, /dependency @monox\/shared#build will run/);
    assert.notEqual(byId(after, '@monox/api#build').cacheKey, byId(before, '@monox/api#build').cacheKey);
  });
});

test('declared output changes are covered and do not select the task', async () => {
  await withTemp(async (root) => {
    await writeRepo(root);
    await mkdir(path.join(root, 'packages/shared/dist'), { recursive: true });
    await writeFile(path.join(root, 'packages/shared/dist/index.mjs'), 'stale\n');
    const plan = await planTaskGraph({
      root,
      graph,
      changedPaths: ['packages/shared/dist/index.mjs'],
      env: {},
    });
    assert.equal(plan.failOpen, false);
    assert.equal(byId(plan, '@monox/shared#build').status, 'skip');
    assert.equal(byId(plan, '@monox/api#build').status, 'skip');
  });
});

test('invalid or incomplete graphs fail open without skipping or restoring', async () => {
  await withTemp(async (root) => {
    await writeRepo(root);
    const calls = [];
    const warmed = await planTaskGraph({ root, graph, selectAll: true, env: {} });
    await executeBuilds(root, warmed, calls);
    await writeFile(path.join(root, 'packages/api/dist/index.mjs'), 'dirty\n');

    const cases = [
      [
        {
          schemaVersion: '1',
          tasks: {
            build: { dependsOn: ['test'], inputs: ['src/**'] },
            test: { dependsOn: ['build'], inputs: ['src/**'] },
          },
        },
        'all-tasks',
      ],
      [{ schemaVersion: '1', tasks: { build: { outputs: ['dist/**'] } } }, 'all-tasks'],
      [{ schemaVersion: '1', tasks: { build: { inputs: ['../secrets/**'] } } }, 'all-tasks'],
      [{ schemaVersion: '1', extra: true, tasks: { build: { inputs: ['src/**'] } } }, 'full'],
      [{ schemaVersion: '2', tasks: { build: { inputs: ['src/**'] } } }, 'full'],
      [undefined, 'full'],
    ];
    for (const [candidate, execution] of cases) {
      const plan = await planTaskGraph({
        root,
        graph: candidate,
        changedPaths: ['packages/api/src/server.mjs'],
        env: {},
      });
      assert.equal(plan.failOpen, true, JSON.stringify(candidate));
      assert.equal(plan.execution, execution);
      assert.equal(
        plan.tasks.every((task) => task.status === 'run' && task.cacheKey === null),
        true
      );
      assert.equal(
        plan.tasks.some((task) => task.status === 'skip' || task.status === 'restore'),
        false
      );
    }

    const uncovered = await planTaskGraph({ root, graph, changedPaths: ['README.md'], env: {} });
    assert.equal(uncovered.failOpen, true);
    assert.equal(uncovered.execution, 'all-tasks');
    assert.match(uncovered.reason, /README\.md/);
    await executePlan(uncovered, {
      root,
      async runTask() {
        calls.push('fail-open');
      },
    });
    assert.equal(await readFile(path.join(root, 'packages/api/dist/index.mjs'), 'utf8'), 'dirty\n');
    assert.equal(calls.includes('fail-open'), true);

    const comparison = await planTaskGraph({
      root,
      graph,
      comparisonFailOpen: true,
      comparisonError: 'bad revision',
      env: {},
    });
    assert.equal(comparison.failOpen, true);
    assert.match(comparison.reason, /git comparison failed \(bad revision\)/);
    assert.equal(
      comparison.tasks.every((task) => task.status === 'run'),
      true
    );

    const missing = await planRepository({ root, graphPath: 'missing.tasks.json', changedPaths: [] });
    assert.equal(missing.execution, 'full');
    assert.equal(missing.tasks[0].id, '#repository');
    const full = [];
    await executePlan(missing, {
      root,
      async runFullGate({ script }) {
        full.push(script);
      },
    });
    assert.deepEqual(full, ['check']);

    await writeFile(path.join(root, 'monox.tasks.json'), '{');
    const invalid = await planRepository({ root, changedPaths: [] });
    assert.match(invalid.reason, /not valid JSON/);
    assert.equal(invalid.execution, 'full');
  });
});

test('an incomplete local cache entry is a miss and a disabled cache never restores', async () => {
  await withTemp(async (root) => {
    await writeRepo(root);
    const warmed = await planTaskGraph({ root, graph, selectAll: true, env: {} });
    await executeBuilds(root, warmed, []);
    const cacheKey = byId(warmed, '@monox/shared#build').cacheKey;
    await writeFile(path.join(root, '.monox/cache/tasks', cacheKey, 'manifest.json'), '{');
    const incomplete = await planTaskGraph({ root, graph, selectAll: true, env: {} });
    assert.equal(incomplete.failOpen, false);
    assert.equal(byId(incomplete, '@monox/shared#build').status, 'run');
    assert.match(byId(incomplete, '@monox/shared#build').reason, /local cache entry is incomplete/);

    const disabled = await planTaskGraph({
      root,
      graph: {
        schemaVersion: '1',
        tasks: { build: { inputs: ['package.json'], outputs: ['dist/**'], cache: false } },
      },
      selectAll: true,
      env: {},
    });
    assert.equal(byId(disabled, '@monox/shared#build').status, 'run');
    assert.match(byId(disabled, '@monox/shared#build').reason, /cache is disabled/);
    await executePlan(disabled, { root, async runTask() {} });
    await assert.rejects(
      readFile(
        path.join(root, '.monox/cache/tasks', byId(disabled, '@monox/shared#build').cacheKey, 'manifest.json')
      )
    );
  });
});

test('symlink inputs and tasks with no script fail open', async () => {
  await withTemp(async (root) => {
    await writeRepo(root);
    await symlink(
      path.join(root, 'packages/api/src/server.mjs'),
      path.join(root, 'packages/api/src/link.mjs')
    );
    const linked = await planTaskGraph({ root, graph, changedPaths: [], env: {} });
    assert.equal(linked.failOpen, true);
    assert.match(linked.reason, /symlink/);

    const unnamed = await planTaskGraph({
      root,
      graph: { schemaVersion: '1', tasks: { lint: { inputs: ['src/**'] } } },
      changedPaths: [],
    });
    assert.equal(unnamed.execution, 'full');
    assert.match(unnamed.reason, /task lint matches no workspace script/);
  });
});

test('a repository that cannot compare git revisions fails open to every task', async () => {
  await withTemp(async (root) => {
    await writeRepo(root);
    const plan = await planRepository({ root, env: {} });
    assert.equal(plan.failOpen, true);
    assert.equal(plan.execution, 'all-tasks');
    assert.match(plan.reason, /git comparison failed/);
    assert.equal(
      plan.tasks.every((task) => task.status === 'run' && task.cacheKey === null),
      true
    );
  });
});

test('failed task execution does not write a cache entry', async () => {
  await withTemp(async (root) => {
    await writeRepo(root);
    const plan = await planTaskGraph({ root, graph, selectAll: true, env: {} });
    await assert.rejects(
      executePlan(plan, {
        root,
        async runTask({ id }) {
          if (id === '@monox/api#build') throw new Error('build failed');
        },
      }),
      /build failed/
    );
    await assert.rejects(
      readFile(
        path.join(root, '.monox/cache/tasks', byId(plan, '@monox/api#build').cacheKey, 'manifest.json')
      )
    );
  });
});
