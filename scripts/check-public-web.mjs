import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const sites = ['https://koe-furima.com/', 'https://voice-flea-market.pages.dev/'];

export function inspectPage({ status, url, contentType, html }, expectedRelease) {
  if (status !== 200) throw Error(`HTTP ${status}`);
  const finalUrl = new URL(url);
  if (finalUrl.protocol !== 'https:' || !sites.some(s => new URL(s).host === finalUrl.host)) throw Error('Unexpected redirect destination');
  if (!contentType?.includes('text/html')) throw Error('Expected HTML');
  if (!/<title>声のフリマ<\/title>/.test(html)) throw Error('App title missing');
  const release = html.match(/<meta\b[^>]*name=["']voice-flea-release["'][^>]*content=["']([^"']+)["']/i)?.[1];
  if (release !== expectedRelease) throw Error(`Expected release ${expectedRelease}; received ${release || 'none'}`);
  if (!/id=["']home["']/.test(html) || !/id=["']nav["']/.test(html)) throw Error('App shell missing');
  return { url: finalUrl.href, status, release };
}

export async function checkSite(url, expectedRelease, { fetcher = fetch, attempts = 3, delayMs = 5000 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 2 * 1024 * 1024) throw Error('Unexpected page size');
      return inspectPage({ status: response.status, url: response.url, contentType: response.headers.get('content-type'), html: new TextDecoder().decode(bytes) }, expectedRelease);
    } catch (error) {
      lastError = error;
      if (i + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return { url, error: lastError.message };
}

async function main() {
  const { release } = JSON.parse(readFileSync('release-manifest.json', 'utf8'));
  // A push can precede the Pages deployment; scheduled runs need fewer retries.
  const options = process.env.GITHUB_EVENT_NAME === 'push' ? { attempts: 8, delayMs: 15000 } : {};
  const results = await Promise.all(sites.map(url => checkSite(url, release, options)));
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), expectedRelease: release, results }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map(r => `| ${r.url} | ${r.error ? 'FAIL' : 'PASS'} | ${r.error || r.release} |`).join('\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 公開Webの確認\n\n期待する版: ${release}\n\n| URL | 結果 | 詳細 |\n| --- | --- | --- |\n${rows}\n\n表示と版の読み取り確認です。ログイン・実機・決済の検証ではありません。\n`);
  }
  if (results.some(r => r.error)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
