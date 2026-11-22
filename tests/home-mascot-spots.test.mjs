import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'));

const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function cssRule(selector) {
  const idx = html.indexOf(selector + '{');
  assert.notEqual(idx, -1, `${selector} rule is missing`);
  return html.slice(idx, html.indexOf('}', idx) + 1);
}

/* --- 変更1: ヘッダー（グローバルページ移動バー）の空きにマスコット --- */

test('header mascot sits in the global page nav, before the back button, as pure decoration', () => {
  const navAt = html.indexOf('id="globalPageNav"');
  const mascotAt = html.indexOf('id="globalNavMascot"');
  const backAt = html.indexOf('id="globalBackBtn"');
  assert.ok(navAt !== -1 && mascotAt > navAt, 'mascot is inside the global page nav');
  assert.ok(mascotAt < backAt, 'mascot is the first item of the nav row');
  const tag = html.slice(html.lastIndexOf('<img', mascotAt), html.indexOf('>', mascotAt) + 1);
  assert.match(tag, /class="nav-mascot"/);
  assert.match(tag, /src="assets\/mascot\.webp"/);
  assert.match(tag, /alt=""/, 'decorative image keeps an empty alt');
  assert.match(tag, /aria-hidden="true"/);
  assert.match(tag, /\bhidden>/, 'mascot starts hidden until the home page is shown');
  assert.match(tag, /onerror="this\.remove\(\)"/, 'a failed load must not leave a broken image');
  assert.doesNotMatch(tag, /onclick/, 'mascot is not a tap target');
});

test('header mascot css keeps it small, cropped to the character and non-interactive', () => {
  const rule = cssRule('.nav-mascot');
  const width = Number(/width:(\d+)px/.exec(rule)[1]);
  assert.ok(width >= 72 && width <= 96, `header mascot width ${width}px stays within 72-96px`);
  assert.match(rule, /object-fit:cover/);
  assert.match(rule, /pointer-events:none/);
  assert.match(cssRule('.nav-mascot[hidden]'), /display:none!important/);
  assert.match(html, /@media\(max-width:390px\)\{\.nav-mascot\{width:72px;height:72px\}\}/, 'narrow screens shrink the mascot');
});

function navContext(currentUser) {
  const classes = new Set();
  const bar = {classList: {toggle: (name, force) => (force ? classes.add(name) : classes.delete(name))}};
  const back = {hidden: false};
  const mascot = {hidden: true};
  const byId = {globalPageNav: bar, globalBackBtn: back, globalNavMascot: mascot};
  const start = html.indexOf('function updateGlobalPageNav(');
  const source = html.slice(start, html.indexOf('\n', start));
  const context = vm.createContext({document: {getElementById: id => byId[id] ?? null}, currentUser});
  vm.runInContext(source, context);
  return {context, classes, back, mascot};
}

test('global page nav shows the mascot only on the home page', () => {
  const {context, classes, back, mascot} = navContext({id: 'me'});
  context.updateGlobalPageNav('home');
  assert.equal(mascot.hidden, false, 'mascot appears on home');
  assert.equal(back.hidden, true, 'back button stays hidden on home');
  assert.equal(classes.has('show'), true, 'bar itself shows for a signed-in user');

  context.updateGlobalPageNav('voices');
  assert.equal(mascot.hidden, true, 'mascot hides away from home');
  assert.equal(back.hidden, false, 'back button returns away from home');

  const signedOut = navContext(null);
  signedOut.context.updateGlobalPageNav('home');
  assert.equal(signedOut.classes.has('show'), false, 'bar (and mascot) stay hidden before sign-in');
});

/* --- 変更2: ブースト帯の末尾にPRカード --- */

const helpers = html.slice(html.indexOf('function profileAvatarUrl('), html.indexOf('function avatarMarkup('));
const stripSource = html.slice(html.indexOf('const HOME_BOOST_STRIP_LIMIT'), html.indexOf('function updateSellFeePreview'));

