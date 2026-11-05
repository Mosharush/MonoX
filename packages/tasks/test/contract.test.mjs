import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../../create-monox/src/json-schema.mjs';
import { inspectTaskGraph } from '../src/index.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('the task graph schema agrees with the planner on the public fixture', async () => {
  const schema = JSON.parse(await readFile(path.join(repoRoot, 'schemas/v1/tasks.schema.json'), 'utf8'));
  const valid = JSON.parse(
    await readFile(path.join(repoRoot, 'schemas/fixtures/v1/valid.tasks.json'), 'utf8')
  );
  const schemaResult = validateJsonSchema(valid, schema);
  const runtime = inspectTaskGraph(valid);
  assert.deepEqual(schemaResult.errors, []);
  assert.equal(runtime.fatal, false);
  assert.deepEqual(runtime.errors, []);

  const invalid = [
    { schemaVersion: '1', tasks: {} },
    { schemaVersion: '1', tasks: { build: {} } },
    { schemaVersion: '9', tasks: { build: { inputs: ['src/**'] } } },
    { schemaVersion: '1', remoteCache: true, tasks: { build: { inputs: ['src/**'] } } },
    { schemaVersion: '1', tasks: { 'build task': { inputs: ['src/**'] } } },
  ];
  for (const document of invalid) {
    assert.equal(validateJsonSchema(document, schema).valid, false, JSON.stringify(document));
    const inspected = inspectTaskGraph(document);
    assert.equal(inspected.fatal || inspected.errors.length > 0, true, JSON.stringify(document));
  }
});

test('public CI keeps the complete repository gate', async () => {
  const workflowDirectory = path.join(repoRoot, '.github/workflows');
  const workflow = await readFile(path.join(workflowDirectory, 'ci.yml'), 'utf8');
  for (const command of [
    'yarn install --immutable',
    'yarn format:check',
    'yarn lint',
    'yarn test',
    'yarn build',
    'yarn infra:check',
  ]) {
    assert.equal(workflow.includes(command), true, command);
  }
  assert.match(workflow, /Selective task execution is not approved for public CI/);
  assert.match(workflow, /complete repository gate/);

  for (const file of await readdir(workflowDirectory)) {
    if (!file.endsWith('.yml')) continue;
    const text = await readFile(path.join(workflowDirectory, file), 'utf8');
    assert.equal(text.includes('monox-tasks'), false, file);
    assert.equal(text.includes('packages/tasks'), false, file);
  }
});
