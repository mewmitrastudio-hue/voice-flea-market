import {paymentBehaviorContext} from './fixtures/payment-behavior-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function showCheckoutError('),html.indexOf('async function reconcilePendingPurchase('));
const navigation=html.split('\n').find(line=>line.startsWith('async function go(id,opts={})'));
const buyer='00000000-0000-4000-8000-000000000001',listing='00000000-0000-4000-8000-000000000002',attempt='00000000-0000-4000-8000-000000000003';
function deferred(){let resolve,reject;return {promise:new Promise((a,b)=>{resolve=a;reject=b}),resolve,reject}}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const reply=data=>({ok:true,status:200,text:async()=>JSON.stringify(data)});
function fixture(){
 const storage=new Map(),redirects=[],requests=[],elements=new Map();let page='voices';
 const element=id=>{if(!elements.has(id)){const classes=new Set();elements.set(id,{id,disabled:false,textContent:'',scrollTop:0,classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(){}},setAttribute(){}})}return elements.get(id)};
 const button={disabled:false,textContent:'購入する'};
 const c=paymentBehaviorContext({pageNavigationRequest:0,pageHistory:[],currentUser:{id:buyer},selectedListingId:null,URL,crypto:{randomUUID:()=>attempt},safeLocalStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},console:{error(){}},alert:()=>assert.fail('unexpected alert'),window:{VOICE_FLEA_CONFIG:{SUPABASE_URL:'https://unit.invalid',SUPABASE_PUBLISHABLE_KEY:'unit'},location:{assign:url=>redirects.push(url)},scrollTo(){}},document:{body:element('body'),getElementById:element,querySelector:selector=>selector==='.page.on'?{id:page}:element('app'),querySelectorAll:()=>[]},setShellMode(){},updateGlobalPageNav:id=>page=id,writeUIState(){},loadListings:async()=>{},loadJobs:async()=>{},loadConversations:async()=>{},loadMe:async()=>{},sb:{auth:{getSession:async()=>({data:{session:{access_token:'unit',user:{id:buyer}}}})}},fetch:async(url,options)=>{requests.push(JSON.parse(options.body));return reply({sessionId:'cs_test_current',url:'https://checkout.stripe.com/c/pay/cs_test_current'})},reconcilePendingPurchase:async()=>({id:'trade'})});
 vm.runInContext(source+'\n'+navigation,c);
 return {c,storage,redirects,requests,elements,button,start:()=>c.startStripeCheckout(listing,button)};
}
test('already-completed Checkout recovery restores the purchase button instead of keeping its spinner',async()=>{
 const s=fixture();s.c.fetch=async()=>reply({sessionId:'cs_test_current',awaitingReconciliation:true});
 await s.start();assert.equal(s.button.disabled,false);assert.equal(s.button.textContent,'購入する');assert.deepEqual(s.redirects,[]);
});
test('an unresolved completed Checkout never replaces recovery advice with an invitation to pay again',async()=>{
 const s=fixture();s.c.fetch=async()=>reply({sessionId:'cs_test_current',awaitingReconciliation:true});s.c.reconcilePendingPurchase=async()=>null;
 await s.start();assert.match(s.elements.get('checkoutErrorTitle').textContent,/購入状況/);assert.match(s.elements.get('checkoutErrorMessage').textContent,/再購入せず/);assert.match(s.storage.get('vf_pending_purchase_'+buyer),/cs_test_current/);assert.equal(s.storage.get('vf_checkout_attempt_'+buyer+':'+listing),attempt);assert.equal(s.button.disabled,false);
});
test('repeated taps share one pending checkout request and exact attempt identity',async()=>{
 const s=fixture(),d=deferred();s.c.fetch=async(_,options)=>{s.requests.push(JSON.parse(options.body));return d.promise};
 const first=s.start();await tick();await s.start();assert.equal(s.requests.length,1);assert.equal(s.requests[0].attemptId,attempt);d.resolve(reply({sessionId:'cs_test_current',awaitingReconciliation:true}));await first;assert.equal(s.button.disabled,false);
});
test('navigation while authentication is pending does not create or open an abandoned Checkout',async()=>{
 const s=fixture(),d=deferred();s.c.sb.auth.getSession=()=>d.promise;const run=s.start();await s.c.go('home');d.resolve({data:{session:{access_token:'unit',user:{id:buyer}}}});await run;
 assert.equal(s.requests.length,0);assert.deepEqual(s.redirects,[]);assert.equal(s.button.disabled,false);assert.equal(s.elements.has('checkoutErrorOverlay'),false);
});
for(const returnToOrigin of [false,true])test(`a late Checkout response cannot override newer navigation${returnToOrigin?' even after returning to the original page':''}`,async()=>{
 const s=fixture(),d=deferred();s.c.fetch=()=>d.promise;const run=s.start();await tick();await s.c.go('home');if(returnToOrigin)await s.c.go('voices');d.resolve(reply({sessionId:'cs_test_current',url:'https://checkout.stripe.com/c/pay/cs_test_current'}));await run;
 assert.deepEqual(s.redirects,[]);assert.match(s.storage.get('vf_pending_purchase_'+buyer),/cs_test_current/);assert.equal(s.storage.get('vf_checkout_attempt_'+buyer+':'+listing),attempt);assert.equal(s.button.disabled,false);
});
test('a checkout response for a departed account neither redirects nor opens its error in the new account',async()=>{
 const s=fixture(),d=deferred();s.c.fetch=()=>d.promise;const run=s.start();await tick();s.c.currentUser={id:'other'};d.resolve(reply({sessionId:'cs_test_current',url:'https://checkout.stripe.com/c/pay/cs_test_current'}));await run;
 assert.deepEqual(s.redirects,[]);assert.equal(s.storage.has('vf_pending_purchase_'+buyer),false);assert.equal(s.elements.has('checkoutErrorOverlay'),false);assert.equal(s.button.disabled,false);
});
test('failed checkout preparation keeps its attempt identity for a safe retry',async()=>{
 const s=fixture();s.c.fetch=async(_,options)=>{s.requests.push(JSON.parse(options.body));throw Error('offline')};await s.start();await s.start();assert.equal(s.requests.length,2);assert.equal(s.requests[0].attemptId,s.requests[1].attemptId);assert.equal(s.button.disabled,false);
});
test('successful checkout redirects only to Stripe and leaves the back-navigation button usable',async()=>{
 const s=fixture();await s.start();assert.deepEqual(s.redirects,['https://checkout.stripe.com/c/pay/cs_test_current']);assert.equal(s.button.disabled,false);assert.equal(s.button.textContent,'購入する');assert.match(s.storage.get('vf_pending_purchase_'+buyer),/cs_test_current/);
 const invalid=fixture();invalid.c.fetch=async()=>reply({sessionId:'cs_test_current',url:'https://example.com/c/pay/cs_test_current'});await invalid.start();assert.deepEqual(invalid.redirects,[]);assert.equal(invalid.button.disabled,false);
});

