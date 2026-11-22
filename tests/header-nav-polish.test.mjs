import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function cssRule(selector) {
  const idx = html.indexOf(selector + '{');
  assert.notEqual(idx, -1, `${selector} rule is missing`);
  return html.slice(idx, html.indexOf('}', idx) + 1);
}

/* --- 変更1: ページナビのララを全身表示＋少し内側へ --- */

test('full-body mascot asset is a real webp cropped from the bundled mascot', () => {
  const asset = readFileSync(new URL('../assets/mascot-full.webp', import.meta.url));
  assert.equal(asset.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(asset.subarray(8, 12).toString('ascii'), 'WEBP');
  assert.ok(asset.length > 5_000 && asset.length < 60_000, 'full-body asset stays small');
  assert.ok(pkg.scripts.build.includes('cp assets/mascot-full.webp www/assets/mascot-full.webp'),
    'build must copy the full-body asset next to www/index.html so cap sync bundles it');
  assert.ok(pkg.scripts.build.includes('cp assets/mascot.webp www/assets/mascot.webp'),
    'the face-crop asset stays bundled for the concierge and heading icons');
});

test('nav mascot uses the full-body asset with a contain fit and a left inset', () => {
  const tagAt = html.indexOf('id="globalNavMascot"');
  const tag = html.slice(html.lastIndexOf('<img', tagAt), html.indexOf('>', tagAt) + 1);
  assert.match(tag, /src="assets\/mascot-full\.webp"/);
  const rule = cssRule('.nav-mascot');
  assert.match(rule, /height:92px/);
  assert.match(rule, /object-fit:contain/, 'no cover crop: the shoes stay in frame');
  assert.match(rule, /margin-left:12px/, 'mascot is inset from the left edge, not flush against it');
});

/* --- 変更2: ページナビのボタンを少し大きく、右寄せグループのまま --- */

test('page nav buttons get a larger tap area without stretching full width', () => {
  const rule = cssRule('.global-page-nav button');
  assert.match(rule, /min-height:48px/);
  assert.match(rule, /padding:0 20px/);
  assert.match(rule, /font-size:14px/);
  assert.doesNotMatch(rule, /flex:1/, 'nav buttons keep their natural width');
  assert.match(cssRule('.global-page-nav .global-home-btn'), /margin-left:auto/,
    'home/guide stay grouped on the right via the home button auto margin');
  assert.match(html, /@media\(max-width:430px\)\{\.global-page-nav\{margin-top:0;margin-bottom:8px\}\.global-page-nav button\{min-height:44px;padding:0 16px;font-size:13px\}\}/,
    'narrow screens keep a slightly larger tap area too');
  const nav = html.slice(html.indexOf('id="globalPageNav"'), html.indexOf('</div>', html.indexOf('id="globalPageNav"')));
  assert.match(nav, /onclick="goBackPage\(\)"/);
  assert.match(nav, /onclick="goHomeNow\(\)"/);
  assert.match(nav, /onclick="openManualCenter\(\)"/, 'nav button actions are unchanged');
});

/* --- 変更3: ヘッダーの4アイコンボタンを横長に統一 --- */

test('header action buttons share the row width equally as wide white buttons', () => {
  assert.match(cssRule('body.normal-mode .topbar .topactions'), /width:100%/,
    'the action row spans the full header width');
  const rule = cssRule('body.normal-mode .topactions .refreshbtn,body.normal-mode .topactions .bellbtn');
  assert.match(rule, /flex:1 1 0/, 'the four buttons divide the row equally');
  assert.match(rule, /height:48px!important/);
  assert.match(rule, /width:auto!important/, 'fixed square widths are released');
  assert.match(rule, /min-width:0!important/);
  assert.match(rule, /font-size:22px!important/, 'icons grow slightly');
  assert.match(rule, /background:#fff!important/, 'plain white background matches the page nav buttons');
});

test('header buttons keep their actions and notification badges', () => {
  const bar = html.slice(html.indexOf('<div class="topbar">'), html.indexOf('<div id="globalPageNav"'));
  assert.match(bar, /id="refreshBtn"[^>]*onclick="refreshAllData\(\)"/);
  assert.match(bar, /id="bellBtn"[^>]*onclick="openNotifications\(\)"/);
  assert.match(bar, /id="bellBadge" class="bellbadge"/, 'notification count badge stays on the bell button');
  assert.match(bar, /id="favoriteBtn"[^>]*onclick="openFavorites\(\)"/);
  assert.match(bar, /id="favoriteBadge" class="bellbadge"/, 'favorite count badge stays on the heart button');
  assert.match(bar, /id="menuBtn"[^>]*onclick="openMainMenu\(\)"/);
  const badge = cssRule('.bellbadge');
  assert.match(badge, /position:absolute/);
  assert.match(badge, /top:-5px/);
  assert.match(badge, /right:-5px/, 'badges still sit on each button corner');
});

/* --- 変更4: 「立っているララ」は全身に統一、小さな顔アイコンは据え置き --- */

test('standing mascot spots use the full-body asset', () => {
  const helper = html.slice(html.indexOf('function mascotImg('), html.indexOf('function mascotEmpty('));
  assert.match(helper, /src="assets\/mascot-full\.webp"/, 'empty states show the full body');
  assert.match(html, /<img class="boost-promo-mascot" src="assets\/mascot-full\.webp"/,
    'the boost strip promo card shows the full body');
});

test('small round face icons keep the face crop asset', () => {
  assert.match(html, /<img class="concierge-img" src="assets\/mascot\.webp"/, 'concierge avatar is unchanged');
  const concierge = cssRule('.concierge-img');
  assert.match(concierge, /width:56px/);
  assert.match(concierge, /border-radius:50%/);
  assert.match(html, /<img class="head-mascot" src="assets\/mascot\.webp"/, 'favorites heading icon is unchanged');
  const head = cssRule('.head-mascot');
  assert.match(head, /width:42px/);
  assert.match(head, /border-radius:50%/);
});

/* --- 追加: ヘッダーのキャッチコピー2行目が行ボックスで切れないこと --- */

test('header catchcopy line 2 keeps enough room for its gradient-clipped glyphs', () => {
  // Line 2 is painted via background-clip:text, so any glyph ink outside the
  // element box has no background to show and disappears (iOS WebKit).
  assert.match(html, /\.tag \.line2\{[^}]*-webkit-background-clip:text[^}]*color:transparent/,
    'line 2 is the gradient-clipped line this fix protects');
  const tag = cssRule('body.normal-mode .tag');
  const lh = Number(/line-height:([\d.]+)!important/.exec(tag)[1]);
  assert.ok(lh >= 1.3, `tag line-height ${lh} exceeds the system font ascent+descent (~1.2em)`);
  assert.match(html, /body\.normal-mode \.tag \.line2\{margin-top:3px!important;padding-bottom:\.14em!important\}/,
    'line 2 gets extra painting room below the baseline');
  const brand = cssRule('body.normal-mode .brand');
  assert.match(brand, /line-height:1\.1!important/, 'the gradient title line box is taller than 1em');
  const brandtext = cssRule('body.normal-mode .brandtext');
  assert.match(brandtext, /overflow:visible!important/, 'no clipping ancestor on the brand text');
});

/* --- リリースラベル --- */

test('release label and manifest point at the header nav polish build', () => {
  assert.match(html, /<meta name="voice-flea-release" content="2026\.11\.22-header-nav-polish">/);
  assert.equal(manifest.release, '2026.11.22-header-nav-polish');
  const digest = createHash('sha256').update(readFileSync(new URL('../index.html', import.meta.url))).digest('hex');
  assert.equal(manifest.web_sha256, digest, 'manifest web_sha256 matches index.html');
});