function stripContext({rpcResult} = {}) {
  const classes = new Set(['home-boost-strip', 'hide']);
  const stripEl = {
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    },
  };
  const scrollEl = {innerHTML: ''};
  const context = vm.createContext({
    esc,
    console,
    currentUser: {id: 'me'},
    listingDetailCache: new Map(),
    document: {getElementById: id => (id === 'homeBoostStrip' ? stripEl : id === 'homeBoostScroll' ? scrollEl : null)},
    isPurchasedListingHidden: () => false,
    loadListingPurchaseRows: async () => [],
    listingPurchaseReadiness: () => ({purchased: false, authorized: false, blocked: false, reason: ''}),
    sb: {
      rpc: async () => rpcResult,
      storage: {
        from: bucket => ({
          getPublicUrl: path => ({data: {publicUrl: `https://cdn.example/${bucket}/${path}`}}),
        }),
      },
    },
  });
  vm.runInContext(helpers + stripSource, context);
  return {context, scrollEl, classes};
}

const row = (id, boostPlan, createdAt) => ({
  id,
  title: `出品 ${id}`,
  price_jpy: 1000,
  seller_id: 'seller1',
  created_at: createdAt,
  boost_plan: boostPlan,
  image_path: null,
  profiles: {display_name: '出品者', avatar_path: null},
});

test('boost promo card carries the mascot, the approved copy and the boost dialog action', () => {
  const {context} = stripContext({rpcResult: {data: {rows: []}, error: null}});
  const promo = context.homeBoostPromoCardHtml();
  assert.match(promo, /home-boost-card home-boost-promo/);
  assert.match(promo, /<img class="boost-promo-mascot" src="assets\/mascot\.webp"/);
  assert.match(promo, /あなたの出品もここに流れます/);
  assert.match(promo, /ブーストでホームにPR/);
  assert.match(promo, /onclick="openBoostPreview\(\)"/, 'tap opens the existing boost purchase dialog');
});

test('loader appends the promo card at the end of the strip when boosts exist', async () => {
  const rows = [row('gold1', 'gold', '2026-11-10T00:00:00Z'), row('plat1', 'platinum', '2026-11-01T00:00:00Z')];
  const {context, scrollEl, classes} = stripContext({rpcResult: {data: {rows, total: 2, rotation_epoch: 1}, error: null}});
  await context.loadHomeBoostStrip();
  assert.equal(classes.has('hide'), false);
  const promoAt = scrollEl.innerHTML.indexOf('あなたの出品もここに流れます');
  assert.ok(promoAt > scrollEl.innerHTML.indexOf('出品 gold1'), 'promo card renders after the listing cards');
  assert.ok(promoAt > scrollEl.innerHTML.indexOf('出品 plat1'), 'promo card is the last card of the strip');
});

test('loader keeps the strip (and the promo card) hidden when no boost is active', async () => {
  const rows = [row('plain', null, '2026-11-20T00:00:00Z')];
  const {context, scrollEl, classes} = stripContext({rpcResult: {data: {rows, total: 1, rotation_epoch: 1}, error: null}});
  await context.loadHomeBoostStrip();
  assert.equal(classes.has('hide'), true);
  assert.equal(scrollEl.innerHTML, '', 'no promo card without an active boost');
});

test('boost promo card styles match the strip cards and center the mascot', () => {
  const promo = cssRule('.home-boost-promo');
  assert.match(promo, /text-align:center/);
  const mascot = cssRule('.boost-promo-mascot');
  assert.match(mascot, /width:88px/);
  assert.match(mascot, /object-fit:cover/);
});

/* --- リリースラベル --- */

test('release label and manifest point at the home mascot spots build', () => {
  assert.match(html, /<meta name="voice-flea-release" content="2026\.11\.22-home-mascot-spots">/);
  assert.equal(manifest.release, '2026.11.22-home-mascot-spots');
  const digest = createHash('sha256').update(readFileSync(new URL('../index.html', import.meta.url))).digest('hex');
  assert.equal(manifest.web_sha256, digest, 'manifest web_sha256 matches index.html');
});
