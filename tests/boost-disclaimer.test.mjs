import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'));

/* ユーザーが2026-11-22に承認した文言。そのまま使うこと（改変しない）。 */
const DISCLAIMER = 'ブーストは表示の優先度を上げる機能です。購入・成約を保証するものではありません。売れ行きは、出品内容やプロフィール、アピール画像の整備状況によっても変わります。';

/* --- 追加1: ブースト購入ダイアログの注記 --- */

test('boost dialog carries the approved disclaimer verbatim, exactly once', () => {
  const occurrences = html.split(DISCLAIMER).length - 1;
  assert.equal(occurrences, 1, 'approved disclaimer appears exactly once in the document');
  assert.ok(html.includes(`<p class="boost-note" id="boostDisclaimerNote">${DISCLAIMER}</p>`),
    'disclaimer is a small boost-note paragraph in the dialog');
});

test('disclaimer sits inside the purchase options, before every purchase button', () => {
  const optionsAt = html.indexOf('<div id="boostPurchaseOptions"');
  const noteAt = html.indexOf('id="boostDisclaimerNote"');
  const firstPlanAt = html.indexOf('<div class="boost-plan" data-boost-plan="silver"');
  const firstBuyAt = html.indexOf('data-boost-buy="silver"');
  assert.ok(optionsAt !== -1 && noteAt > optionsAt, 'note is inside #boostPurchaseOptions');
  assert.ok(noteAt < firstPlanAt && noteAt < firstBuyAt,
    'note comes before the plan cards and their purchase buttons');
  for (const plan of ['silver', 'gold', 'platinum']) {
    const buyAt = html.indexOf(`onclick="purchaseBoost('${plan}')"`);
    assert.ok(buyAt !== -1 && noteAt < buyAt, `note precedes the ${plan} purchase action`);
  }
});

test('the boost dialog stays the single purchase-confirmation surface', () => {
  assert.equal(html.split('id="boostPreviewOverlay"').length - 1, 1, 'one shared boost dialog');
  assert.equal(html.split('id="boostPurchaseOptions"').length - 1, 1, 'one shared purchase options block');
});

/* --- 追加2: 使い方ページのブースト説明（ララの吹き出し） --- */

function manualSection(title) {
  const at = html.indexOf(`<b>${title}</b>`);
  assert.notEqual(at, -1, `manual section ${title} exists`);
  const next = html.indexOf('<div class="manual-section">', at + 1);
  return html.slice(at, next === -1 ? at + 4000 : next);
}

test('guide boost bubble adds the no-guarantee line without contradicting the disclaimer', () => {
  const body = manualSection('🚀 出品ブースト');
  const bubbleAt = body.indexOf('<div class="concierge">');
  assert.notEqual(bubbleAt, -1, 'boost section keeps its ララ concierge bubble');
  const bubble = body.slice(bubbleAt, body.indexOf('</div></div>', bubbleAt));
  assert.match(bubble, /3種類があります/, 'original bubble line is kept');
  assert.match(bubble, /表示は優先されるけど、成約の保証はないよ/, 'bubble now states there is no sales guarantee');
  assert.match(bubble, /プロフィールやアピール画像の整備も大事だよ/, 'bubble points at profile and appeal-image upkeep');
  assert.doesNotMatch(bubble, /成約を保証(する|します)/, 'bubble never promises a sale');
});

/* --- リリース整合 --- */

test('release label and manifest point at the header nav polish build', () => {
  assert.match(html, /<meta name="voice-flea-release" content="2026\.11.22-header-layout2">/);
  assert.equal(manifest.release, '2026.11.22-header-layout2');
  const digest = createHash('sha256').update(readFileSync(new URL('../index.html', import.meta.url))).digest('hex');
  assert.equal(manifest.web_sha256, digest, 'manifest web_sha256 matches index.html');
});
