import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPage, checkSite } from '../scripts/check-public-web.mjs';

const html = '<title>声のフリマ</title><meta name="voice-flea-release" content="2026.10.18-2"><section id="home"></section><nav id="nav"></nav>';
const page = { status: 200, url: 'https://koe-furima.com/', contentType: 'text/html; charset=utf-8', html };
test('public check rejects errors, stale HTML, redirects and non-app pages', () => {
  assert.equal(inspectPage(page, '2026.10.18-2').release, '2026.10.18-2');
  for (const changed of [{ status: 403 }, { contentType: 'application/json' }, { url: 'https://example.com/' }, { html: html.replace('2026.10.18-2', '2026.10.18-1') }, { html: '<title>Error</title>' }]) {
    assert.throws(() => inspectPage({ ...page, ...changed }, '2026.10.18-2'));
  }
});
test('temporary failure retries and persistent failure is reported without page content', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return { status: calls === 1 ? 503 : 200, url: page.url, headers: new Headers({ 'content-type': 'text/html' }), arrayBuffer: async () => new TextEncoder().encode(html).buffer }; };
  assert.equal((await checkSite(page.url, '2026.10.18-2', { fetcher, attempts: 2, delayMs: 0 })).release, '2026.10.18-2');
  assert.equal(calls, 2);
  const result = await checkSite(page.url, '2026.10.18-2', { fetcher: async () => { throw Error('network unavailable'); }, attempts: 1 });
  assert.equal(result.error, 'network unavailable');
  assert.equal('html' in result, false);
});
