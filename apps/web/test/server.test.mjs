import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { startWebServer } from '../src/server.mjs';

test('serves the starter page and health endpoint', async () => {
  const server = await startWebServer({ host: '127.0.0.1', port: 0 });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(`${baseUrl}/?lang=en`);
    assert.equal(page.status, 200);
    const contentSecurityPolicy = page.headers.get('content-security-policy');
    assert(contentSecurityPolicy);
    assert.doesNotMatch(contentSecurityPolicy, /script-src 'none'/);
    assert.equal(page.headers.get('content-language'), 'en');
    const html = await page.text();
    const structuredData = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert(structuredData);
    assert.equal(JSON.parse(structuredData).version, '0.2.0');
    const structuredDataHash = `sha256-${createHash('sha256').update(structuredData).digest('base64')}`;
    assert(contentSecurityPolicy.includes(`'${structuredDataHash}'`));
    const nginxConfig = await readFile(new URL('../deploy/nginx/monox.dev.conf', import.meta.url), 'utf8');
    assert(nginxConfig.includes(`'${structuredDataHash}'`));
    assert.match(html, /Generate the product and its delivery path together/);
    assert.match(html, /What the command writes/);
    assert.match(html, /What you do not need to wire by hand/);
    assert.match(html, /npmjs\.com\/package\/create-monox/);
    assert.match(html, /npm create monox@latest -- my-product/);
    assert.match(html, /current stable release is <code>0\.2\.0<\/code>/);
    assert.match(html, /does not\s+install a public <code>monox<\/code> delivery binary/);
    assert.match(html, /yarn monox validate/);
    assert.doesNotMatch(html, /<span>monox validate<\/span>/);
    assert.doesNotMatch(html, /becomes available after|Until then/);
    assert.doesNotMatch(html, /0\.2\.0-alpha\.1|0\.2 alpha|monox@next/i);
    assert.match(html, /monox\.lock/);
    assert.match(html, /MonoX draws the boundary/);
    assert.match(html, /SoftwareSourceCode/);
    assert.match(html, /href="#command"/);
    assert.match(html, /https:\/\/monox\.dev\/og-image\.png\?v=0\.2\.0/);
    assert.match(html, /property="og:locale" content="en_US"/);
    assert.match(html, /property="og:locale:alternate" content="he_IL"/);
    assert.match(html, /github\.com\/Mosharush\/MonoX/);
    assert.match(html, /https:\/\/monox\.dev\//);
    assert.doesNotMatch(html, /infinite scale|unlimited capacity/i);
    assert.doesNotMatch(html, /\u2014/);

    const hebrewPage = await fetch(`${baseUrl}/?lang=he`);
    assert.equal(hebrewPage.status, 200);
    assert.equal(hebrewPage.headers.get('content-language'), 'he');
    const hebrewHtml = await hebrewPage.text();
    assert.match(hebrewHtml, /<html lang="he" dir="rtl">/);
    assert.match(hebrewHtml, /מה כבר לא צריך לחבר ידנית/);
    assert.match(hebrewHtml, /delivery path/);
    assert.match(hebrewHtml, /npm create monox@latest -- my-product/);
    assert.match(hebrewHtml, /ה-release היציב הנוכחי הוא <code>0\.2\.0<\/code>/);
    assert.match(hebrewHtml, /עדיין לא\s+מתקין <code>monox<\/code> delivery binary ציבורי/);
    assert.match(hebrewHtml, /yarn monox validate/);
    assert.doesNotMatch(hebrewHtml, /תהיה זמינה אחרי|עד אז/);
    assert.doesNotMatch(hebrewHtml, /0\.2\.0-alpha\.1|0\.2 alpha|monox@next/i);
    assert.match(hebrewHtml, /property="og:locale" content="he_IL"/);
    assert.match(hebrewHtml, /property="og:locale:alternate" content="en_US"/);
    assert.match(hebrewHtml, /name="twitter:image" content="https:\/\/monox\.dev\/og-image\.png\?v=0\.2\.0"/);
    assert.doesNotMatch(hebrewHtml, /\u2014/);

    const automaticHebrewPage = await fetch(baseUrl, { headers: { 'accept-language': 'he,en;q=0.8' } });
    assert.equal(automaticHebrewPage.headers.get('content-language'), 'he');

    const icon = await fetch(`${baseUrl}/icon.svg`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml');

    const socialImage = await fetch(`${baseUrl}/og-image.png?v=0.2.0`);
    assert.equal(socialImage.status, 200);
    assert.equal(socialImage.headers.get('content-type'), 'image/png');
    const socialImageBytes = new Uint8Array(await socialImage.arrayBuffer());
    assert(socialImageBytes.byteLength > 10_000);
    assert.deepEqual([...socialImageBytes.slice(1, 4)], [80, 78, 71]);
    const socialImageView = new DataView(socialImageBytes.buffer);
    assert.equal(socialImageView.getUint32(16), 1200);
    assert.equal(socialImageView.getUint32(20), 630);

    const [canonicalSocialImage, socialImageSource, readmeHeaderSource] = await Promise.all([
      readFile(new URL('../../../assets/brand/monox-og.png', import.meta.url)),
      readFile(new URL('../../../assets/brand/monox-og.svg', import.meta.url), 'utf8'),
      readFile(new URL('../../../assets/brand/monox-readme-header.svg', import.meta.url), 'utf8'),
    ]);
    assert.deepEqual(socialImageBytes, new Uint8Array(canonicalSocialImage));
    assert.match(socialImageSource, /npm create monox@latest/);
    assert.match(readmeHeaderSource, /npm create monox@latest/);
    assert.doesNotMatch(`${socialImageSource}\n${readmeHeaderSource}`, /monox@next|alpha create/i);

    const robots = await fetch(`${baseUrl}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /^text\/plain/);

    const sitemap = await fetch(`${baseUrl}/sitemap.xml`);
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type'), /^application\/xml/);

    const health = await fetch(`${baseUrl}/healthz`);
    assert.deepEqual(await health.json(), {
      name: '@monox/web',
      version: '0.2.0',
      ready: true,
      live: true,
      state: 'running',
    });

    const metrics = await fetch(`${baseUrl}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /monox_http_requests_total/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
