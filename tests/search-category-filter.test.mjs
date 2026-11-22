import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261122120000_search_category_filter.sql', import.meta.url), 'utf8');
const prevMigration = readFileSync(new URL('../supabase/migrations/20261122110000_search_seller_ratings.sql', import.meta.url), 'utf8');
const loadListingsSrc = html.slice(html.indexOf('async function loadListings('), html.indexOf('function listingActionHtml('));

function chipData() {
  const start = html.indexOf('id="categoryChips"');
  assert.notEqual(start, -1);
  const block = html.slice(start, html.indexOf('</div>', start));
  return [...block.matchAll(/data-category="([^"]*)"/g)].map(m => m[1]);
}

test('category chips sit above the results grid with an all-categories default', () => {
  const chipsAt = html.indexOf('id="categoryChips"');
  assert.ok(chipsAt > html.indexOf('id="voiceSort"'), 'chips come after the sort controls');
  assert.ok(chipsAt < html.indexOf('id="listingList"'), 'chips come before the grid');
  const cats = chipData();
  assert.equal(cats[0], '', 'first chip is すべて (empty = no filter)');
  assert.match(html, /class="category-chip on" data-category=""/, 'すべて starts selected');
});

test('chip categories exactly match the sell form category options', () => {
  const sellStart = html.indexOf('id="sellCategory"');
  assert.notEqual(sellStart, -1);
  const sellBlock = html.slice(sellStart, html.indexOf('</select>', sellStart));
  const sellOptions = [...sellBlock.matchAll(/<option>([^<]+)<\/option>/g)].map(m => m[1]);
  assert.deepEqual(chipData().slice(1), sellOptions);
});

test('selecting a chip records the category, moves the highlight and reloads', () => {
  const fnStart = html.indexOf('function selectListingCategory(');
  assert.notEqual(fnStart, -1);
  const fnSrc = html.slice(fnStart, html.indexOf('\n}\n', fnStart) + 3);
  const chips = [{dataset: {category: ''}, classList: {toggle(cls, on) { this.on = on; }}}, {dataset: {category: '歌'}, classList: {toggle(cls, on) { this.on = on; }}}];
  const calls = [];
  const context = vm.createContext({
    document: {querySelectorAll: () => chips},
    loadListings: reset => calls.push(reset),
  });
  context.selectedListingId = 'keep-me';
  vm.runInContext('let selectedListingCategory = \'\';', context);
  vm.runInContext(fnSrc, context);
  context.selectListingCategory(chips[1]);
  assert.equal(vm.runInContext('selectedListingCategory', context), '歌');
  assert.equal(chips[1].classList.on, true);
  assert.equal(chips[0].classList.on, false);
  assert.equal(context.selectedListingId, null, 'a pinned selection is cleared like the other filters');
  assert.deepEqual(calls, [true]);
  context.selectListingCategory(chips[0]);
  assert.equal(vm.runInContext('selectedListingCategory', context), '', 'すべて clears the filter');
});

test('search only sends category_filter while a category is selected', () => {
  // While nothing is selected the argument is omitted entirely, so the
  // pre-migration RPC (no category_filter parameter) keeps working.
  assert.match(loadListingsSrc, /if\(selectedListingCategory\)searchArgs\.category_filter=selectedListingCategory;/);
  assert.match(loadListingsSrc, /sb\.rpc\('search_voice_listings_ranked',searchArgs\)/);
  assert.doesNotMatch(loadListingsSrc, /category_filter:selectedListingCategory/);
  assert.match(loadListingsSrc, /hideOwn\|\|selectedListingCategory\)\?'（絞り込み中）'/);
});

test('migration adds only the category parameter and one condition', () => {
  assert.match(migration, /drop function if exists public\.search_voice_listings_ranked\(text,integer,integer,text,integer,integer,boolean,boolean,uuid,bigint\);/);
  assert.match(migration, /,category_filter text default null\)/);
  assert.match(migration, /grant execute on function public\.search_voice_listings_ranked\(text,integer,integer,text,integer,integer,boolean,boolean,uuid,bigint,text\) to anon,authenticated;/);
  const bodyOf = src => src.match(/as \$\$\n([\s\S]*?)\n\$\$;/)[1];
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const added = ' and (category_filter is null or l.category=category_filter)';
  const newBody = bodyOf(migration);
  assert.equal(newBody.split(added).length - 1, 1, 'exactly one category condition is added');
  assert.equal(norm(newBody.replace(added, '')), norm(bodyOf(prevMigration)),
    'removing the category condition reproduces the previous function body exactly');
});
