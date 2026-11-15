import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(process.env.HTML_PATH || new URL('../index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('let profileEditRevision='), html.indexOf('function openProfileSafety('));

function fixture() {
  const fields = new Map();
  const alerts = [];
  const updates = [];
  const uploads = [];
  const messages = [];
  const profile = {display_name: '審査用', profile_bio: '既存の自己紹介'};
  const overlayClasses = new Set();
  const getElementById = id => {
    if (!fields.has(id)) fields.set(id, {value: '', classList: {toggle() {}}});
    return fields.get(id);
  };
  getElementById('profileEditOverlay').classList = {add: name => overlayClasses.add(name), remove: name => overlayClasses.delete(name)};
  const upload = Promise.withResolvers();
  const context = vm.createContext({
    currentUser: {id: 'owner'}, authReloadPending: false,
    alert: message => alerts.push(message), esc: String, profileAvatarUrl: () => '',
    document: {getElementById}, crypto: {randomUUID: () => 'photo'},
    info: (_id, message) => messages.push(message), setTimeout: callback => callback(),
    async loadMe() {}, async loadListings() {},
    sb: {
      from: () => ({
        select: () => ({eq: () => ({maybeSingle: async () => context.readResult})}),
        update: values => ({eq: async (_key, owner) => { updates.push({owner, ...values}); return {}; }}),
      }),
      storage: {from: () => ({upload: path => { uploads.push(path); return upload.promise; }})},
    },
    readResult: {data: profile},
  });
  vm.runInContext(source, context);
  return {context, getElementById, alerts, updates, uploads, messages, overlayClasses, upload};
}

test('a profile read error does not offer to edit blank fields', async () => {
  const f = fixture();
  f.context.readResult = {data: null, error: new Error('read failed')};
  await f.context.openProfileEdit('審査用');
  assert.equal(f.overlayClasses.has('show'), false);
  assert.match(f.alerts[0], /プロフィールを読み込めません/);
});

for (const [description, changeDraft] of [
  ['closing the editor', f => f.context.closeProfileEdit()],
  ['changing the bio', f => { f.getElementById('profileBio').value = '新しい自己紹介'; }],
]) {
  test(`an older upload cannot overwrite the profile after ${description}`, async () => {
    const f = fixture();
    await f.context.openProfileEdit();
    f.getElementById('profileAvatarFile').files = [{name: 'camera.jpg', type: 'image/jpeg', size: 100}];
    const saving = f.context.saveBasicProfile();
    changeDraft(f);
    f.upload.resolve({});
    await saving;
    assert.deepEqual(f.updates, []);
  });
}

test('an unchanged draft still saves a camera photo with the existing profile fields', async () => {
  const f = fixture();
  await f.context.openProfileEdit();
  f.getElementById('profileAvatarFile').files = [{name: 'camera.jpg', type: 'image/jpeg', size: 100}];
  const saving = f.context.saveBasicProfile();
  f.upload.resolve({});
  await saving;
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].owner, 'owner');
  assert.equal(f.updates[0].avatar_path, 'owner/photo.jpg');
  assert.equal(f.updates[0].profile_bio, '既存の自己紹介');
});

test('repeated taps during upload cause only one upload and one profile update', async () => {
  const f = fixture();
  await f.context.openProfileEdit();
  f.getElementById('profileAvatarFile').files = [{name: 'camera.jpg', type: 'image/jpeg', size: 100}];
  const saving = f.context.saveBasicProfile();
  const repeat = f.context.saveBasicProfile();
  const button = f.getElementById('profileSaveBtn');
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '保存中…');
  f.upload.resolve({});
  await Promise.all([saving, repeat]);
  assert.deepEqual(f.uploads, ['owner/photo.jpg']);
  assert.equal(f.updates.length, 1);
  assert.equal(button.disabled, false);
  assert.equal(f.overlayClasses.has('show'), false);
});

test('an interrupted upload keeps the editor open and lets the user try again', async () => {
  const f = fixture();
  await f.context.openProfileEdit();
  const photo = {name: 'camera.jpg', type: 'image/jpeg', size: 100};
  const input = f.getElementById('profileAvatarFile');
  input.files = [photo];
  const saving = f.context.saveBasicProfile();
  f.upload.reject(new Error('connection dropped'));
  await saving;
  assert.deepEqual(f.updates, []);
  assert.equal(f.getElementById('profileSaveBtn').disabled, false);
  assert.equal(f.overlayClasses.has('show'), true);
  assert.equal(input.files[0], photo);
  assert.match(f.messages.at(-1), /もう一度お試しください/);
});
