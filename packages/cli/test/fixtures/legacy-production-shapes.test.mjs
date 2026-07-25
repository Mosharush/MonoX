import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateDeploymentSpecV2 } from '@monox/deploy-schema';
import { migrateDeployment } from '../../src/migration.mjs';

const fixtureFile = new URL('./legacy-production-shapes.json', import.meta.url);
const cases = JSON.parse(await readFile(fixtureFile, 'utf8'));

function pointerValue(value, pointer) {
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((current, part) => current?.[part], value);
}

for (const fixture of cases) {
  test(`clean-room legacy shape: ${fixture.name}`, () => {
    const report = migrateDeployment(fixture.input, { from: 'legacy-production' });
    const codes = report.manualReview.map((finding) => finding.code);

    for (const [pointer, expected] of Object.entries(fixture.expected))
      assert.deepEqual(pointerValue(report, pointer), expected, pointer);
    for (const code of fixture.requiredCodes) assert.ok(codes.includes(code), `missing ${code}`);
    for (const code of fixture.forbiddenCodes) assert.ok(!codes.includes(code), `unexpected ${code}`);

    const validation = validateDeploymentSpecV2(report.output);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    assert.doesNotMatch(JSON.stringify(report), /private-product-marker|customer|\.com\b|AKIA|PRIVATE KEY/i);
  });
}

test('legacy type and service class mapping is explicit', () => {
  const cases = [
    [{ type: 'cdn', source: 'dist' }, 'static', 'javascript'],
    [{ type: 'website', source: 'dist' }, 'static', 'javascript'],
    [{ type: 'node', serviceClass: 'optional' }, 'service', 'javascript'],
    [{ type: 'node', serviceClass: 'singleton-worker' }, 'worker', 'javascript'],
    [{ type: 'python' }, 'service', 'python'],
  ];
  cases.forEach(([input, kind, language], index) => {
    const report = migrateDeployment(
      { name: `mapping-${index + 1}`, enabled: true, ...input },
      { from: 'legacy-production' }
    );
    assert.equal(report.output.kind, kind);
    assert.equal(report.output.runtime.language, language);
    assert.equal(validateDeploymentSpecV2(report.output).valid, true);
  });
});
