import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const plist = readFileSync(new URL('../ios/App/App/Info.plist', import.meta.url), 'utf8');
const packageSwift = readFileSync(new URL('../ios/App/CapApp-SPM/Package.swift', import.meta.url), 'utf8');
const prepare = readFileSync(new URL('../scripts/prepare-native-release.mjs', import.meta.url), 'utf8');

const faceIdSrc = html.slice(html.indexOf('const FACE_ID_SERVER='), html.indexOf('// Account deletion must be performed'));

test('the biometric plugin is a declared dependency and registered in the iOS SPM project', () => {
  assert.ok(pkg.dependencies['@capgo/capacitor-native-biometric'], 'plugin dependency present');
  assert.match(packageSwift, /CapgoCapacitorNativeBiometric/);
});

test('Info.plist explains Face ID use and the release script enforces it', () => {
  assert.match(plist, /<key>NSFaceIDUsageDescription<\/key>\s*<string>\s*[^<\s][^<]*<\/string>/);
  assert.match(prepare, /\['NSFaceIDUsageDescription','Face ID'\]/);
});

test('login screen, menu and settings overlay expose the Face ID entry points', () => {
  assert.match(html, /id="faceIdLoginBtn" class="btn secondary full hide"[^>]*onclick="signInWithFaceId\(\)"/);
  assert.match(html, /id="faceIdMenuBtn"[^>]*onclick="closeMainMenu\(\);openFaceIdSettings\(\)"/);
  assert.match(html, /id="faceIdOverlay" class="vf-confirm-overlay"/);
  assert.match(html, /id="faceIdPassword" type="password"/);
  // Password sign-in offers enrollment with the credentials just used.
  const signInSrc = html.slice(html.indexOf('async function signIn('), html.indexOf('const FACE_ID_SERVER='));
  assert.match(signInSrc, /void maybeEnrollFaceId\(signedInEmail,signedInPassword\);/);
});

function storageStub(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    map,
  };
}

function faceIdContext({native = false, storage = {}, plugin = null, confirmResult = true, sbAuth = null} = {}) {
  const calls = {infos: [], confirms: [], signIns: []};
  const button = {classes: new Set(['hide']), classList: {toggle(cls, on) { on ? this.classes.add(cls) : this.classes.delete(cls); }, }, };
  button.classList.classes = button.classes;
  const context = vm.createContext({
    window: native ? {Capacitor: {isNativePlatform: () => true, getPlatform: () => 'ios'}} : {},
    document: {getElementById: id => (id === 'faceIdLoginBtn' ? button : null)},
    safeLocalStorage: storageStub(storage),
    sb: {auth: {signInWithPassword: sbAuth || (async creds => { calls.signIns.push(creds); return {error: null}; })}},
    info: (id, msg, kind) => calls.infos.push([msg, kind]),
    confirm: msg => { calls.confirms.push(msg); return confirmResult; },
    resetLoginZoom: () => {},
    currentUser: {id: 'user-1', email: 'a@example.com'},
    console: {warn: () => {}},
  });
  vm.runInContext(faceIdSrc, context);
  if (plugin) vm.runInContext(`faceIdNativePlugin = (${'null'});`, context);
  return {context, calls, button};
}

function setPlugin(context, plugin) {
  context.__plugin = plugin;
  vm.runInContext('faceIdNativePlugin = __plugin;', context);
}

test('on web (no Capacitor) Face ID stays silently unavailable and the button stays hidden', async () => {
  const {context, button} = faceIdContext({storage: {vf_faceid_enabled_email: 'a@example.com'}});
  assert.equal(context.isFaceIdPlatform(), false);
  assert.equal(await context.faceIdAvailable(), false);
  await context.refreshFaceIdLoginButton();
  assert.ok(button.classes.has('hide'), 'button remains hidden without the native plugin');
});

