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

/* --- 変更1: 更新ボタンの削除（プル更新が前提） --- */

test('refresh button is removed from the header actions', () => {
  assert.doesNotMatch(html, /<button id="refreshBtn"/, 'no refresh button element remains');
  assert.doesNotMatch(html, /id="refreshBtn" class="refreshbtn hide" onclick/, 'the old button markup is gone');
  assert.ok(!html.includes("['nav','refreshBtn'"), 'logout hide list no longer references the removed button');
  assert.ok(!html.includes("['refreshBtn','bellBtn','menuBtn']"), 'login show list no longer references the removed button');
});

test('pull-to-refresh is implemented and drives the same reload as the old button', () => {
  // Indicator element + styles.
  assert.match(html, /<div id="pullRefreshIndicator" class="pull-refresh-indicator">↓ 引っ張って更新<\/div>/);
  assert.match(cssRule('.pull-refresh-indicator'), /position:fixed/);
  assert.match(cssRule('.pull-refresh-indicator.refreshing'), /opacity:1/, 'a refreshing state is styled');
  // Gesture handling on the app scroller with a threshold and a "refreshing" label.
  const setup = html.slice(html.indexOf('(function setupPullToRefresh(){'), html.indexOf('window.addEventListener(\'pageshow\'', html.indexOf('(function setupPullToRefresh(){')));
  assert.match(setup, /addEventListener\('touchstart'/);
  assert.match(setup, /addEventListener\('touchmove'/);
  assert.match(setup, /addEventListener\('touchend'/);
  assert.match(setup, /THRESHOLD=72/, 'the pull must pass a threshold before refreshing');
  assert.match(setup, /hint\.textContent='↻ 更新中…'/, 'pulling shows the refreshing state the user described');
  assert.match(setup, /await refreshAllData\(\)/, 'the gesture reloads through refreshAllData');
  // The reload entry point itself survives the button removal.
  assert.match(html, /async function refreshAllData\(\)\{/);
});

/* --- 変更2: ボタン群をララの横（右カラム）に集約 --- */

test('brand stays alone on the top row', () => {
  const topbar = html.slice(html.indexOf('<div class="topbar">'), html.indexOf('<div class="header-nav-zone">'));
  assert.match(topbar, /class="brandwrap"/);
  assert.match(topbar, /class="brand">声のフリマ</);
  assert.doesNotMatch(topbar, /class="topactions"/, 'no action buttons remain next to the brand');
  assert.doesNotMatch(topbar, /id="globalPageNav"/, 'the page nav moved out of the brand row');
});

test('header nav zone puts the mascot left and stacks actions over the page nav on the right', () => {
  const zoneAt = html.indexOf('<div class="header-nav-zone">');
  const mascotAt = html.indexOf('id="globalNavMascot"', zoneAt);
  const mainAt = html.indexOf('<div class="header-nav-main">', zoneAt);
  const actionsAt = html.indexOf('<div class="topactions">', mainAt);
  const navAt = html.indexOf('id="globalPageNav"', mainAt);
  assert.ok(zoneAt !== -1 && mascotAt > zoneAt, 'zone opens with the mascot');
  assert.ok(mainAt > mascotAt, 'the right column follows the mascot');
  assert.ok(actionsAt > mainAt && navAt > actionsAt, 'icon actions stack above the page nav inside the right column');

  const zone = cssRule('.header-nav-zone');
  assert.match(zone, /display:flex/, 'zone is a row: mascot beside the column');
  assert.match(zone, /align-items:center/);
  const main = cssRule('.header-nav-main');
  assert.match(main, /flex:1 1 auto/, 'the column takes the remaining width');
  assert.match(main, /flex-direction:column/, 'the column stacks its two rows');
  assert.match(html, /body:has\(#authPage\.on\) \.header-nav-zone\{display:none\}/,
    'the whole zone hides on the auth screen, like the actions did before');
});

test('right column keeps exactly the bell, favorite and menu buttons with badges', () => {
  const main = html.slice(html.indexOf('<div class="header-nav-main">'), html.indexOf('<div id="globalPageNav"'));
  const bellAt = main.indexOf('id="bellBtn"');
  const favAt = main.indexOf('id="favoriteBtn"');
  const menuAt = main.indexOf('id="menuBtn"');
  assert.ok(bellAt !== -1 && favAt > bellAt && menuAt > favAt, 'bell, favorite, menu in that order');
  assert.match(main, /id="bellBtn"[^>]*onclick="openNotifications\(\)"/);
  assert.match(main, /id="bellBadge" class="bellbadge"/, 'notification badge stays on the bell');
  assert.match(main, /id="favoriteBtn"[^>]*onclick="openFavorites\(\)"/);
  assert.match(main, /id="favoriteBadge" class="bellbadge"/, 'favorite badge stays on the heart');
  assert.match(main, /id="menuBtn"[^>]*onclick="openMainMenu\(\)"/);
  assert.equal((main.match(/class="bellbtn hide"/g) || []).length, 3, 'exactly three action buttons');
});

test('page nav keeps its buttons and right-grouped home/guide inside the column', () => {
  const nav = html.slice(html.indexOf('id="globalPageNav"'), html.indexOf('</div>', html.indexOf('id="globalPageNav"')));
  assert.match(nav, /id="globalBackBtn"[^>]*onclick="goBackPage\(\)"|onclick="goBackPage\(\)" id="globalBackBtn"/);
  assert.match(nav, /onclick="goHomeNow\(\)"/);
  assert.match(nav, /onclick="openManualCenter\(\)"/);
  assert.match(cssRule('.global-page-nav .global-home-btn'), /margin-left:auto/,
    'home/guide stay grouped on the right of the nav row');
  // Mascot visibility logic is untouched: home-only, driven by updateGlobalPageNav.
  assert.match(html, /navMascot\.hidden=id!=='home'/, 'mascot still shows only on home');
  assert.match(html, /bar\.classList\.toggle\('show',!!currentUser&&id!=='messages'\)/,
    'page nav visibility rule is unchanged');
});

/* --- リリースラベル --- */

test('release label and manifest point at the header layout2 build', () => {
  assert.match(html, /<meta name="voice-flea-release" content="2026\.11\.22-header-layout2">/);
  assert.equal(manifest.release, '2026.11.22-header-layout2');
  const digest = createHash('sha256').update(readFileSync(new URL('../index.html', import.meta.url))).digest('hex');
  assert.equal(manifest.web_sha256, digest, 'manifest web_sha256 matches index.html');
});
