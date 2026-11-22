import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function cssRule(selector) {
  const idx = html.indexOf(selector + '{');
  assert.notEqual(idx, -1, `${selector} rule is missing`);
  return html.slice(idx, html.indexOf('}', idx) + 1);
}

test('mascot helpers render the bundled image and remove it on load error', () => {
  assert.ok(html.includes('function mascotImg(cls)'));
  assert.ok(html.includes('src="assets/mascot.webp"'));
  assert.ok(html.includes('onerror="this.remove()"'), 'a failed mascot load must not leave a broken image');
  assert.ok(html.includes('function mascotEmpty(text)'));
  assert.ok(html.includes('function mascotEmptyPlain(text)'));
});

test('mascot css keeps the agreed display sizes', () => {
  const img = cssRule('.mascot-img');
  assert.match(img, /width:132px/);
  const sm = cssRule('.mascot-img.sm');
  assert.match(sm, /width:96px/);
  const empty = cssRule('.mascot-empty');
  assert.match(empty, /text-align:center/);
});

test('search, favorites, jobs and trade panels share the mascot empty state', () => {
  assert.ok(html.includes("mascotEmpty('この範囲に条件に合う出品はありません。"));
  assert.ok(html.includes("mascotEmpty('お気に入りはまだありません。')"));
  assert.ok(html.includes("mascotEmpty('まだ募集がありません。')"));
  assert.ok(html.includes("mascotEmpty('条件に合う取引はありません。')"));
});

test('message lists and the open chat use the mascot when empty', () => {
  assert.ok(html.includes("mascotEmpty('まだメッセージはありません。')"));
  assert.ok(html.includes("mascotEmpty('表示中のメッセージはありません。')"));
  assert.ok(html.includes("mascotEmptyPlain('まだメッセージはありません。最初のメッセージを送ってみましょう。')"));
});

test('mypage listings, payment history, public profile and notifications use the mascot when empty', () => {
  assert.ok(html.includes("mascotEmptyPlain('支払い済み・返金済みの履歴はありません。')"));
  assert.ok(html.includes("mascotEmptyPlain('現在販売中の声はありません。')"));
  assert.ok(html.includes("mascotImg('sm')"), 'notification empty state uses the small mascot');
  assert.ok(html.includes("mascotImg()+'まだ出品がありません。"), 'empty my-listings CTA keeps its mascot');
});

test('home boost and popular strips keep their hide-when-empty behaviour', () => {
  assert.ok(html.includes('<section id="homeBoostStrip" class="home-boost-strip hide"'));
  assert.ok(html.includes('<section id="homePopularStrip" class="home-boost-strip hide"'));
});

test('overlay headings share the page heading gradient bar and favorites shows a head mascot', () => {
  const bars = cssRule('.favorites-head h3:after,.public-profile-head h3:after,.notif-head h2:after');
  assert.match(bars, /linear-gradient\(90deg,var\(--brand\),#d56ab9\)/);
  assert.ok(html.includes('<img class="head-mascot" src="assets/mascot.webp"'));
  const head = cssRule('.head-mascot');
  assert.match(head, /border-radius:50%/);
});

test('mascot asset is a real webp and the build bundles it into www', () => {
  const asset = readFileSync(new URL('../assets/mascot.webp', import.meta.url));
  assert.ok(asset.length > 10_000, 'mascot asset looks too small');
  assert.ok(asset.length < 100_000, 'mascot asset must stay resized for its small display sizes');
  assert.equal(asset.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(asset.subarray(8, 12).toString('ascii'), 'WEBP');
  assert.ok(pkg.scripts.build.includes('cp assets/mascot.webp www/assets/mascot.webp'),
    'build must copy the mascot asset next to www/index.html so cap sync bundles it');
});
