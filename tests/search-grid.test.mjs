import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261122110000_search_seller_ratings.sql', import.meta.url), 'utf8');
const loadListingsSrc = html.slice(html.indexOf('async function loadListings('), html.indexOf('function listingActionHtml('));
const tileAt = loadListingsSrc.indexOf('class="voice-tile"');
const tileSrc = loadListingsSrc.slice(tileAt);

function ratingContext() {
  const context = vm.createContext({});
  vm.runInContext(html.slice(html.indexOf('function listingRatingHtml('), html.indexOf('function listingImageUnavailable(')), context);
  return context;
}

test('browse results render as a two-column grid and status cards span both columns', () => {
  assert.match(html, /#listingList\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /#listingList>\.card,#listingList>\.err\{grid-column:1\/-1/);
});

test('grid tile keeps the appeal image, PR tag before the title, seller and price footer', () => {
  assert.notEqual(tileAt, -1);
  assert.match(tileSrc, /\$\{listingAppealHtml\(v\)\}/);
  // PR tag sits before the title (Coconala-style), price is in the footer, never an on-image badge.
  assert.ok(tileSrc.indexOf('boost-pr-tag') < tileSrc.indexOf('voice-tile-title'));
  assert.match(tileSrc, /class="voice-tile-title">\$\{esc\(v\.title\)\}/);
  assert.match(tileSrc, /class="voice-tile-seller">\$\{esc\(v\.profiles\?\.display_name\|\|'出品者'\)\}/);
  assert.match(tileSrc, /class="price voice-tile-price">\$\{Number\(v\.price_jpy\)\.toLocaleString\(\)\}円/);
  assert.ok(tileSrc.indexOf('voice-tile-title') < tileSrc.indexOf('voice-tile-price'));
  assert.doesNotMatch(html, /price-badge/);
});

test('grid tile opens the detail overlay and keeps favorite and sample controls from bubbling', () => {
  assert.match(tileSrc, /role="button" tabindex="0"/);
  assert.match(tileSrc, /onclick="openListingDetail\('\$\{esc\(v\.id\)\}'\)"/);
  assert.match(tileSrc, /event\.stopPropagation\(\);toggleFavoriteListing\('\$\{esc\(v\.id\)\}',this\)/);
  assert.match(tileSrc, /class="voice-tile-sample" onclick="event\.stopPropagation\(\)">\$\{audio\}/);
  // Sample markup itself is unchanged, so the existing error-binding pass still applies.
  assert.match(loadListingsSrc, /audio class="listing-card-sample" controls preload="none"/);
});

test('rating row shows star, one-decimal average and review count (Coconala format)', () => {
  const c = ratingContext();
  const rated = c.listingRatingHtml({seller_rating_avg: 4.5, seller_review_count: 141});
  assert.match(rated, /voice-tile-rating"/);
  assert.match(rated, /★<\/span>4\.5/);
  assert.match(rated, /\(141\)/);
  const perfect = c.listingRatingHtml({seller_rating_avg: 5, seller_review_count: 3});
  assert.match(perfect, /★<\/span>5\.0/);
  assert.match(perfect, /\(3\)/);
});

test('rating row is a quiet dash when the seller has no reviews or fields are absent', () => {
  const c = ratingContext();
  for (const v of [{seller_rating_avg: null, seller_review_count: 0}, {}, {seller_rating_avg: 4.5, seller_review_count: 0}]) {
    const row = c.listingRatingHtml(v);
    assert.match(row, /voice-tile-rating none"/);
    assert.match(row, /★<\/span>-/);
  }
});

test('appeal images are shown whole (contain) over a blurred fill inside a fixed 4:3 frame', () => {
  assert.match(html, /\.listing-appeal\{[^}]*aspect-ratio:4\/3\}/);
  assert.match(html, /\.listing-appeal img\.appeal-main\{[^}]*object-fit:contain/);
  assert.match(html, /\.listing-appeal img\.appeal-bg\{[^}]*object-fit:cover;filter:blur\(16px\)/);
  const appealSrc = html.slice(html.indexOf('function listingAppealHtml('), html.indexOf('function listingRatingHtml('));
  assert.match(appealSrc, /class="appeal-bg"/);
  assert.match(appealSrc, /class="appeal-main"/);
  // Seller guidance states the recommended 4:3 size and no longer claims cropping.
  assert.match(html, /推奨サイズ：1200×900px（4:3）/);
  assert.doesNotMatch(html, /切り取って表示/);
  assert.doesNotMatch(html, /切り取って表示されるため/);
});

test('home boost strip still uses its own horizontal cards (unchanged by the grid)', () => {
  assert.match(html, /\.home-boost-scroll\{display:flex/);
  assert.match(html, /class="home-boost-card"/);
  assert.match(html, /class="home-boost-title"/);
});

test('ratings migration extends the ranked search with the My Page aggregation semantics', () => {
  assert.match(migration, /create or replace function public\.search_voice_listings_ranked/);
  assert.match(migration, /round\(avg\(r\.rating\)::numeric,1\) from public\.reviews r where r\.target_user_id=l\.seller_id and r\.rating between 1 and 5\) as seller_rating_avg/);
  assert.match(migration, /count\(\*\) from public\.reviews r where r\.target_user_id=l\.seller_id and r\.rating between 1 and 5\) as seller_review_count/);
  // Built on top of the appeal-image definition: image_path and boost handling remain.
  assert.match(migration, /l\.image_path/);
  assert.match(migration, /public_active_boosts/);
  assert.match(migration, /grant execute on function public\.search_voice_listings_ranked/);
});
