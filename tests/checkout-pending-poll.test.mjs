import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import test from 'node:test';
function setup(file,sequence,mode=''){
 const s=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');const code=s.slice(s.indexOf('async function reconcilePendingPurchase('),s.indexOf('async function getFavoriteListingIds('));
 const pending={checkoutSessionId:'cs_test_exact',listingId:'target'};let reads=0,opens=0,removed=0,waits=0;
 const ctx={currentUser:{id:'buyer'},pageNavigationRequest:1,findCheckoutReturn:()=>({key:'key',pending}),safeLocalStorage:{getItem:()=>JSON.stringify(pending),removeItem:()=>removed++},listingDisplayTitle:async()=>'',setTimeout:f=>{waits++;f()},Date};
 ctx.sb={from(table){assert.equal(table,'payments');let filters={};const chain={select(){return chain},eq(k,v){filters[k]=v;return chain},async limit(n){assert.equal(n,2);assert.equal(filters.stripe_checkout_session_id,pending.checkoutSessionId);assert.equal(filters.buyer_id,'buyer');assert.equal(filters.listing_id,'target');const state=sequence[Math.min(reads++,sequence.length-1)];if(mode==='owner'&&reads===2)ctx.currentUser={id:'other'};if(state==='error')return {error:{},data:null};if(state==='none')return {data:[]};const row={id:'pay',listing_id:'target',buyer_id:'buyer',seller_id:'seller',status:state,refunded_amount_jpy:mode==='refund'?1:0,stripe_checkout_session_id:pending.checkoutSessionId,stripe_reconciled_at:'2026-01-01',stripe_livemode:false,stripe_capture_method:'manual',authorization_expires_at:mode==='expired'?'2000-01-01':'2099-01-01'};if(mode==='wrong')row.stripe_checkout_session_id='cs_other';return {data:[row]};}};return chain;},async rpc(name,args){assert.equal(name,'open_paid_purchase_conversation');opens++;return {data:{id:'chat',payment_id:'pay'}}}};
 vm.createContext(ctx);vm.runInContext(code,ctx);
 return {run:()=>ctx.reconcilePendingPurchase(1,undefined,()=>false),stats:()=>({reads,opens,removed,waits})};
}
test('pending checkout waits for the same session without granting unpaid orders',async()=>{
 let t;
 for(const end of ['paid','authorized']){t=setup('candidate.html',['pending',end]);assert.equal((await t.run()).id,'chat');assert.equal(t.stats().reads,2);assert.equal(t.stats().opens,1);assert.equal(t.stats().removed,1);}
 t=setup('candidate.html',['pending']);assert.equal(await t.run(),null);assert.equal(t.stats().reads,8);assert.equal(t.stats().opens,0);assert.equal(t.stats().removed,0);
 for(const [seq,mode] of [[['failed'],''],[['canceled'],''],[['refunded'],''],[['mystery'],''],[['pending','paid'],'owner'],[['pending','error'],''],[['pending'],'wrong'],[['pending'],'refund'],[['authorized'],'expired']]){t=setup('candidate.html',seq,mode);assert.equal(await t.run(),null);assert.equal(t.stats().opens,0);assert.equal(t.stats().removed,0);}
 t=setup('candidate.html',['none','paid']);assert.equal((await t.run()).id,'chat');
 console.log('PASS candidate: pending→paid/authorized, bounded pending, absent→paid; terminal/refund/mismatch/expired/error/account switch fail closed; no pending grant or record removal');
});