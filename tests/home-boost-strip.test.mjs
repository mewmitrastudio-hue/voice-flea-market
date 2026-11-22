import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const helpers = html.slice(html.indexOf('function profileAvatarUrl('), html.indexOf('function avatarMarkup('));
const stripSource = html.slice(html.indexOf('const HOME_BOOST_STRIP_LIMIT'), html.indexOf('function updateSellFeePreview'));

function stripContext({rpcResult, hiddenIds = new Set()} = {}) {
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
    isPurchasedListingHidden: id => hiddenIds.has(id),
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
  return {context, stripEl, scrollEl, classes};
}

const row = (id, boostPlan, createdAt, extra = {}) => ({
  id,
  title: `出品 ${id}`,
  price_jpy: 1000,
  seller_id: 'seller1',
  created_at: createdAt,
  boost_plan: boostPlan,
  image_path: null,
  profiles: {display_name: '出品者', avatar_path: null},
  ...extra,
});

test('home boost rows keep only boosted listings, ordered by tier then newest', () => {
  const {context} = stripContext({rpcResult: {data: {rows: []}, error: null}});
  const rows = context.homeBoostRows([
    row('plain', null, '2026-11-20T00:00:00Z'),
    row('gold-old', 'gold', '2026-11-10T00:00:00Z'),
    row('silver-new', 'silver', '2026-11-21T00:00:00Z'),
    row('plat', 'platinum', '2026-11-01T00:00:00Z'),
    row('gold-new', 'gold', '2026-11-15T00:00:00Z'),
  ]);
  assert.deepEqual([...rows].map(v => v.id), ['plat', 'gold-new', 'gold-old', 'silver-new']);
});

test('home boost rows break created_at ties by id and cap the strip size', () => {
  const {context} = stripContext({rpcResult: {data: {rows: []}, error: null}});
  const many = Array.from({length: 25}, (_, i) => row(`id-${String(i).padStart(2, '0')}`, 'silver', '2026-11-01T00:00:00Z'));
  const rows = context.homeBoostRows(many);
  assert.equal(rows.length, 20);
  assert.equal(rows[0].id, 'id-24');
  // Arrays returned from the vm realm fail deepStrictEqual; compare lengths.
  assert.equal(context.homeBoostRows(null).length, 0);
  assert.equal(context.homeBoostRows('nope').length, 0);
});

test('home boost card reuses the appeal image fallback and shows title, price and plan tag', () => {
  const {context} = stripContext({rpcResult: {data: {rows: []}, error: null}});
  const withImage = context.homeBoostCardHtml(row('a', 'platinum', '2026-11-01T00:00:00Z', {image_path: 'seller/appeal.jpg', price_jpy: 2500}));
  assert.match(withImage, /listing-images\/seller\/appeal\.jpg/);
  assert.match(withImage, /boost-pr-tag boost-platinum/);
  assert.match(withImage, /出品 a/);
  assert.match(withImage, /2,500円/);
  assert.match(withImage, /onclick="openListingDetail\('a'\)"/);

  const withAvatar = context.homeBoostCardHtml(row('b', 'gold', '2026-11-01T00:00:00Z', {profiles: {display_name: '出品者', avatar_path: 'seller/icon.png'}}));
  assert.match(withAvatar, /profile-avatars\/seller\/icon\.png/);

  const withNeither = context.homeBoostCardHtml(row('c', 'silver', '2026-11-01T00:00:00Z'));
  assert.match(withNeither, /appeal-default/);
  assert.doesNotMatch(withNeither, /<img/);
});

test('loader shows the strip with boosted listings only and registers detail state', async () => {
  const rows = [
    row('plain', null, '2026-11-20T00:00:00Z'),
    row('gold1', 'gold', '2026-11-10T00:00:00Z'),
    row('plat1', 'platinum', '2026-11-01T00:00:00Z', {seller_id: 'me'}),
  ];
  const {context, scrollEl, classes} = stripContext({rpcResult: {data: {rows, total: 3, rotation_epoch: 1}, error: null}});
  await context.loadHomeBoostStrip();
  assert.equal(classes.has('hide'), false);
  assert.match(scrollEl.innerHTML, /出品 plat1/);
  assert.match(scrollEl.innerHTML, /出品 gold1/);
  assert.doesNotMatch(scrollEl.innerHTML, /出品 plain/);
  assert.ok(scrollEl.innerHTML.indexOf('出品 plat1') < scrollEl.innerHTML.indexOf('出品 gold1'), 'platinum renders before gold');
  assert.equal(context.listingDetailCache.size, 2);
  const plat = context.listingDetailCache.get('plat1');
  assert.equal(plat.boostPlan, 'platinum');
  assert.equal(plat.own, true);
  assert.equal(plat.ownerId, 'me');
  const gold = context.listingDetailCache.get('gold1');
  assert.equal(gold.boostPlan, 'gold');
  assert.equal(gold.own, false);
});

