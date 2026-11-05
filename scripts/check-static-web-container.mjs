import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:8080';
const sha = process.env.SOURCE_COMMIT;
assert.match(sha, /^[a-f0-9]{40}$/);
const request = (path, options = {}) =>
  fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(5000) });

for (const language of ['en', 'he']) {
  const page = await request(`/?lang=${language}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-language'), language);
  assert.match(await page.text(), new RegExp(`<html[^>]+lang="${language}"`));
}
const negotiated = await request('/', { headers: { 'accept-language': 'he,en;q=0.5' } });
assert.equal(negotiated.headers.get('content-language'), 'he');
const health = await request('/healthz');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: 'ok' });
const marker = await request('/deployment.json');
assert.equal(marker.status, 200);
assert.equal(marker.headers.get('cache-control'), 'no-store');
assert.equal(marker.headers.get('x-content-type-options'), 'nosniff');
assert.deepEqual(await marker.json(), { commit: sha });
for (const missing of ['/missing-file', '/package.json', '/.git/config', '/AGENTS.md']) {
  assert.equal((await request(missing)).status, 404);
}
console.log('Static web container languages, health, commit marker and file isolation passed.');
