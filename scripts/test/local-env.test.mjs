import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createLocalEnvironment } from '../local-env.mjs';
import { withTempDirectory } from '../../packages/test-utils/src/index.mjs';

test('creates random local secrets once with owner-only permissions', async () => {
  await withTempDirectory(
    async (directory) => {
      const output = path.join(directory, '.env');
      await createLocalEnvironment(output);
      const contents = await readFile(output, 'utf8');
      assert.match(contents, /^POSTGRES_PASSWORD=[A-Za-z0-9_-]{40,}$/m);
      assert.match(contents, /^REDIS_PASSWORD=[A-Za-z0-9_-]{40,}$/m);
      assert.doesNotMatch(contents, /local-development-only|change-me/i);
      assert.equal((await stat(output)).mode & 0o777, 0o600);
      await assert.rejects(() => createLocalEnvironment(output), /Refusing to overwrite/);
    },
    { prefix: 'monox-local-env-' }
  );
});
