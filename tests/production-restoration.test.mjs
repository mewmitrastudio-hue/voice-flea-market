import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const swift=fs.readFileSync(new URL('../BoostPlugin.swift',import.meta.url),'utf8');
const manifest=JSON.parse(fs.readFileSync(new URL('../release-manifest.json',import.meta.url),'utf8'));
test('normal production app uses original backend and full application without recording/auth-only restrictions',()=>{
 assert.match(html,/SUPABASE_URL:"https:\/\/tyulybijubckitybgubc.supabase.co"/);
 assert.match(html,/VOICE_FLEA_ADMIN_USER_ID='6454e07c-ed0b-46b7-a8a1-aa63c555d634'/);
 assert.doesNotMatch(html,/neotkrfsquysuatdruhg|originalOperatorAccessOnly|recordingAuthOptions|assertRecordingEnvironmentSafe/);
 for(const id of ['home','voices','sell','jobs','messages','me'])assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(html,/voice-iap/);assert.match(html,/boost-iap/);
 assert.equal(manifest.source_base_commit,'e326891518cf63aa69d414a394f144b173cbf3b6');
 assert.equal(manifest.voice_sales_enabled,false);assert.equal(manifest.boost_sales_enabled,false);
 assert.equal(manifest.public_release_allowed,false);
});
for(const native of [true,false])test(`${native?'native':'web'} authentication keeps normal application navigation and separates purchase replay`,async()=>{
 const calls=[];const el={classList:{add(){},remove(){}},textContent:''};
 const ctx=vm.createContext({authUIRevision:1,currentUser:{id:'operator',email:'synthetic@example.invalid'},authReloadPending:false,window:{Capacitor:{isNativePlatform:()=>native}},document:{getElementById:()=>el},authPage:el,nav:el,cloudStatus:el,setAdminMenuVisibility(){calls.push('admin')},loadHome:async()=>calls.push('home'),loadJobBadge:async()=>calls.push('jobs'),loadMessageBadge:async()=>calls.push('messages'),loadNotificationBadge:async()=>calls.push('notifications'),restoreUI:async()=>calls.push('normal-ui'),reconcilePendingPurchase:async()=>calls.push('purchase-replay'),openAdminSupportFromHash(){calls.push('support')}});
 vm.runInContext(html.slice(html.indexOf('async function renderAuth(){'),html.indexOf('async function signUp(){')),ctx);
 await ctx.renderAuth();assert(calls.includes('home'));assert(calls.includes('normal-ui'));assert(calls.includes('support'));
 assert.equal(calls.includes('purchase-replay'),!native);
});
test('malformed pending checkout is retained byte for byte rather than deleted',async()=>{
 const original='UNDECODABLE EXACT PURCHASE BYTES';let value=original,requests=0;
 const ctx=vm.createContext({pageNavigationRequest:0,currentUser:{id:'owner'},safeLocalStorage:{getItem:()=>value,removeItem:()=>{value=null}},sb:{from(){requests++;throw Error('Do not read')}}});
 vm.runInContext(html.slice(html.indexOf('async function reconcilePendingPurchase('),html.indexOf('async function getFavoriteListingIds(')),ctx);
 assert.equal(await ctx.reconcilePendingPurchase(),null);assert.equal(value,original);assert.equal(requests,0);
});
test('native preserves single journal and rejects missing or foreign provenance without migration',()=>{
 assert.match(swift,/private let backendProjectRef = "tyulybijubckitybgubc"/);
 assert.match(swift,/attempt.schemaVersion == 2, attempt.backendProjectRef == backendProjectRef/);
 assert.match(swift,/attempt.storeKitEnvironment == environment/);
 assert.equal((swift.match(/appendingPathComponent\("koe-purchase-attempt.json"\)/g)||[]).length,1);
 assert.doesNotMatch(swift,/recording|neotkrfsquysuatdruhg|originalOperatorAccessOnly/);
 assert.match(swift,/guard try read\(backendProjectRef: backendProjectRef, environment: environment\) == nil/);
 const boot=html.slice(html.indexOf('async function init(){'),html.indexOf('async function signUp(){'));
 assert.doesNotMatch(boot,/nativeBoost|pendingTransactions|purchaseJournal|\.clear\(/);
});
test('native actual transaction environment and exact grant are checked before finish and journal removal',()=>{
 assert.match(swift,/environment == "Sandbox" && transaction.environment == \.sandbox/);
 assert.match(swift,/environment == "Production" && transaction.environment == \.production/);
 assert.match(swift,/guard isTransaction\(transaction, environment: environment, signed: result.jwsRepresentation\)/);
 const body=swift.slice(swift.indexOf('private func finishOwnedTransaction'),swift.indexOf('@objc func finish'));
 assert(body.indexOf('journal.recordVerifiedGrant(')<body.indexOf('await transaction.finish()'));
 assert(body.indexOf('await transaction.finish()')<body.indexOf('journal.clearFinished('));
 assert.match(swift,/guard attempt.transactionID == raw else/);
 assert.doesNotMatch(swift,/journal\.clear\(/);
});
for(const action of ['purchaseBoost','confirmVoicePurchase','reconcileVoicePurchases'])test(action+' preserves journal when account changes during successful server verification',async()=>{
 const events=[],storage=new Map([['pending','exact old journal bytes']]);
 const plugin={pendingTransactions:async()=>({transactions:[{signedTransaction:'signed',transactionId:'tx'}]}),purchase:async()=>({status:'purchased',signedTransaction:'signed',transactionId:'tx'}),finish:async()=>events.push('finish')};
 const node={hidden:false,value:'listing',classList:{add(){},remove(){}}};
 const ctx=vm.createContext({currentUser:{id:'owner'},setTimeout,clearTimeout,document:{getElementById:()=>node},voicePurchaseRequest:1,voicePurchaseBusy:false,voicePurchaseQuote:{owner:'owner',request:1,plugin,key:'pending'},voicePurchasePhase:null,voicePurchaseNotice(){},showVoicePurchase(){},isNativeBoost:()=>true,nativeBoost:async()=>({plugin}),voicePreparationWait:fn=>fn(),safeLocalStorage:{removeItem:k=>storage.delete(k)},boostRead:fn=>fn(),boostBusy:false,boostReady:true,boostHistoryReady:true,boostRequest:1,boostPurchasePlan:null,boostEnvironment:'Sandbox',boostActiveListing:()=>false,boostListingChanged(){},boostNotice(){},alert(){},openBoostPreview:async()=>{},formatJpDateTime:()=>''});
 ctx.voiceIapApi=async()=>{events.push('verify');ctx.currentUser={id:'other'};return {success:true,paymentId:'payment'}};
 ctx.boostApi=async body=>{if(body.action==='prepare')return {orderId:'order',productId:'product',environment:'Sandbox'};events.push('verify');ctx.currentUser={id:'other'};return {success:true}};
 let source;
 if(action==='purchaseBoost'){plugin.pendingTransactions=async()=>({transactions:[]});source=html.slice(html.indexOf('async function purchaseBoost('),html.indexOf('async function reconcileBoostPurchases('));}
 if(action==='confirmVoicePurchase')source=html.slice(html.indexOf('async function confirmVoicePurchase('),html.indexOf('async function reconcileVoicePurchases('));
 if(action==='reconcileVoicePurchases')source=html.slice(html.indexOf('async function reconcileVoicePurchases('),html.indexOf('</script>',html.indexOf('async function reconcileVoicePurchases(')));
 vm.runInContext(source,ctx);await ctx[action]('silver');assert.deepEqual(events,['verify']);assert.equal(storage.get('pending'),'exact old journal bytes');
});
test('point-of-charge recheck rejects unknown verified SKUs as well as unverified unfinished transactions',()=>{
 const purchase=swift.slice(swift.indexOf('@objc func purchase('),swift.indexOf('@objc func pendingTransactions('));
 const check=purchase.slice(purchase.indexOf('for await outstanding in Transaction.unfinished'),purchase.indexOf('let journal = try purchaseJournal()'));
 assert.match(check,/case \.verified:\s*\/\/[^\n]*\n\s*call.reject/);
 assert.match(check,/case \.unverified:\s*call.reject/);
 assert.doesNotMatch(check,/if isAllowed/);
 assert(check.indexOf('call.reject')<check.length);
});
