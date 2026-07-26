import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migrateDeployment } from '../../src/migration.mjs';

const fixtureFile = new URL('./migration-cases.json', import.meta.url);
const cases = JSON.parse(await readFile(fixtureFile, 'utf8'));

function pointerValue(value, pointer) {
  assert.match(pointer, /^\//, `Invalid fixture pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((current, part) => current?.[part], value);
}

for (const fixture of cases) {
  test(`legacy migration golden: ${fixture.name}`, () => {
    const report = migrateDeployment(fixture.input, { from: 'legacy-production' });

    for (const [pointer, expected] of Object.entries(fixture.expected)) {
      assert.deepEqual(pointerValue(report, pointer), expected, pointer);
    }

    assert.deepEqual(
      report.manualReview.map((finding) => finding.code),
      fixture.manualReviewCodes
    );

    for (const action of fixture.changeActions ?? []) {
      assert.equal(
        report.changes.some((change) => change.action === action),
        true,
        `missing ${action} change record`
      );
    }

    assert.equal(report.output.schemaVersion, '2');
    assert.equal(report.output.enabled, true);
    assert.doesNotMatch(JSON.stringify(report), /example\.com|AKIA|PRIVATE KEY/);
  });
}
