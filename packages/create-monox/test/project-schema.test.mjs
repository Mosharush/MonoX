import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateMonoXConfigV2 } from '../../config/src/index.mjs';
import { validateJsonSchema } from '../src/json-schema.mjs';

const repositoryRoot = new URL('../../../', import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, repositoryRoot), 'utf8'));
}

test('accepts the valid project fixture and rejects invalid configuration fixtures', async () => {
  const schema = await readJson('schemas/v2/monox.schema.json');
  const valid = await readJson('schemas/fixtures/v2/valid.config.json');
  const validResult = validateJsonSchema(valid, schema);
  assert.equal(validResult.valid, true, JSON.stringify(validResult.errors));
  const runtime = validateMonoXConfigV2(valid);
  assert.equal(runtime.valid, true, JSON.stringify(runtime.errors));

  const cases = await readJson('schemas/fixtures/v2/invalid-cases.json');
  assert.ok(cases.length >= 2);
  for (const entry of cases) {
    const result = validateJsonSchema(entry.document, schema);
    assert.equal(result.valid, false, entry.name);
    assert.ok(
      result.errors.some((issue) => issue.path === entry.path),
      `${entry.name}: ${JSON.stringify(result.errors)}`
    );
  }
});

test('keeps the bundled generator schema identical to the public contract', async () => {
  const published = await readFile(new URL('schemas/v2/monox.schema.json', repositoryRoot), 'utf8');
  const bundled = await readFile(
    new URL('packages/create-monox/schema/v2/monox.schema.json', repositoryRoot),
    'utf8'
  );
  assert.equal(bundled, published);
});

test('validates the repository configuration against the public v2 schema', async () => {
  const schema = await readJson('schemas/v2/monox.schema.json');
  const config = await readJson('monox.config.json');
  const result = validateJsonSchema(config, schema);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('fails closed on unsupported keywords, external references and oneOf cardinality', () => {
  assert.equal(validateJsonSchema('https://example.invalid', { type: 'string', format: 'uri' }).valid, false);
  assert.equal(validateJsonSchema({ schemaVersion: '2' }, { $ref: './v1/monox.schema.json' }).valid, false);
  const schema = {
    oneOf: [
      { type: 'object', required: ['left'] },
      { type: 'object', required: ['right'] },
    ],
  };
  assert.equal(validateJsonSchema({ left: true }, schema).valid, true);
  assert.equal(validateJsonSchema({}, schema).valid, false);
  assert.equal(validateJsonSchema({ left: true, right: true }, schema).valid, false);
});
