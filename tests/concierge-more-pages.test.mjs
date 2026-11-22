import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'));

function conciergeRows() {
  const rows = [];
  let at = html.indexOf('<div class="concierge">');
  while (at !== -1) {
    const end = html.indexOf('</div></div>', at);
    rows.push({at, markup: html.slice(at, end + '</div></div>'.length)});
    at = html.indexOf('<div class="concierge">', at + 1);
  }
  return rows;
}

const JOBS_INTRO = '「この動画のナレーションをお願いしたい」「こんなキャラクターの声が欲しい」など、用途・イメージ・予算を投稿して声を募集できます。応募が来たら、メッセージで内容を相談できます。';

/* --- 声の依頼ページ: 既存の案内文をララが話す --- */

test('jobs page: concierge greets at the top, before the intro card', () => {
  const pageAt = html.indexOf('<section id="jobs" class="page">');
  const rowAt = html.indexOf('<div class="concierge">', pageAt);
  const cardAt = html.indexOf('<div class="card" style="margin-bottom:14px">', pageAt);
  assert.ok(pageAt !== -1 && rowAt > pageAt && rowAt < cardAt,
    'concierge sits between the jobs heading and the intro card');
});

test('jobs page: the bubble carries the original intro text verbatim', () => {
  const pageAt = html.indexOf('<section id="jobs" class="page">');
  const rowAt = html.indexOf('<div class="concierge">', pageAt);
  const row = conciergeRows().find(r => r.at === rowAt);
  assert.ok(row.markup.includes(JOBS_INTRO), 'bubble text is the pre-existing intro sentence, unchanged');
  assert.equal(html.split(JOBS_INTRO).length - 1, 1,
    'the intro sentence appears exactly once: it moved into the bubble instead of being duplicated');
});

test('jobs page: the intro card keeps its heading and examples', () => {
  const pageAt = html.indexOf('<section id="jobs" class="page">');
  const cardAt = html.indexOf('<div class="card" style="margin-bottom:14px">', pageAt);
  const card = html.slice(cardAt, html.indexOf('<div id="jobList">', cardAt));
  assert.match(card, /欲しい声が見つからないときは募集しよう/, 'card heading stays');
  assert.match(card, /<b>依頼例：<\/b>/, 'example list stays in the card');
  assert.doesNotMatch(card, /class="concierge"/, 'no second concierge inside the card');
});

/* --- マイページ: 最上部の案内 --- */

test('mypage: concierge greets at the very top of the me page', () => {
  const pageAt = html.indexOf('<section id="me" class="page">');
  const rowAt = html.indexOf('<div class="concierge">', pageAt);
  const navAt = html.indexOf('<nav class="page-shortcuts"', pageAt);
  const profileAt = html.indexOf('<div class="card profile-compact profile-card-main">', pageAt);
  assert.ok(pageAt !== -1 && rowAt > pageAt && rowAt < navAt && rowAt < profileAt,
    'concierge sits above the section tabs and the profile card');
});

test('mypage: the bubble only points at features the page really has', () => {
  const pageAt = html.indexOf('<section id="me" class="page">');
  const rowAt = html.indexOf('<div class="concierge">', pageAt);
  const row = conciergeRows().find(r => r.at === rowAt);
  assert.match(row.markup, /プロフィールの編集/, 'points at profile editing (the 編集 button on the profile card)');
  assert.match(row.markup, /本人確認・振込先の登録/, 'points at the Stripe payout registration on this page');
  assert.match(row.markup, /出品や取引の確認/, 'points at the listing/trade tabs on this page');
  // 実在チェック: 案内した機能がこのページ周辺に実装されていること
  assert.match(html, /onclick="connectStripeSeller\(\)"/, 'Stripe payout setup exists');
  assert.match(html, /onclick="openProfileEdit\(/, 'profile edit exists');
});

/* --- 全体 --- */

test('concierge now appears in 10 spots in total', () => {
  assert.equal(conciergeRows().length, 10, '8 spots from PR #73 plus jobs and mypage');
});

/* --- リリース整合 --- */

test('release label and manifest point at the header nav polish build', () => {
  assert.match(html, /<meta name="voice-flea-release" content="2026\.11.22-header-layout2">/);
  assert.equal(manifest.release, '2026.11.22-header-layout2');
  const digest = createHash('sha256').update(readFileSync(new URL('../index.html', import.meta.url))).digest('hex');
  assert.equal(manifest.web_sha256, digest, 'manifest web_sha256 matches index.html');
});
