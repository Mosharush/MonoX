import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateAffected } from '../src/index.mjs';

const workspaces = [
  {
    name: '@monox/shared',
    location: 'packages/shared',
    manifest: {},
  },
  {
    name: '@monox/api',
    location: 'apps/api',
    manifest: { dependencies: { '@monox/shared': 'workspace:^' } },
  },
  {
    name: '@monox/web',
    location: 'apps/web',
    manifest: { dependencies: { '@monox/shared': 'workspace:^' } },
  },
];

test('propagates package changes to transitive dependents', () => {
  assert.deepEqual(calculateAffected(workspaces, ['packages/shared/src/index.mjs']), [
    '@monox/api',
    '@monox/shared',
    '@monox/web',
  ]);
});

test('keeps an application-only change focused', () => {
  assert.deepEqual(calculateAffected(workspaces, ['apps/api/src/server.mjs']), ['@monox/api']);
});

test('treats root contracts and failed git comparison as affecting all workspaces', () => {
  assert.deepEqual(calculateAffected(workspaces, ['monox.config.json']), [
    '@monox/api',
    '@monox/shared',
    '@monox/web',
  ]);
  assert.deepEqual(calculateAffected(workspaces, [], { failOpen: true }), [
    '@monox/api',
    '@monox/shared',
    '@monox/web',
  ]);
});
