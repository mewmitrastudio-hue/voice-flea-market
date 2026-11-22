import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261122100000_listing_appeal_image.sql', import.meta.url), 'utf8');

const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function helperContext() {
  const context = vm.createContext({
    esc,
    sb: {
      storage: {
        from: bucket => ({
          getPublicUrl: path => ({data: {publicUrl: `https://cdn.example/${bucket}/${path}`}}),
        }),
      },
    },
  });
  vm.runInContext(html.slice(html.indexOf('function profileAvatarUrl('), html.indexOf('function avatarMarkup(')), context);
  return context;
}

test('listing image metadata accepts jpeg/png/webp and normalizes jpeg to jpg', () => {
  const c = helperContext();
  const meta = (name, type) => c.listingImageFileMetadata({name, type});
  // Field-wise comparison: values returned from the vm realm fail deepStrictEqual.
  const check = (name, type, extension, contentType) => {
    const m = meta(name, type);
    assert.equal(m?.extension, extension);
    assert.equal(m?.contentType, contentType);
  };
  check('a.jpeg', 'image/jpeg', 'jpg', 'image/jpeg');
  check('a.png', 'image/png', 'png', 'image/png');
  check('a.webp', 'image/webp', 'webp', 'image/webp');
  // Extension fallback when the browser only reports a generic MIME type.
  check('a.PNG', 'application/octet-stream', 'png', 'image/png');
  check('a.jpeg', '', 'jpg', 'image/jpeg');
});

test('listing image metadata rejects non-images and unknown types', () => {
  const c = helperContext();
  assert.equal(c.listingImageFileMetadata({name: 'a.gif', type: 'image/gif'}), null);
  assert.equal(c.listingImageFileMetadata({name: 'a.mp4', type: 'video/mp4'}), null);
  assert.equal(c.listingImageFileMetadata({name: 'a.pdf', type: 'application/pdf'}), null);
  assert.equal(c.listingImageFileMetadata({name: 'a.bmp', type: ''}), null);
  assert.equal(c.listingImageFileMetadata(null), null);
});

test('listing appeal html prefers the listing image, then the seller avatar, then the default design', () => {
  const c = helperContext();
  const withImage = c.listingAppealHtml({title: 'ナレーション', image_path: 'seller/abc.jpg', profiles: {display_name: '出品者', avatar_path: 'seller/icon.png'}});
  assert.match(withImage, /listing-images\/seller\/abc\.jpg/);
  assert.match(withImage, /class="listing-appeal"/);

  const withAvatar = c.listingAppealHtml({title: 'ナレーション', image_path: null, profiles: {display_name: '出品者', avatar_path: 'seller/icon.png'}});
  assert.match(withAvatar, /profile-avatars\/seller\/icon\.png/);

  const withNeither = c.listingAppealHtml({title: 'ナレーション', image_path: null, profiles: {display_name: '出品者', avatar_path: null}});
  assert.match(withNeither, /appeal-default/);
  assert.doesNotMatch(withNeither, /<img/);

  const detail = c.listingAppealHtml({title: 'ナレーション', image_path: 'seller/abc.jpg', profiles: null}, true);
  assert.match(detail, /listing-appeal detail/);
});

test('listing image unavailable detection matches migration-missing errors', () => {
  const c = helperContext();
  assert.equal(c.listingImageUnavailable(new Error('column listings.image_path does not exist')), true);
  assert.equal(c.listingImageUnavailable(new Error('permission denied')), false);
});

test('sell form offers one optional appeal image with preview and format guidance', () => {
  assert.match(html, /id="sellImage" type="file" accept="image\/jpeg,image\/png,image\/webp" onchange="previewSellImage\(this\)"/);
  assert.match(html, /id="sellImagePreview"/);
  assert.match(html, /アピール画像<span class="field-opt">任意<\/span>/);
});

