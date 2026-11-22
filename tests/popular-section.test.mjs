import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261122140000_search_popular_sort.sql', import.meta.url), 'utf8');
const prevMigration = readFileSync(new URL('../supabase/migrations/20261122120000_search_category_filter.sql', import.meta.url), 'utf8');

test('search sort gains a distinct 人気順 option next to おすすめ順', () => {
  const sortAt = html.indexOf('id="voiceSort"');
  const block = html.slice(sortAt, html.indexOf('</select>', sortAt));
  const values = [...block.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(values.slice(0, 2), [['recommended', 'おすすめ（PR優先）'], ['popular', '人気順']]);
});

test('home shows a popular strip under the boost strip, hidden by default, in the same visual language', () => {
  const boostAt = html.indexOf('id="homeBoostStrip"');
  const popularAt = html.indexOf('id="homePopularStrip"');
  assert.ok(boostAt !== -1 && popularAt > boostAt, 'popular strip follows the boost strip');
  assert.ok(popularAt < html.indexOf('class="quickgrid"'), 'both strips sit above the menu cards');
  assert.match(html, /id="homePopularStrip" class="home-boost-strip hide" aria-label="人気の出品"/);
  assert.match(html, /id="homePopularScroll" class="home-boost-scroll"/);
  assert.match(html, /loadHomeBoostStrip\(\);\n  loadHomePopularStrip\(\);/);
});

function popularContext() {
  const start = html.indexOf('const HOME_POPULAR_STRIP_LIMIT=');
  const end = html.indexOf('function homePopularCardHtml(');
  assert.ok(start !== -1 && end > start);
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end), context);
  return context;
}

test('popularity score is rating average times review count, zero without reviews', () => {
  const c = popularContext();
  assert.equal(c.popularScore({seller_rating_avg: 4.5, seller_review_count: 141}), 634.5);
  assert.equal(c.popularScore({seller_rating_avg: 5, seller_review_count: 2}), 10);
  assert.equal(c.popularScore({seller_rating_avg: null, seller_review_count: 0}), 0);
  assert.equal(c.popularScore({}), 0);
});

test('popular order is deterministic: score, completions, reviews, recency, id — boosts do not count', () => {
  const c = popularContext();
  const row = (id, avg, count, completed, created) => ({id, seller_rating_avg: avg, seller_review_count: count, seller_completed_count: completed, created_at: created});
  const rows = [
    row('b', 4.0, 10, 3, '2026-11-01T00:00:00Z'),   // score 40, fewer completions
    row('a', 4.0, 10, 9, '2026-10-01T00:00:00Z'),   // score 40, more completions -> first of the pair
    row('c', 5.0, 20, 0, '2026-09-01T00:00:00Z'),   // score 100 -> overall first
    row('d', null, 0, 50, '2026-11-20T00:00:00Z'),  // no reviews: score 0 despite many completions
    {...row('e', 4.0, 10, 3, '2026-11-02T00:00:00Z'), boost_plan: 'platinum'}, // ties with b except newer; boost must not lift it above a
  ];
  const ordered = Array.from(c.homePopularRows(rows), r => r.id);
  assert.deepEqual(ordered, ['c', 'a', 'e', 'b', 'd']);
  assert.equal(c.homePopularRows(null).length, 0);
  assert.equal(c.homePopularRows('nope').length, 0);
});

test('popular strip is capped at the strip limit', () => {
  const c = popularContext();
  const rows = Array.from({length: 25}, (_, i) => ({id: 'id' + i, seller_rating_avg: 5, seller_review_count: 100 - i, seller_completed_count: 0, created_at: '2026-11-01T00:00:00Z'}));
  const ordered = c.homePopularRows(rows);
  assert.equal(ordered.length, 10);
  assert.equal(ordered[0].id, 'id0');
});

test('popular card shows image, title, rating and price — and no PR tag', () => {
  const start = html.indexOf('function homePopularCardHtml(');
  const end = html.indexOf('async function loadHomePopularStrip(');
  const context = vm.createContext({
    esc: s => String(s),
    listingAppealHtml: () => '<IMG>',
    listingRatingHtml: () => '<RATING>',
  });
  vm.runInContext(html.slice(start, end), context);
  const card = context.homePopularCardHtml({id: 'x1', title: '明るい声', price_jpy: 3000, boost_plan: 'platinum'});
  assert.match(card, /<IMG>/);
  assert.match(card, /home-boost-title">明るい声</);
  assert.match(card, /<RATING>/);
  assert.match(card, /home-boost-price">3,000円/);
  assert.doesNotMatch(card, /boost-pr-tag|PR・優先表示/);
  assert.match(card, /openListingDetail\('x1'\)/);
});

test('popular strip loads through the popular sort and hides when empty', () => {
  const src = html.slice(html.indexOf('async function loadHomePopularStrip('), html.indexOf('function updateSellFeePreview('));
  assert.match(src, /sort_by:'popular'/);
  assert.match(src, /if\(!rows\.length\)\{hideStrip\(\);return;\}/);
  assert.match(src, /listingDetailCache\.set\(v\.id,/);
});

test('migration adds only the completion count and the popular ordering to the category-filter definition', () => {
  assert.doesNotMatch(migration, /drop function/);
  const sigOf = src => src.match(/create or replace function public\.(search_voice_listings_ranked\([^\n]+)/)[1];
  assert.equal(sigOf(migration), sigOf(prevMigration), 'signature is unchanged (category_filter included)');
  const bodyOf = src => src.match(/as \$\$\n([\s\S]*?)\n\$\$;/)[1];
  const norm = s => s.replace(/\s+/g, ' ').trim();
  let body = bodyOf(migration);
  const addedLines = [
    " (select count(*) from public.conversations c where c.seller_id=l.seller_id and c.delivery_status='accepted' and not c.is_inquiry) as seller_completed_count\n",
    " case when sort_by='popular' then coalesce(seller_rating_avg,0)*seller_review_count end desc,\n",
    " case when sort_by='popular' then seller_completed_count end desc,\n",
    " case when sort_by='popular' then seller_review_count end desc,\n",
  ];
  for (const line of addedLines) {
    assert.equal(body.split(line).length - 1, 1, 'added exactly once: ' + line.trim().slice(0, 60));
    body = body.replace(line, '');
  }
  assert.equal(norm(body), norm(bodyOf(prevMigration)),
    'removing the popular additions reproduces the category-filter function body exactly');
});
