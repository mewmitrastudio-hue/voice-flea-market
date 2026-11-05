import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const swift=fs.readFileSync(new URL('../BoostPlugin.swift',import.meta.url),'utf8');
const source=html.slice(html.indexOf('const localStateCache='),html.indexOf('const volatileUIState='));
for(const prefix of ['pending_purchase_','checkout_attempt_','voice_attempt_','boost_attempt_','financial_resolution_pending_','message_attempt_'])test('sandbox scopes '+prefix+' without reading, overwriting or deleting legacy data',()=>{
 const key='vf_'+prefix+'owner', scoped='vf_scoped_neotkrfsquysuatdruhg_'+key;
 const data=new Map([[key,'original-environment-record']]);
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k),get length(){return data.size},key:i=>[...data.keys()][i]??null};
 const ctx=vm.createContext({window:{localStorage:storage,VOICE_FLEA_CONFIG:{ENVIRONMENT:'recording-sandbox'}}});
 vm.runInContext(source+';globalThis.store=safeLocalStorage',ctx);const s=ctx.store;
 assert.equal(s.getItem(key),null);assert.equal(s.durableGetItem(key),null);
 s.durableSetItem(key,'sandbox-record');assert.equal(data.get(scoped),'sandbox-record');assert.equal(data.get(key),'original-environment-record');
 assert.equal(s.getItem(key),'sandbox-record');s.durableRemoveItem(key);assert.equal(data.get(key),'original-environment-record');assert.equal(data.has(scoped),false);
 s.setItem(key,'new-sandbox-record');assert.equal(data.get(scoped),'new-sandbox-record');s.removeItem(key);assert.equal(data.get(key),'original-environment-record');
});
test('foreign scoped records retain the startup barrier; current namespace is not falsely migrated',async()=>{
 const gate=html.slice(html.indexOf('async function assertRecordingEnvironmentSafe(){'),html.indexOf('async function init(){'));
 for(const [key,blocked] of [['vf_scoped_aaaaaaaaaaaaaaaaaaaa_vf_pending_purchase_owner',true],['vf_scoped_neotkrfsquysuatdruhg_vf_pending_purchase_owner',false]]){
  const ctx=vm.createContext({cfg:{ENVIRONMENT:'recording-sandbox',SUPABASE_URL:'https://neotkrfsquysuatdruhg.supabase.co',RECORDING_APPLE_PURCHASES_ENABLED:false,RECORDING_APPLE_RECOVERY_ENABLED:false,RECORDING_STRIPE_READS_ENABLED:false,RECORDING_STRIPE_WRITES_ENABLED:false},window:{localStorage:{length:1,key:()=>key}}});vm.runInContext(html.slice(html.indexOf('function recordingBackendMatches('),html.indexOf("function esc(s='')"))+gate,ctx);
  if(blocked)await assert.rejects(ctx.assertRecordingEnvironmentSafe(),/以前の環境/);else await ctx.assertRecordingEnvironmentSafe();
 }
});
test('native source contract preserves one global journal, optional legacy decoding and exact versioned ownership',()=>{
 assert.match(swift,/let schemaVersion: Int\?/);assert.match(swift,/let backendProjectRef: String\?/);assert.match(swift,/let storeKitEnvironment: String\?/);
 assert.match(swift,/attempt.schemaVersion == 2, attempt.backendProjectRef == backendProjectRef/);
 assert.match(swift,/attempt.storeKitEnvironment == environment/);
 assert.equal((swift.match(/appendingPathComponent\("koe-purchase-attempt.json"\)/g)||[]).length,1);
 assert.match(swift,/guard try read\(backendProjectRef: backendProjectRef, environment: environment\) == nil/);
 assert.match(swift,/environment == recordingStoreKitEnvironment/);
});
test('native finish source contract persists exact grant before StoreKit finish, then clears exact record',()=>{
 const body=swift.slice(swift.indexOf('private func finishOwnedTransaction'),swift.indexOf('@objc func finish'));
 assert.ok(body.indexOf('journal.recordVerifiedGrant(')<body.indexOf('await transaction.finish()'));
 assert.ok(body.indexOf('await transaction.finish()')<body.indexOf('journal.clearFinished('));
 assert.match(swift,/attempt.transactionID == transactionID/);
 assert.match(swift,/guard attempt.transactionID == raw else/);
 assert.match(swift,/for await result in Transaction.all/);
 assert.doesNotMatch(swift,/journal\.clear\(/);
 assert.match(swift,/transaction.environment == \.sandbox/);
 assert.match(swift,/guard isRecordingTransaction\(transaction\), let ownedAttempt = attempt/);
});
test('finished consumable recovery is opted in; unsupported history remains a blocking error',()=>{
 const plist=fs.readFileSync(new URL('../ios/App/App/Info.plist',import.meta.url),'utf8');
 assert.match(plist,/<key>SKIncludeConsumableInAppPurchaseHistory<\/key>\s*<true\s*\/>/);
 assert.match(swift,/guard matchingTransaction else/);
 assert.match(swift,/private let recordingApplePurchasesEnabled = false/);
 assert.match(swift,/guard #available\(iOS 18\.0, \*\) else/);
 assert.match(swift,/if #available\(iOS 18\.0, \*\) \{ return transaction.environment == \.sandbox \}/);
});
