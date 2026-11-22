import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('ブースト購入ダイアログの導入文がホーム帯と優先表示に触れている', () => {
  const intro = html.match(/<p id="boostPreviewListing">([^<]*)<\/p>/)?.[1] || '';
  assert.match(intro, /ブースト中のおすすめ/);
  assert.match(intro, /画像付きで流れます/);
  assert.match(intro, /おすすめ順でも優先表示されます/);
});

test('ホームの出品ブーストカードのサブタイトルがホーム表示に触れている', () => {
  assert.match(html, /<small>ホームのおすすめに流して目立たせる有料プラン<\/small>/);
  assert.doesNotMatch(html, /自分の出品をPRで目立たせる有料プラン/);
});
