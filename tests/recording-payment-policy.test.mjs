import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const policy=html.slice(html.indexOf('function recordingBackendMatches('),html.indexOf("function esc(s='')"));
const base={ENVIRONMENT:'recording-sandbox',SUPABASE_URL:'https://neotkrfsquysuatdruhg.supabase.co',RECORDING_APPLE_PURCHASES_ENABLED:false,RECORDING_APPLE_RECOVERY_ENABLED:false,RECORDING_STRIPE_READS_ENABLED:false,RECORDING_STRIPE_WRITES_ENABLED:false};
const functionSource=name=>{const start=html.indexOf('async function '+name+'(');return html.slice(start,html.indexOf('\n}',start)+2)};
function context(config,extra={}){const ctx=vm.createContext({window:{VOICE_FLEA_CONFIG:config},...extra});vm.runInContext(policy,ctx);return ctx;}
for(const purchases of [false,true])for(const recovery of [false,true])for(const reads of [false,true])test(`permission matrix purchase=${purchases}, recovery=${recovery}, reads=${reads}`,()=>{
 const c=context({...base,RECORDING_APPLE_PURCHASES_ENABLED:purchases,RECORDING_APPLE_RECOVERY_ENABLED:recovery,RECORDING_STRIPE_READS_ENABLED:reads});
 assert.equal(c.recordingApplePurchasesAllowed(),purchases&&recovery);
 assert.equal(c.recordingAppleRecoveryAllowed(),recovery);
 assert.equal(c.recordingStripeReadsAllowed(),reads);
 assert.equal(c.recordingStripeWritesAllowed(),false);
});
for(const config of [undefined,null,{}, {...base,ENVIRONMENT:'production'}, {...base,SUPABASE_URL:'https://other.supabase.co'}, {...base,RECORDING_STRIPE_WRITES_ENABLED:true},{...base,RECORDING_STRIPE_WRITES_ENABLED:undefined}])test('unknown or incorrect provenance fails closed '+JSON.stringify(config),()=>{
 const c=context(config);for(const method of ['recordingApplePurchasesAllowed','recordingAppleRecoveryAllowed','recordingStripeReadsAllowed','recordingStripeWritesAllowed'])assert.equal(c[method](),false);
});
test('non-boolean enable values never grant permission',()=>{
 for(const value of ['true',1,{},[],null,undefined]){
  const c=context({...base,RECORDING_APPLE_PURCHASES_ENABLED:value,RECORDING_APPLE_RECOVERY_ENABLED:value,RECORDING_STRIPE_READS_ENABLED:value});
  assert.equal(c.recordingApplePurchasesAllowed(),false);assert.equal(c.recordingAppleRecoveryAllowed(),false);assert.equal(c.recordingStripeReadsAllowed(),false);
 }
});
for(const name of ['connectStripeSeller','adminRefundPayment','startStripeCheckout','requestAuthorizationCancellation','renewTradeAuthorization'])test(name+' stays blocked even with Apple and Stripe reads enabled or malicious write toggle',async()=>{
 for(const writes of [false,true,undefined]){
  const notices=[];const c=context({...base,RECORDING_APPLE_PURCHASES_ENABLED:true,RECORDING_APPLE_RECOVERY_ENABLED:true,RECORDING_STRIPE_READS_ENABLED:true,RECORDING_STRIPE_WRITES_ENABLED:writes},{alert:t=>notices.push(t)});
  vm.runInContext(functionSource(name),c);await c[name]();assert.equal(notices.length,1);
 }
});
test('native purchase route reaches Apple policy, never the blocked Web checkout',async()=>{
 const calls=[];const c=context({...base,RECORDING_APPLE_PURCHASES_ENABLED:true,RECORDING_APPLE_RECOVERY_ENABLED:true},{startVoicePurchase:async(...args)=>calls.push(args)});
 c.window.Capacitor={isNativePlatform:()=>true,getPlatform:()=>'ios'};vm.runInContext(functionSource('startStripeCheckout'),c);
 await c.startStripeCheckout('listing',null,'application');assert.deepEqual(calls,[['listing','application']]);
});
for(const name of ['purchaseBoost','startVoicePurchase','confirmVoicePurchase','reconcileVoicePurchases','reconcileBoostPurchases','acceptDeliveryConfirmed'])test(name+' fails closed with absent configuration',async()=>{
 const notices=[];const c=context(undefined,{alert:t=>notices.push(t)});vm.runInContext(functionSource(name),c);await c[name]();assert.equal(notices.length,1);
});
test('Stripe status read is independent of Apple enable and sends only status',async()=>{
 const bodies=[];const c=context({...base,RECORDING_STRIPE_READS_ENABLED:true},{currentUser:{id:'seller'},sb:{auth:{getSession:async()=>({data:{session:{access_token:'test-session',user:{id:'seller'}}}})},functions:{invoke:async(name,args)=>{assert.equal(name,'create-connect-account');bodies.push(args.body);return {data:{verified:false}}}}}});
 vm.runInContext(functionSource('getStripeSellerStatus'),c);assert.equal((await c.getStripeSellerStatus()).verified,false);
 assert.equal(bodies.length,1);assert.equal(bodies[0].action,'status');assert.deepEqual(Object.keys(bodies[0]),['action']);
 assert.equal(c.recordingStripeWritesAllowed(),false);
});
test('a missing unrelated permission field invalidates configuration rather than granting partial access',()=>{
 for(const key of ['RECORDING_APPLE_PURCHASES_ENABLED','RECORDING_APPLE_RECOVERY_ENABLED','RECORDING_STRIPE_READS_ENABLED','RECORDING_STRIPE_WRITES_ENABLED']){
  const cfg={...base,RECORDING_APPLE_PURCHASES_ENABLED:true,RECORDING_APPLE_RECOVERY_ENABLED:true,RECORDING_STRIPE_READS_ENABLED:true};delete cfg[key];const c=context(cfg);
  assert.equal(c.recordingApplePurchasesAllowed(),false);assert.equal(c.recordingAppleRecoveryAllowed(),false);assert.equal(c.recordingStripeReadsAllowed(),false);assert.equal(c.recordingStripeWritesAllowed(),false);
 }
});