for(const outcome of ['complete','failed'])test(`navigation during a ${outcome} checkout response retains recovery without stale errors`,async()=>{
 const s=fixture(),d=deferred(),recovered=[];s.c.fetch=()=>d.promise;s.c.reconcilePendingPurchase=async revision=>{recovered.push(revision);return {id:'trade'}};
 const run=s.start();await tick();await s.c.go('home');
 if(outcome==='complete')d.resolve(reply({sessionId:'cs_test_current',awaitingReconciliation:true}));else d.reject(Error('offline'));
 await run;assert.equal(recovered.length,outcome==='complete'?1:0);if(recovered.length)assert.equal(recovered[0],0);assert.deepEqual(s.redirects,[]);assert.equal(s.elements.has('checkoutErrorOverlay'),false);assert.equal(s.button.disabled,false);
});
test('job checkout uses the exact application identity through completion recovery',async()=>{
 const s=fixture(),application='00000000-0000-4000-8000-000000000004';s.c.fetch=async(_,options)=>{s.requests.push(JSON.parse(options.body));return reply({sessionId:'cs_test_job',awaitingReconciliation:true})};
 await s.c.startStripeCheckout(null,s.button,application);assert.equal(s.requests[0].applicationId,application);assert.equal(s.requests[0].listingId,undefined);const pending=JSON.parse(s.storage.get('vf_pending_purchase_'+buyer));assert.equal(pending.applicationId,application);assert.equal(pending.listingId,undefined);assert.equal(pending.checkoutSessionId,'cs_test_job');assert.equal(s.button.disabled,false);
});
