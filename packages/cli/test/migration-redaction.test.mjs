import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../src/index.mjs';

test('public legacy inventories redact nested identifiers, commands and values', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monox-migration-redaction-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'apps', 'private-service-marker'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
  await writeFile(
    path.join(root, 'apps', 'private-service-marker', 'package.json'),
    JSON.stringify({
      name: '@private/private-service-marker',
      deployment: {
        enabled: true,
        name: 'private-service-marker',
        type: 'node',
        serviceClass: 'critical-public',
        command: ['node', 'private-command-marker.mjs'],
        pre_stop: ['node', 'private-drain-marker.mjs'],
        public: true,
        domain: 'private-domain-marker.invalid',
        port: 3000,
        env: { PUBLIC_LABEL: 'private-env-value-marker' },
        workloadIdentity: { providerIdentity: 'private-identity-marker' },
        target: 'private-target-marker',
        hpa: { queue_name: 'private-queue-marker', average_value: 10 },
        sideDeployments: [
          {
            name: 'private-variant-marker',
            env: { VARIANT_LABEL: 'private-variant-value-marker' },
          },
        ],
        environments: {
          'private-environment-marker': {
            env: { ENVIRONMENT_LABEL: 'private-environment-value-marker' },
          },
        },
      },
    })
  );

  const result = await run(
    [
      'migrate',
      'deployment',
      '--from',
      'legacy-production',
      '--root',
      root,
      '--redact-identifiers',
      '--include-untracked',
    ],
    { cwd: root, stdout: { write() {} } }
  );
  const serialized = JSON.stringify(result.report);

  for (const marker of [
    'private-service-marker',
    'private-command-marker',
    'private-drain-marker',
    'private-domain-marker',
    'private-env-value-marker',
    'private-identity-marker',
    'private-target-marker',
    'private-queue-marker',
    'private-variant-marker',
    'private-variant-value-marker',
    'private-environment-marker',
    'private-environment-value-marker',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(marker));
  }

  const output = result.report.entries[0].report.output;
  assert.equal(output.id, 'workload-001');
  assert.deepEqual(Object.keys(output.variants), ['variant-001']);
  assert.deepEqual(Object.keys(output.environments), ['environment-001']);
  assert.equal(output.identity.automountServiceAccountToken, false);
  assert.deepEqual(output.env, { values: {}, secretRefs: [] });
  assert.ok(result.report.entries[0].report.manualReview.every((finding) => finding.path === '$.[redacted]'));
});
