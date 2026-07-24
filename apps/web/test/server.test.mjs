import assert from 'node:assert/strict';
import test from 'node:test';

import { startWebServer } from '../src/server.mjs';

test('serves the starter page and health endpoint', async () => {
  const server = await startWebServer({ host: '127.0.0.1', port: 0 });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'none'/);
    const html = await page.text();
    assert.match(html, /Explicit boundaries/);
    assert.match(html, /Node 22 \/ 24 \/ 26/);
    assert.match(html, /Public CI still runs repository rules/);
    assert.match(html, /npmjs\.com\/package\/create-monox/);
    assert.match(html, /href="#delivery-contract"/);
    assert.match(html, /npm create monox@latest -- my-product --yes/);
    assert.match(html, /What MonoX is not/);
    assert.match(html, /SoftwareSourceCode/);
    assert.match(html, /href="#quick-start"/);
    assert.match(html, /github\.com\/Mosharush\/MonoX/);
    assert.match(html, /https:\/\/monox\.dev\//);
    assert.doesNotMatch(html, /remaining release gate/i);

    const icon = await fetch(`${baseUrl}/icon.svg`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml');

    const robots = await fetch(`${baseUrl}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /^text\/plain/);

    const sitemap = await fetch(`${baseUrl}/sitemap.xml`);
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type'), /^application\/xml/);

    const health = await fetch(`${baseUrl}/healthz`);
    assert.deepEqual(await health.json(), { status: 'ok' });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
