import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const homeStart = html.indexOf('<section id="home"');
// The home section nests other <section> elements, so take a fixed window
// that covers the hero, both strips and the menu cards.
const homeSection = html.slice(homeStart, homeStart + 20000);
const heroStart = homeSection.indexOf('class="home-hero"');
const heroMarkup = homeSection.slice(heroStart, homeSection.indexOf('</div></div>', heroStart));

function cssRule(selector) {
  const idx = html.indexOf(selector + '{');
  assert.notEqual(idx, -1, `${selector} rule is missing`);
  return html.slice(idx, html.indexOf('}', idx) + 1);
}

test('home top is a hero banner and the plain welcome block is gone', () => {
  assert.notEqual(heroStart, -1, 'hero banner is missing from the home section');
  assert.equal(html.includes('class="home-welcome"'), false, 'old welcome block must be integrated into the banner');
  assert.ok(heroMarkup.includes('<h1>今日は、声で<br>何をしよう？</h1>'));
  assert.ok(heroMarkup.includes('声を探す・売る・依頼する。<br>やりたいことから始めましょう。'));
  assert.equal((html.match(/今日は、声で/g) || []).length, 1, 'catch copy must not be duplicated');
});

test('hero banner sits above the boost strip', () => {
  const boostIdx = homeSection.indexOf('id="homeBoostStrip"');
  assert.ok(heroStart > -1 && boostIdx > heroStart, 'hero must come before the boost strip');
  assert.ok(homeSection.indexOf('id="homePopularStrip"') > boostIdx, 'popular strip order must stay unchanged');
});

test('hero uses the bundled mic photo, right-aligned with a readability scrim', () => {
  assert.ok(heroMarkup.includes('<img class="home-hero-img" src="assets/home-hero.webp"'));
  const banner = cssRule('.home-hero');
  assert.match(banner, /border-radius:2[0-4]px/);
  assert.match(banner, /aspect-ratio:1\.9\/1/);
  assert.match(banner, /overflow:hidden/);
  const img = cssRule('.home-hero-img');
  assert.match(img, /object-fit:cover/);
  assert.match(img, /object-position:right/);
  const scrim = cssRule('.home-hero-scrim');
  assert.match(scrim, /linear-gradient\(90deg,rgba\(30,23,72,\.82\)/);
});

test('hero CTA label is exactly centered and navigates like the voices menu card', () => {
  assert.ok(heroMarkup.includes('<button class="home-hero-cta" type="button" onclick="go(\'voices\')">声を探してみる</button>'));
  const cta = cssRule('.home-hero-cta');
  assert.match(cta, /display:inline-flex/);
  assert.match(cta, /align-items:center/);
  assert.match(cta, /justify-content:center/);
  assert.doesNotMatch(cta, /transform|translate/, 'CTA must not use manual offsets to fake centering');
  assert.ok(html.includes('<button class="quickcard" onclick="go(\'voices\')">'), 'menu card keeps the same destination');
});

test('hero image asset is a real webp and the build bundles it into www', () => {
  const asset = readFileSync(new URL('../assets/home-hero.webp', import.meta.url));
  assert.ok(asset.length > 50_000, 'hero asset looks too small to be the photo');
  assert.equal(asset.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(asset.subarray(8, 12).toString('ascii'), 'WEBP');
  assert.ok(pkg.scripts.build.includes('cp assets/home-hero.webp www/assets/home-hero.webp'),
    'build must copy the hero asset next to www/index.html so cap sync bundles it');
});
