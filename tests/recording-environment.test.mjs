import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {verifyRecordingConfig} from '../scripts/verify-recording-config.mjs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const swift=fs.readFileSync(new URL('../BoostPlugin.swift',import.meta.url),'utf8');
const manifest=JSON.parse(fs.readFileSync(new URL('../release-manifest.json',import.meta.url),'utf8'));
const disabledFlags={RECORDING_APPLE_PURCHASES_ENABLED:false,RECORDING_APPLE_RECOVERY_ENABLED:false,RECORDING_STRIPE_READS_ENABLED:false,RECORDING_STRIPE_WRITES_ENABLED:false};
const nativeFlags={applePurchasesEnabled:false,appleRecoveryEnabled:false,stripeWritesEnabled:false};
const policySource=html.slice(html.indexOf('function recordingBackendMatches('),html.indexOf("function esc(s='')"));
function policyContext(values){const ctx=vm.createContext(values);vm.runInContext(policySource,ctx);return ctx;}
const gate=html.slice(html.indexOf('async function assertRecordingEnvironmentSafe(){'),html.indexOf('async function init(){'));
function harness({keys=[],native=false,pending={purchaseBlocked:false,approvalPending:false,transactions:[],blockingKind:'',journalPresent:false,journalVersion:2,backendProjectRef:'neotkrfsquysuatdruhg',environment:'Sandbox',...nativeFlags},storageError=false,pluginError=false,url='https://neotkrfsquysuatdruhg.supabase.co'}={}){
 let calls=0;const storage={get length(){if(storageError)throw Error('storage unavailable');return keys.length},key:i=>keys[i]};
 const cfg={ENVIRONMENT:'recording-sandbox',SUPABASE_URL:url,...disabledFlags};
 const context=policyContext({cfg,recordingAuthKey:'new-scope',recordingAuthStorage:{getItem:()=>null},window:{VOICE_FLEA_CONFIG:cfg,localStorage:storage,Capacitor:{isNativePlatform:()=>native,getPlatform:()=> 'ios'}},boostRead:action=>action(),nativeBoost:async()=>({plugin:{pendingTransactions:async()=>{calls++;if(pluginError)throw Error('native check failed');return pending}}})});
 vm.runInContext(gate,context);return {run:()=>context.assertRecordingEnvironmentSafe(),calls:()=>calls,keys};
}
test('recording configuration is locked to isolated project and sales off',()=>{
 verifyRecordingConfig(html,swift,manifest);
 for(const change of [{environment:'production'},{supabase_project_ref:'wrong'},{recording_apple_purchases_enabled:true},{recording_apple_recovery_enabled:true},{recording_stripe_reads_enabled:true},{recording_stripe_writes_enabled:true},{public_release_allowed:true},{voice_sales_enabled:true},{boost_sales_enabled:true},{admin_user_id:'production-admin'},{production_backend_applied:true}])assert.throws(()=>verifyRecordingConfig(html,swift,{...manifest,...change}));
 assert.ok(html.indexOf('await assertRecordingEnvironmentSafe();')<html.indexOf('sb=sb||window.supabase.createClient'));
});
test('empty device passes web and native read-only preflight',async()=>{
 await harness().run();const h=harness({native:true});await h.run();assert.equal(h.calls(),1);
});
for(const prefix of ['pending_purchase_','checkout_attempt_','voice_attempt_','boost_attempt_','financial_resolution_pending_','message_attempt_'])test('legacy '+prefix+' blocks without clearing or native replay',async()=>{
 const keys=['vf_'+prefix+'owner'];const h=harness({keys,native:true});await assert.rejects(h.run(),/以前の環境/);assert.equal(h.calls(),0);assert.deepEqual(keys,['vf_'+prefix+'owner']);
});
test('storage failure and wrong backend fail closed',async()=>{
 await assert.rejects(harness({storageError:true}).run());await assert.rejects(harness({url:'https://other.supabase.co'}).run(),/設定/);
});
for(const pending of [null,{}, {purchaseBlocked:true,approvalPending:false,transactions:[]},{purchaseBlocked:false,approvalPending:true,transactions:[]},{purchaseBlocked:false,approvalPending:false,transactions:[{transactionId:'old'}]}])test('unknown or unresolved native state cannot connect to sandbox '+JSON.stringify(pending),async()=>{
 await assert.rejects(harness({native:true,pending}).run(),/購入/);
});
test('native check error fails closed',async()=>{await assert.rejects(harness({native:true,pluginError:true}).run());});
test('recording locks native purchase and finish but leaves original journal intact',()=>{
 assert.ok(swift.includes('private let recordingApplePurchasesEnabled = false'));
 assert.ok(swift.includes('private let recordingAppleRecoveryEnabled = false'));
 assert.ok(swift.includes('koe-purchase-attempt.json'));
 for(const name of ['purchase','finish']){
  const body=swift.slice(swift.indexOf('@objc func '+name+'('));assert.ok(body.indexOf(name==='purchase'?'guard recordingApplePurchasesEnabled':'guard recordingAppleRecoveryEnabled')<body.indexOf('do {'));
 }
});
for(const name of ['connectStripeSeller','startStripeCheckout','purchaseBoost','reconcileBoostPurchases','startVoicePurchase','confirmVoicePurchase','reconcileVoicePurchases','renewTradeAuthorization','requestAuthorizationCancellation','adminRefundPayment','acceptDeliveryConfirmed'])test(name+' is blocked before any external operation',async()=>{
 const start=html.indexOf('async function '+name+'('), end=html.indexOf('\n}',start)+2;
 const notices=[];const context=policyContext({window:{VOICE_FLEA_CONFIG:{...disabledFlags}},alert:text=>notices.push(text)});
 vm.runInContext(html.slice(start,end),context);await context[name]();assert.equal(notices.length,1);assert.match(notices[0],/準備中/);
});
test('Stripe status never implies readiness or calls an external service',async()=>{
 const start=html.indexOf('async function getStripeSellerStatus(){'),end=html.indexOf('\n}',start)+2;
 const context=policyContext({window:{VOICE_FLEA_CONFIG:{...disabledFlags}}});vm.runInContext(html.slice(start,end),context);
 assert.equal((await context.getStripeSellerStatus()).verified,false);
});
test('proven same-sandbox v2 pending records may connect for recovery without enabling sales',async()=>{
 for(const approvalPending of [true,false])await harness({native:true,pending:{purchaseBlocked:true,approvalPending,transactions:approvalPending?[]:[{transactionId:'123'}],blockingKind:'voice',journalPresent:true,journalVersion:2,backendProjectRef:'neotkrfsquysuatdruhg',environment:'Sandbox',...nativeFlags}}).run();
});
test('foreign, legacy, missing and inconsistent provenance cannot bypass preflight',async()=>{
 const base={purchaseBlocked:false,approvalPending:false,transactions:[],blockingKind:'',journalPresent:false,journalVersion:2,backendProjectRef:'neotkrfsquysuatdruhg',environment:'Sandbox',...nativeFlags};
 for(const delta of [{backendProjectRef:'other'},{environment:'Production'},{journalVersion:1},{journalPresent:undefined},{purchaseBlocked:true},{journalPresent:true},{approvalPending:true},{transactions:[{transactionId:'orphan'}]}])await assert.rejects(harness({native:true,pending:{...base,...delta}}).run(),/購入記録/);
});
test('native/web permission mismatch blocks connection even with correct project and journal',async()=>{
 const base={purchaseBlocked:false,approvalPending:false,transactions:[],blockingKind:'',journalPresent:false,journalVersion:2,backendProjectRef:'neotkrfsquysuatdruhg',environment:'Sandbox',...nativeFlags};
 for(const delta of [{applePurchasesEnabled:true},{appleRecoveryEnabled:true},{stripeWritesEnabled:true},{applePurchasesEnabled:undefined},{appleRecoveryEnabled:undefined},{stripeWritesEnabled:undefined}])await assert.rejects(harness({native:true,pending:{...base,...delta}}).run(),/購入記録/);
});
