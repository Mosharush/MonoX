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
    assert.match(html, /npm create monox@latest -- my-product --yes/);
    assert.match(html, /npx --yes corepack@0\.35\.0 yarn run dev:api/);
    assert.match(html, /npx --yes corepack@0\.35\.0 yarn run dev:web/);
    assert.doesNotMatch(html, /corepack enable|yarn install|yarn doctor|yarn dev --all/);
    assert.match(html, /What MonoX is not/);
    assert.match(html, /SoftwareSourceCode/);
    assert.match(html, /href="#quick-start"/);
    assert.match(html, /https:\/\/monox\.dev\/og-image\.png/);
    assert.match(html, /github\.com\/Mosharush\/MonoX/);
    assert.match(html, /https:\/\/monox\.dev\//);
    assert.doesNotMatch(html, /remaining release gate/i);

    const icon = await fetch(`${baseUrl}/icon.svg`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml');

    const socialImage = await fetch(`${baseUrl}/og-image.png`);
    assert.equal(socialImage.status, 200);
    assert.equal(socialImage.headers.get('content-type'), 'image/png');
    const socialImageBytes = new Uint8Array(await socialImage.arrayBuffer());
    assert(socialImageBytes.byteLength > 10_000);
    assert.deepEqual([...socialImageBytes.slice(1, 4)], [80, 78, 71]);
    const socialImageView = new DataView(socialImageBytes.buffer);
    assert.equal(socialImageView.getUint32(16), 1200);
    assert.equal(socialImageView.getUint32(20), 630);

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
