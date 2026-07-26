import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { generatedTypeFiles, renderDeploymentGeneratedTypes } from '../scripts/generate-types.mjs';
import { deploymentSchemaV2 } from '../src/index.mjs';

async function deploymentDeclarations() {
  const files = await generatedTypeFiles();
  return files.find((file) => file.path.endsWith('/packages/deploy-schema/src/generated.d.ts')).content;
}

test('generates the complete nested deployment v2 contract', async () => {
  const declarations = await deploymentDeclarations();

  assert.doesNotMatch(declarations, /(?:build|runtime): unknown;/);
  assert.match(declarations, /export interface DeploymentBuildSpec \{/);
  assert.match(declarations, /image\?: DeploymentImageReference;/);
  assert.match(declarations, /export type DeploymentSha256Digest = `sha256:\$\{string\}`;/);
  assert.match(declarations, /digest: DeploymentSha256Digest;/);

  assert.match(declarations, /export interface DeploymentScalingSpec \{/);
  assert.match(declarations, /pollingInterval\?: number;/);
  assert.match(declarations, /cooldownPeriod\?: number;/);
  assert.match(declarations, /metrics\?: DeploymentScalingMetric\[\];/);
  assert.match(declarations, /type: 'rps';\s+sourceRef: string;\s+query: string;/);
  assert.match(declarations, /type: 'external';\s+sourceRef: string;\s+metricName: string;/);
  assert.match(declarations, /type: 'keda';\s+scaler: string;/);

  assert.match(declarations, /export interface DeploymentAdapterOverrides \{/);
  for (const adapter of ['kubernetes', 'pm2', 'coolify', 'static']) {
    assert.match(declarations, new RegExp(`\\b${adapter}\\?: Deployment[A-Z][A-Za-z0-9]+Overrides;`));
  }

  assert.match(declarations, /variants\?: Record<string, DeploymentVariantPatchV2>;/);
  assert.match(declarations, /environments\?: Record<string, DeploymentPatchV2>;/);
  assert.match(
    declarations,
    /export type DeploymentVariantPatchV2 = DeploymentObjectPatchV2 & \{\s+environments\?: Record<string, DeploymentPatchV2>;/
  );
  assert.match(declarations, /build: Omit<DeploymentBuildSpec, 'strategy'>;/);
  assert.match(declarations, /runtime: Omit<DeploymentRuntimeSpec, 'language'>;/);
});

test('keeps scaling metric declarations exhaustive when the schema enum changes', () => {
  const changedSchema = structuredClone(deploymentSchemaV2);
  changedSchema.$defs.scalingMetric.properties.type.enum.push('future-scaler');
  assert.throws(
    () => renderDeploymentGeneratedTypes(changedSchema),
    /scaling metric union must classify every enum value exactly once/
  );
});

test('keeps index declarations as a thin runtime API over generated contract types', async () => {
  const indexDeclarations = await readFile(new URL('../src/index.d.ts', import.meta.url), 'utf8');
  assert.match(indexDeclarations, /^export \* from '\.\/generated\.js';/);
  assert.doesNotMatch(indexDeclarations, /export interface DeploymentBuildSpec/);
  assert.doesNotMatch(indexDeclarations, /export interface DeploymentSpecV2/);
});