test('create listing uploads the image, verifies the returned path, and only then stores it', () => {
  const source = html.slice(html.indexOf('async function createListing('), html.indexOf('/* 購入時のエラー'));
  assert.match(source, /listingImageFileMetadata\(imageFile\)/);
  assert.match(source, /imageFile\.size>LISTING_IMAGE_MAX_BYTES/);
  assert.match(source, /sb\.storage\.from\(LISTING_IMAGE_BUCKET\)\.upload\(imagePath,imageFile/);
  assert.match(source, /iud\.path!==imagePath/);
  // No image selected -> the insert must not reference the new column at all,
  // so listings keep working before the migration is applied.
  assert.match(source, /if\(imagePath\)listingPayload\.image_path=imagePath/);
});

test('browse cards and the detail overlay render the appeal image first', () => {
  const cardAt = html.indexOf('${listingAppealHtml(v)}${verifiedBoostIds.has');
  assert.notEqual(cardAt, -1);
  const detailAt = html.indexOf('${listingAppealHtml(v,true)}${entry.boostPlan?');
  assert.notEqual(detailAt, -1);
});

test('own listings expose image editing from my page and the detail overlay', () => {
  assert.match(html, /onclick="openListingImageEdit\('\$\{x\.id\}'\)"/);
  assert.match(html, /アピール画像を設定・変更する/);
  assert.match(html, /id="listingImageOverlay"/);
  assert.match(html, /id="listingImageFile" type="file" accept="image\/jpeg,image\/png,image\/webp"/);
});

function editFixture({uploadResult, updateResult, row}) {
  const elements = new Map();
  const updates = [];
  const removed = [];
  const messages = [];
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, {value: '', files: [], disabled: false, innerHTML: '', classList: {add() {}, remove() {}}});
    return elements.get(id);
  };
  const chain = result => ({eq: () => chain(result), maybeSingle: async () => result});
  const context = vm.createContext({
    currentUser: {id: 'owner'}, authReloadPending: false,
    alert: message => messages.push(message), esc,
    document: {getElementById}, crypto: {randomUUID: () => 'uuid1'},
    info: (_id, message) => messages.push(message),
    async loadMe() {}, async loadListings() {},
    sb: {
      from: () => ({
        select: () => chain({data: row, error: null}),
        update: values => { updates.push(values); return {eq: () => ({eq: async () => updateResult})}; },
      }),
      storage: {
        from: bucket => ({
          getPublicUrl: path => ({data: {publicUrl: `https://cdn.example/${bucket}/${path}`}}),
          upload: async () => uploadResult,
          remove: async paths => { removed.push(...paths); return {}; },
        }),
      },
    },
  });
  const helpers = html.slice(html.indexOf('function profileAvatarUrl('), html.indexOf('function avatarMarkup('));
  const editor = html.slice(html.indexOf('let listingImageEditId'), html.indexOf('async function deleteMyListing('));
  vm.runInContext(helpers + editor, context);
  return {context, getElementById, updates, removed, messages};
}

const editRow = {id: 'listing1', title: 'ナレーション', image_path: 'owner/old.jpg', profiles: {display_name: '出品者', avatar_path: null}};

test('saving an appeal image aborts when the upload path cannot be verified', async () => {
  const f = editFixture({uploadResult: {data: {path: 'owner/other.png'}, error: null}, updateResult: {}, row: editRow});
  await f.context.openListingImageEdit('listing1');
  f.getElementById('listingImageFile').files = [{name: 'appeal.png', type: 'image/png', size: 1024}];
  await f.context.saveListingImage();
  assert.equal(f.updates.length, 0);
  assert.deepEqual(f.removed, ['owner/uuid1.png']);
  assert.match(f.messages.join(' '), /完了を確認できませんでした/);
});

test('saving an appeal image stores the verified path and removes the replaced file', async () => {
  const f = editFixture({uploadResult: {data: {path: 'owner/uuid1.png'}, error: null}, updateResult: {}, row: editRow});
  await f.context.openListingImageEdit('listing1');
  f.getElementById('listingImageFile').files = [{name: 'appeal.png', type: 'image/png', size: 1024}];
  await f.context.saveListingImage();
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].image_path, 'owner/uuid1.png');
  assert.deepEqual(f.removed, ['owner/old.jpg']);
  assert.match(f.messages.join(' '), /保存しました/);
});

test('saving an appeal image cleans up and reports preparation when the column is missing', async () => {
  const f = editFixture({uploadResult: {data: {path: 'owner/uuid1.png'}, error: null}, updateResult: {error: new Error('column listings.image_path does not exist')}, row: editRow});
  await f.context.openListingImageEdit('listing1');
  f.getElementById('listingImageFile').files = [{name: 'appeal.png', type: 'image/png', size: 1024}];
  await f.context.saveListingImage();
  assert.deepEqual(f.removed, ['owner/uuid1.png']);
  assert.match(f.messages.join(' '), /現在準備中です/);
});

test('migration adds image_path, exposes it in ranked search, and creates the listing-images bucket', () => {
  assert.match(migration, /add column if not exists image_path text/);
  assert.match(migration, /l\.image_path/);
  assert.match(migration, /create or replace function public\.search_voice_listings_ranked/);
  assert.match(migration, /'listing-images', 'listing-images', true, 5242880/);
  assert.match(migration, /listing-images owner insert/);
  assert.match(migration, /listing-images owner delete/);
});
