import assert from 'node:assert/strict';
import test from 'node:test';

import { satisfiesNodeVersionRange } from './node-version-range.mjs';

const range = '>=22.22.2 <23.0.0 || >=24.15.0 <25.0.0 || >=26.0.0 <27.0.0';

test('accepts every supported Node.js line at or above its tested floor', () => {
  for (const version of ['22.22.2', '22.99.0', '24.15.0', '24.99.0', '26.0.0', '26.8.1']) {
    assert.equal(satisfiesNodeVersionRange(version, range), true, version);
  }
});

test('rejects older patches, odd-numbered lines, and untested future majors', () => {
  for (const version of ['22.22.1', '23.0.0', '24.14.9', '25.9.0', '27.0.0']) {
    assert.equal(satisfiesNodeVersionRange(version, range), false, version);
  }
});

test('rejects malformed versions and unsupported comparator syntax', () => {
  assert.throws(() => satisfiesNodeVersionRange('current', range), /Invalid Node.js version/);
  assert.throws(() => satisfiesNodeVersionRange('26.0.0', '^26.0.0'), /Unsupported/);
});
