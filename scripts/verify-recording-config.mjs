import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export function verifyRecordingConfig(source, native, manifest){
 const html=String(source), swift=String(native);
 assert.equal(manifest.environment,'recording-sandbox');
 assert.equal(manifest.supabase_project_ref,'neotkrfsquysuatdruhg');
 for(const flag of ['recording_apple_purchases_enabled','recording_apple_recovery_enabled','recording_stripe_reads_enabled','recording_stripe_writes_enabled'])assert.equal(manifest[flag],false,'Recording permission must remain OFF: '+flag);
 assert.equal(manifest.public_release_allowed,false);
 assert.equal(manifest.production_backend_applied,false);
 assert.equal(manifest.voice_sales_enabled,false);
 assert.equal(manifest.boost_sales_enabled,false);
 assert.equal(manifest.admin_user_id,null);
 assert.equal(createHash('sha256').update(source).digest('hex'),manifest.web_sha256);
 assert.equal(createHash('sha256').update(native).digest('hex'),manifest.boost_native_sha256);
 assert.ok(!html.includes('tyulybijubckitybgubc'),'Production project appears in recording runtime');
 assert.ok(!html.includes('6454e07c-ed0b-46b7-a8a1-aa63c555d634'),'Production admin appears in recording runtime');
 for(const match of html.matchAll(/https:\/\/([a-z0-9]+)\.supabase\.co/g))assert.equal(match[1],manifest.supabase_project_ref);
 assert.ok(html.includes('SUPABASE_URL:"https://neotkrfsquysuatdruhg.supabase.co"'));
 assert.ok(html.includes('SUPABASE_PUBLISHABLE_KEY:"sb_publishable_4nQx8Tg-e7LFwRIjwgVL3g_uHnVSXK9"'));
 assert.ok(html.includes('ADMIN_USER_ID:null,RECORDING_APPLE_PURCHASES_ENABLED:false,RECORDING_APPLE_RECOVERY_ENABLED:false,RECORDING_STRIPE_READS_ENABLED:false,RECORDING_STRIPE_WRITES_ENABLED:false'));
 assert.ok(html.includes('function recordingStripeWritesAllowed(){return false}'));
 assert.ok(html.includes('await assertRecordingEnvironmentSafe();'));
 assert.ok(html.includes('id="recordingEnvironmentNotice"'));
 for(const name of ['recordingApplePurchasesEnabled','recordingAppleRecoveryEnabled','recordingStripeWritesEnabled'])assert.ok(swift.includes('private let '+name+' = false'));
 assert.ok(swift.includes('guard recordingApplePurchasesEnabled && recordingAppleRecoveryEnabled && !recordingStripeWritesEnabled else'));
 assert.ok(swift.includes('guard recordingAppleRecoveryEnabled && !recordingStripeWritesEnabled else'));
 assert.ok(swift.includes('private let recordingBackendProjectRef = \"neotkrfsquysuatdruhg\"'));
 assert.ok(swift.includes('private let recordingStoreKitEnvironment = \"Sandbox\"'));
}
