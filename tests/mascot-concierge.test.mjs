import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'));

function cssRule(selector) {
  const idx = html.indexOf(selector + '{');
  assert.notEqual(idx, -1, `${selector} rule is missing`);
  return html.slice(idx, html.indexOf('}', idx) + 1);
}

function conciergeRows() {
  const rows = [];
  let at = html.indexOf('<div class="concierge">');
  while (at !== -1) {
    const end = html.indexOf('</div></div>', at);
    rows.push({at, markup: html.slice(at, end + '</div></div>'.length)});
    at = html.indexOf('<div class="concierge">', at + 1);
  }
  return rows;
}

/* --- 共通コンポーネント --- */

test('concierge component css is a small mascot plus speech-bubble row', () => {
  const row = cssRule('.concierge');
  assert.match(row, /display:flex/);
  const img = cssRule('.concierge-img');
  const size = Number(/width:(\d+)px/.exec(img)[1]);
  assert.ok(size >= 48 && size <= 64, `concierge mascot ${size}px stays within 48-64px`);
  assert.match(img, /object-fit:cover/);
  assert.match(img, /border-radius:50%/);
  assert.match(img, /pointer-events:none/, 'mascot image is decoration, not a tap target');
  const bubble = cssRule('.concierge-bubble');
  assert.match(bubble, /background:#fff/);
  assert.match(bubble, /border:1px solid #[0-9a-f]{6}/, 'bubble uses a thin light border');
  assert.match(html, /\.concierge-bubble::before\{[^}]*transform:rotate\(45deg\)/, 'bubble has the small triangle tail');
  assert.match(cssRule('.concierge-name'), /font-weight:700/, 'the bubble carries the ララ name label');
});

test('every concierge row reuses the shared markup and the bundled mascot', () => {
  const rows = conciergeRows();
  assert.equal(rows.length, 10, 'concierge appears in the 8 spots from PR #73 plus jobs and mypage');
  for (const {markup} of rows) {
    const imgTag = markup.slice(markup.indexOf('<img'), markup.indexOf('>', markup.indexOf('<img')) + 1);
    assert.match(imgTag, /class="concierge-img"/);
    assert.match(imgTag, /src="assets\/mascot\.webp"/, 'reuses the bundled mascot image');
    assert.match(imgTag, /alt=""/, 'mascot image is decorative');
    assert.match(imgTag, /aria-hidden="true"/);
    assert.match(imgTag, /onerror="this\.remove\(\)"/, 'a failed load must not leave a broken image');
    assert.doesNotMatch(imgTag, /onclick/, 'mascot is not a tap target');
    assert.match(markup, /<div class="concierge-bubble"><span class="concierge-name">ララ<\/span>[^<]{10,}/,
      'bubble shows the ララ name and a readable guidance text');
  }
});

/* --- 配置: 購入フローと出品フローの導入部 --- */

test('purchase flow intro: concierge greets at the top of the voices page', () => {
  const pageAt = html.indexOf('<section id="voices" class="page">');
  const rowAt = html.indexOf('<div class="concierge">', pageAt);
  const guideAt = html.indexOf('<details class="purchase-guide">', pageAt);
  assert.ok(pageAt !== -1 && rowAt > pageAt && rowAt < guideAt,
    'concierge sits between the voices heading and the purchase guide');
  const row = conciergeRows().find(r => r.at === rowAt);
  assert.match(row.markup, /サンプルを聴いて/, 'purchase intro points at listening to samples first');
});

test('sell flow intro: concierge greets at the top of the sell form', () => {
  const pageAt = html.indexOf('<section id="sell" class="page">');
  const rowAt = html.indexOf('<div class="concierge">', pageAt);
  const noticeAt = html.indexOf('<div class="notice">', pageAt);
  assert.ok(pageAt !== -1 && rowAt > pageAt && rowAt < noticeAt,
    'concierge sits between the sell heading and the fee notice, at the top of the form');
  const row = conciergeRows().find(r => r.at === rowAt);
  assert.match(row.markup, /タイトルとサンプル音声/, 'sell intro points at title and sample');
});

/* --- 配置: 使い方ページ --- */

function manualSection(title) {
  const at = html.indexOf(`<b>${title}</b>`);
  assert.notEqual(at, -1, `manual section ${title} exists`);
  const next = html.indexOf('<div class="manual-section">', at + 1);
  return {at, body: html.slice(at, next === -1 ? at + 4000 : next)};
}

test('guide welcome: ララ introduces herself at the top of the manual start block', () => {
  const startAt = html.indexOf('<div class="manual-start">');
  const rowAt = html.indexOf('<div class="concierge">', startAt);
  const headAt = html.indexOf('<h4>まずは、やりたいことから</h4>', startAt);
  assert.ok(startAt !== -1 && rowAt > startAt && rowAt < headAt,
    'concierge is the first thing inside the manual start block');
  const row = conciergeRows().find(r => r.at === rowAt);
  assert.match(row.markup, /案内役のララです/, 'welcome line introduces ララ as the guide');
});

test('guide sections carry a concierge line between the title and the body text', () => {
  const expected = [
    ['🎧 声を探す・購入', /絞り込むこともできます/],
    ['🛒 声を購入する', /決済が確定します/],
    ['💬 メッセージ・取引をする', /長押しで取り消しもできます/],
    ['🎙️ 声を出品する', /AI利用条件もあわせて登録します/],
    ['🚀 出品ブースト', /3種類があります/],
  ];
  for (const [title, line] of expected) {
    const {body} = manualSection(title);
    const rowAt = body.indexOf('<div class="concierge">');
    const textAt = body.indexOf('<p>');
    assert.ok(rowAt !== -1 && rowAt < textAt, `${title}: concierge sits at the head of the section`);
    assert.match(body, line, `${title}: concierge line summarises the section`);
  }
});

test('concierge stays out of the other overlays and pages', () => {
  for (const overlay of ['id="financeOverlay"', 'id="notifOverlay"', 'id="rulesOverlay"', 'id="safetyOverlay"', 'id="listingDetailOverlay"']) {
    const at = html.indexOf(overlay);
    assert.notEqual(at, -1, `${overlay} exists`);
    const end = html.indexOf('<div id=', at + 10);
    const block = html.slice(at, end === -1 ? at + 6000 : end);
    assert.doesNotMatch(block, /class="concierge"/, `${overlay} has no concierge`);
  }
});

/* --- リリース整合 --- */

test('release label and manifest point at the concierge more-pages build', () => {
  assert.match(html, /<meta name="voice-flea-release" content="2026\.11\.22-concierge-more-pages">/);
  assert.equal(manifest.release, '2026.11.22-concierge-more-pages');
  const digest = createHash('sha256').update(readFileSync(new URL('../index.html', import.meta.url))).digest('hex');
  assert.equal(manifest.web_sha256, digest, 'manifest web_sha256 matches index.html');
});
