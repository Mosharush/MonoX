import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('static container keeps structured data allowed and deployment hosts external', async () => {
  const config = await readFile(new URL('../deploy/container/nginx.conf', import.meta.url), 'utf8');
  for (const filename of ['index.html', 'index.he.html']) {
    const html = await readFile(new URL(`../public/${filename}`, import.meta.url), 'utf8');
    for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const hash = createHash('sha256').update(match[1]).digest('base64');
      assert(config.includes(`'sha256-${hash}'`), `${filename} structured data must pass the CSP`);
    }
  }
  assert.match(config, /server_name _;/);
  assert.match(config, /root \/usr\/share\/nginx\/html;/);
  assert.doesNotMatch(config, /ssl_certificate|\/home\/|https?:\/\//);
});