test('Face ID sign-in uses the credentials stored in the keychain', async () => {
  const {context, calls} = faceIdContext({native: true});
  setPlugin(context, {
    isAvailable: async () => ({isAvailable: true}),
    getCredentials: async () => ({username: 'a@example.com', password: 'secret123'}),
  });
  await context.signInWithFaceId();
  assert.equal(JSON.stringify(calls.signIns), JSON.stringify([{email: 'a@example.com', password: 'secret123'}]));
  assert.deepEqual(calls.infos, []);
});

test('stale stored credentials are wiped and the user is sent back to password sign-in', async () => {
  let deleted = 0;
  const {context, calls} = faceIdContext({
    native: true,
    storage: {vf_faceid_enabled_email: 'a@example.com'},
    sbAuth: async () => ({error: new Error('invalid credentials')}),
  });
  setPlugin(context, {
    isAvailable: async () => ({isAvailable: true}),
    getCredentials: async () => ({username: 'a@example.com', password: 'oldpass'}),
    deleteCredentials: async () => { deleted++; },
  });
  await context.signInWithFaceId();
  assert.equal(deleted, 1);
  assert.equal(vm.runInContext('faceIdEnrolledEmail()', context), '');
  assert.ok(calls.infos.some(([msg, kind]) => kind === 'err' && msg.includes('パスワードでログインし直してください')));
});

test('enrollment after password sign-in asks once, verifies identity and stores credentials', async () => {
  const stored = [];
  const {context, calls} = faceIdContext({native: true});
  setPlugin(context, {
    isAvailable: async () => ({isAvailable: true}),
    verifyIdentity: async () => {},
    setCredentials: async creds => stored.push(creds),
  });
  await context.maybeEnrollFaceId('a@example.com', 'secret123');
  assert.equal(calls.confirms.length, 1);
  assert.equal(JSON.stringify(stored), JSON.stringify([{username: 'a@example.com', password: 'secret123', server: 'koe-furima.com'}]));
  assert.equal(vm.runInContext('faceIdEnrolledEmail()', context), 'a@example.com');
});

test('a declined offer is remembered and never re-asked; a different account is left alone', async () => {
  const stored = [];
  const declined = faceIdContext({native: true, confirmResult: false});
  setPlugin(declined.context, {
    isAvailable: async () => ({isAvailable: true}),
    verifyIdentity: async () => { throw new Error('must not be called'); },
    setCredentials: async creds => stored.push(creds),
  });
  await declined.context.maybeEnrollFaceId('a@example.com', 'secret123');
  assert.equal(declined.calls.confirms.length, 1);
  assert.equal(stored.length, 0);
  await declined.context.maybeEnrollFaceId('a@example.com', 'secret123');
  assert.equal(declined.calls.confirms.length, 1, 'no second prompt after declining');

  const other = faceIdContext({native: true, storage: {vf_faceid_enabled_email: 'someone@example.com'}});
  setPlugin(other.context, {
    isAvailable: async () => ({isAvailable: true}),
    verifyIdentity: async () => { throw new Error('must not be called'); },
    setCredentials: async creds => stored.push(creds),
  });
  await other.context.maybeEnrollFaceId('a@example.com', 'secret123');
  assert.equal(other.calls.confirms.length, 0);
  assert.equal(stored.length, 0);
});

test('re-login with the enrolled account silently refreshes the stored password', async () => {
  const stored = [];
  const {context, calls} = faceIdContext({native: true, storage: {vf_faceid_enabled_email: 'a@example.com'}});
  setPlugin(context, {
    isAvailable: async () => ({isAvailable: true}),
    setCredentials: async creds => stored.push(creds),
  });
  await context.maybeEnrollFaceId('a@example.com', 'newpass456');
  assert.equal(calls.confirms.length, 0, 'no prompt for an already-enrolled account');
  assert.equal(JSON.stringify(stored), JSON.stringify([{username: 'a@example.com', password: 'newpass456', server: 'koe-furima.com'}]));
});
