import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as generator from 'create-monox';
import * as catalog from 'create-monox/catalog';
import * as explicitGenerator from 'create-monox/generator';

test('publishes stable generator and catalog runtime entry points', () => {
  assert.equal(explicitGenerator.generateProject, generator.generateProject);
  assert.equal(catalog.RECIPE_API_VERSION, '1');
  assert.equal(catalog.RECIPE_VERSION, '1.0.0');
  assert.equal(catalog.WORKSPACE_RECIPES['node-fastify-api'].apiVersion, '1');
  assert.equal(catalog.ADDON_RECIPES.redis.apiVersion, '1');
  assert.equal(catalog.catalogManifest().workspaces['node-fastify-api'].apiVersion, '1');
});

test('maps every public runtime entry point to a declaration file', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), { encoding: 'utf8' })
  );
  assert.equal(manifest.types, './src/generator.d.ts');
  assert.equal(manifest.exports['.'].types, './src/generator.d.ts');
  assert.equal(manifest.exports['./generator'].types, './src/generator.d.ts');
  assert.equal(manifest.exports['./catalog'].types, './src/catalog.d.ts');
});
