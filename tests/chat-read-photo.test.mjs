import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261122130000_chat_read_states_and_photos.sql', import.meta.url), 'utf8');
const loadChatSrc = html.slice(html.indexOf('async function loadChatMessages('), html.indexOf('function hiddenMessageKey('));

test('composer gains a photo button and file input next to the text area', () => {
  assert.match(html, /id="chatPhotoBtn"[^>]*aria-label="写真を送信"/);
  assert.match(html, /id="chatPhotoInput" type="file" accept="image\/jpeg,image\/png,image\/webp"[^>]*onchange="sendChatPhoto\(this\)"/);
  const composerAt = html.indexOf('id="chatPhotoBtn"');
  assert.ok(composerAt < html.indexOf('id="chatInput"'), 'photo button precedes the text area');
  assert.ok(composerAt > html.indexOf('id="chatMessages"'), 'composer stays inside the chat box');
});

test('history fetch keeps its exact column list; attachments and read states load separately', () => {
  const historySrc = html.slice(html.indexOf('async function fetchChatHistory('), html.indexOf('async function loadOlderChatMessages('));
  assert.match(historySrc, /select\('id,conversation_id,sender_id,body,created_at'\)/);
  assert.doesNotMatch(historySrc, /attachment_path/);
  // Best-effort side queries inside loadChatMessages (absent before the migration).
  assert.match(loadChatSrc, /select\('id,attachment_path'\)\.in\('conversation_id',ids\)\.not\('attachment_path','is',null\)/);
  assert.match(loadChatSrc, /from\('conversation_read_states'\)\.select\('conversation_id,user_id,last_read_at'\)/);
  assert.match(loadChatSrc, /storage\.from\('chat-images'\)\.createSignedUrls\(paths,3600\)/);
});

test('opening a conversation also marks it read on the server, tolerating a missing RPC', () => {
  assert.match(html, /function markConversationReadOnServer\(id\)/);
  assert.match(html, /sb\.rpc\('mark_conversation_read',\{p_conversation_id:id\}\)/);
  const seenSrc = html.slice(html.indexOf('async function markConversationSeen('), html.indexOf('async function countUnreadMessages('));
  assert.match(seenSrc, /markConversationReadOnServer\(id\);/);
  // localStorage tracking is untouched.
  assert.match(seenSrc, /safeLocalStorage\.setItem\(seenKey\(id\),seenIso\)/);
});

function readLabelContext() {
  const start = loadChatSrc.indexOf('let lastReadMineId=null;');
  const end = loadChatSrc.indexOf('const chatPhotoHtml=');
  assert.ok(start !== -1 && end > start);
  const context = vm.createContext({
    currentUser: {id: 'me'},
    partnerReadAt: new Map([['conv1', '2026-11-22T10:05:00.000Z']]),
    data: [
      {id: 'm1', sender_id: 'me', conversation_id: 'conv1', body: 'こんにちは', created_at: '2026-11-22T10:00:00.000Z'},
      {id: 'm2', sender_id: 'partner', conversation_id: 'conv1', body: 'どうも', created_at: '2026-11-22T10:01:00.000Z'},
      {id: 'm3', sender_id: 'me', conversation_id: 'conv1', body: 'サンプルです', created_at: '2026-11-22T10:03:00.000Z'},
      {id: 'm4', sender_id: 'me', conversation_id: 'conv1', body: 'もう一件', created_at: '2026-11-22T10:09:00.000Z'},
      {id: 'm5', sender_id: 'me', conversation_id: 'conv1', body: '📦 音声を納品しました。ファイル名: a.m4a', created_at: '2026-11-22T10:04:00.000Z'},
    ],
  });
  vm.runInContext(loadChatSrc.slice(start, end), context);
  return context;
}

test('read label lands on the newest own message the partner has read (system notices excluded)', () => {
  const context = readLabelContext();
  // m3 (10:03) is read; m4 (10:09) is after the partner watermark; the
  // delivery system notice m5 must not steal the label.
  assert.equal(vm.runInContext('lastReadMineId', context), 'm3');
  assert.match(loadChatSrc, /m\.id===lastReadMineId\?'<div class="chat-read-label">既読<\/div>':''/);
});

test('photo bubbles hide the placeholder body only when the image renders', () => {
  const start = loadChatSrc.indexOf('const chatBubbleText=');
  const end = loadChatSrc.indexOf(';', start) + 1;
  const context = vm.createContext({
    CHAT_PHOTO_BODY: '📷 写真を送信しました',
    esc: s => 'ESC:' + s,
  });
  vm.runInContext(loadChatSrc.slice(start, end), context);
  const chatBubbleText = vm.runInContext('chatBubbleText', context);
  const photo = {body: '📷 写真を送信しました'};
  assert.equal(chatBubbleText(photo, '<img>'), '');
  assert.equal(chatBubbleText(photo, ''), 'ESC:📷 写真を送信しました', 'fallback keeps the placeholder visible');
  assert.equal(chatBubbleText({body: '本文'}, '<img>'), 'ESC:本文', 'a real caption still shows');
});