test('loader hides the whole strip when no production boost is active', async () => {
  const rows = [row('plain', null, '2026-11-20T00:00:00Z')];
  const {context, scrollEl, classes} = stripContext({rpcResult: {data: {rows, total: 1, rotation_epoch: 1}, error: null}});
  await context.loadHomeBoostStrip();
  assert.equal(classes.has('hide'), true);
  assert.equal(scrollEl.innerHTML, '');
});

test('loader hides the strip on rpc error and when the only boost is hidden by the user', async () => {
  const failed = stripContext({rpcResult: {data: null, error: new Error('network')}});
  await failed.context.loadHomeBoostStrip();
  assert.equal(failed.classes.has('hide'), true);
  assert.equal(failed.scrollEl.innerHTML, '');

  const rows = [row('boosted', 'silver', '2026-11-10T00:00:00Z')];
  const hidden = stripContext({rpcResult: {data: {rows, total: 1, rotation_epoch: 1}, error: null}, hiddenIds: new Set(['boosted'])});
  await hidden.context.loadHomeBoostStrip();
  assert.equal(hidden.classes.has('hide'), true);
  assert.equal(hidden.scrollEl.innerHTML, '');
});

test('strip markup sits at the top of home, before the purpose menu cards, and starts hidden', () => {
  const homeAt = html.indexOf('<section id="home"');
  const stripAt = html.indexOf('id="homeBoostStrip"');
  const menuAt = html.indexOf('<div class="quickgrid">');
  assert.ok(homeAt !== -1 && stripAt > homeAt, 'strip is inside the home section');
  assert.ok(stripAt < menuAt, 'strip renders before the purpose menu cards');
  assert.match(html, /id="homeBoostStrip" class="home-boost-strip hide"/);
  assert.match(html, /<div id="homeBoostScroll" class="home-boost-scroll"><\/div>/);
});

test('home loads the strip, which delegates boost validity to the ranked search RPC', () => {
  const loadHome = html.slice(html.indexOf('async function loadHome(){'), html.indexOf('const HOME_BOOST_STRIP_LIMIT'));
  assert.match(loadHome, /loadHomeBoostStrip\(\);/);
  // The client must not re-implement environment separation: no direct
  // listing_boosts query and no Sandbox/Production handling in the loader.
  assert.match(stripSource, /sb\.rpc\('search_voice_listings_ranked'/);
  assert.match(stripSource, /sort_by:'recommended'/);
  assert.doesNotMatch(stripSource, /listing_boosts/);
  assert.doesNotMatch(stripSource, /Sandbox|environment/);
  assert.match(stripSource, /strip\.classList\.add\('hide'\)/);
});

test('strip styles scroll horizontally with snap-sized cards', () => {
  assert.match(html, /\.home-boost-scroll\{[^}]*overflow-x:auto/);
  assert.match(html, /\.home-boost-scroll\{[^}]*display:flex/);
  assert.match(html, /\.home-boost-card\{[^}]*flex:0 0 180px/);
  assert.match(html, /\.home-boost-card \.listing-appeal\{/);
});

test('strip design stays quiet: plain section label, flat white cards, generous spacing', () => {
  // No emoji or extra pill in the heading; the per-card PR tag carries disclosure.
  assert.match(html, /<div class="home-boost-head"><h2>ブースト中のおすすめ<\/h2><\/div>/);
  assert.doesNotMatch(html, /home-boost-note/);
  // Flat card surface (no gradient) and roomier padding/gaps.
  assert.match(html, /\.home-boost-card\{[^}]*background:var\(--card\)/);
  assert.match(html, /\.home-boost-card\{[^}]*padding:12px/);
  assert.match(html, /\.home-boost-scroll\{[^}]*gap:12px/);
  // Heading matches the home summary label tone (small, muted).
  assert.match(html, /\.home-boost-head h2\{[^}]*color:#5c5673/);
});