function photoSendContext({uploadPath, insertError = null, existingRow = null}) {
  const start = html.indexOf('async function sendChatPhoto(');
  const end = html.indexOf('const authorizationActionStates');
  assert.ok(start !== -1 && end > start);
  const calls = {uploads: [], removes: [], inserts: [], infos: []};
  const sb = {
    storage: {from: () => ({
      upload: async path => { calls.uploads.push(path); return {data: {path: uploadPath}, error: null}; },
      remove: async paths => { calls.removes.push(paths); return {data: [], error: null}; },
    })},
    from: () => ({
      insert: async row => { calls.inserts.push(row); return {error: insertError}; },
      select: () => ({eq: () => ({maybeSingle: async () => ({data: existingRow})})}),
    }),
  };
  const context = vm.createContext({
    sb,
    currentUser: {id: 'me'},
    currentConversationId: 'conv1',
    sendingChatConversations: new Set(),
    renderedChatConversation: 'conv1',
    CHAT_PHOTO_BODY: '📷 写真を送信しました',
    resizeChatPhoto: async f => f,
    isCurrentConversationBlocked: async () => false,
    info: (id, msg, kind) => calls.infos.push([msg, kind]),
    loadChatMessages: async () => { calls.reloaded = true; },
    loadMessageBadge: () => {},
    crypto: {randomUUID: () => '11111111-2222-3333-4444-555555555555'},
  });
  vm.runInContext(html.slice(start, end), context);
  return {context, calls};
}

test('photo send uploads first, verifies the returned path, then inserts the message', async () => {
  const path = 'conv1/11111111-2222-3333-4444-555555555555.jpg';
  const {context, calls} = photoSendContext({uploadPath: path});
  await context.sendChatPhoto({files: [{type: 'image/png', size: 1000}], value: 'x'});
  assert.deepEqual(calls.uploads, [path]);
  assert.equal(calls.inserts.length, 1);
  assert.equal(calls.inserts[0].attachment_path, path);
  assert.equal(calls.inserts[0].body, '📷 写真を送信しました');
  assert.equal(calls.inserts[0].id, '11111111-2222-3333-4444-555555555555');
  assert.deepEqual(calls.removes, []);
  assert.equal(calls.reloaded, true);
});

test('photo send cleans up and stops when the returned upload path differs', async () => {
  const {context, calls} = photoSendContext({uploadPath: 'somewhere/else.jpg'});
  await context.sendChatPhoto({files: [{type: 'image/jpeg', size: 1000}], value: 'x'});
  assert.equal(calls.inserts.length, 0, 'message is never inserted for an unverified path');
  assert.equal(JSON.stringify(calls.removes), JSON.stringify([['conv1/11111111-2222-3333-4444-555555555555.jpg']]));
  assert.ok(calls.infos.some(([msg, kind]) => kind === 'err'));
});

test('photo send removes the orphan upload when the insert fails unconfirmed', async () => {
  const path = 'conv1/11111111-2222-3333-4444-555555555555.jpg';
  const {context, calls} = photoSendContext({uploadPath: path, insertError: new Error('boom')});
  await context.sendChatPhoto({files: [{type: 'image/webp', size: 1000}], value: 'x'});
  assert.equal(JSON.stringify(calls.removes), JSON.stringify([[path]]));
  assert.ok(calls.infos.some(([msg, kind]) => kind === 'err'));
});

test('migration creates read states, the participant-only RPC and the private chat-images bucket', () => {
  assert.match(migration, /create table if not exists public\.conversation_read_states/);
  assert.match(migration, /primary key \(conversation_id, user_id\)/);
  assert.match(migration, /alter table public\.conversation_read_states enable row level security/);
  assert.match(migration, /create or replace function public\.mark_conversation_read\(p_conversation_id uuid\)\nreturns void language plpgsql security definer/);
  assert.match(migration, /not a conversation participant/);
  assert.match(migration, /greatest\(public\.conversation_read_states\.last_read_at, excluded\.last_read_at\)/);
  assert.match(migration, /grant execute on function public\.mark_conversation_read\(uuid\) to authenticated/);
  assert.match(migration, /alter table public\.messages\n  add column if not exists attachment_path text/);
  assert.match(migration, /values \('chat-images', 'chat-images', false, 10485760, array\['image\/jpeg','image\/png','image\/webp'\]\)/);
  // Storage/read access is limited to the conversation's buyer/seller
  // (read-states select policy + storage select/insert/delete policies).
  assert.equal(migration.split('c.buyer_id = (select auth.uid()) or c.seller_id = (select auth.uid())').length - 1, 4);
  // The production body check constraint is intentionally left alone.
  assert.doesNotMatch(migration, /messages_body_check|drop constraint/);
});
