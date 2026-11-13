import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import test from 'node:test';const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function setup(file,stage){
 const s=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');let a=s.indexOf('async function voicePreparationWait('),b=s.indexOf('async function voiceIapApi(',a);const wait=s.slice(a,b);
 a=s.indexOf('async function confirmVoicePurchase(){');b=s.indexOf('</script>',a);const funcs=s.slice(a,b);
 let notices=[],removed=0,purchased=0,finished=0,verified=0;
 const never=()=>new Promise(()=>{});const plugin={purchase:()=>{purchased++;return stage==='purchase'?never():Promise.resolve({status:'purchased',signedTransaction:'jws',transactionId:'123'})},finish:()=>{finished++;return stage==='finish'?never():Promise.resolve({finished:true})},pendingTransactions:async()=>({transactions:[{signedTransaction:'jws',transactionId:'123'}]})};
 const ctx={setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,5)),clearTimeout,currentUser:{id:'buyer'},voicePurchaseBusy:false,voicePurchasePhase:null,voicePurchaseRequest:1,voicePurchaseQuote:{owner:'buyer',request:1,key:'key',plugin},document:{getElementById:()=>({hidden:false})},voicePurchaseNotice:m=>notices.push(m),safeLocalStorage:{removeItem:()=>removed++},voiceIapApi:()=>{verified++;return stage==='verify'?never():Promise.resolve({success:true,paymentId:'pay'})},nativeBoost:async()=>({plugin}),showVoicePurchase(){},isNativeBoost:()=>true,closeVoicePurchase(){},go(){},openConversation:async()=>{},alert(){}};
 vm.createContext(ctx);vm.runInContext(wait+funcs,ctx);return {ctx,stats:()=>({notices,removed,purchased,finished,verified})};
}
test('native recovery timeouts retain purchases and unlock reconciliation only',async()=>{
 for(const fn of ['confirmVoicePurchase','reconcileVoicePurchases'])for(const stage of ['verify','finish']){
  let t=setup('candidate.html',stage);await t.ctx[fn]();assert.equal(t.ctx.voicePurchaseBusy,false);assert.equal(t.ctx.voicePurchasePhase,null);assert.equal(t.stats().removed,0);assert.match(t.stats().notices.at(-1),/時間内/);assert.equal(t.stats().purchased,fn==='confirmVoicePurchase'?1:0);
 }
 let t=setup('candidate.html','purchase');t.ctx.confirmVoicePurchase();await sleep(25);assert.equal(t.ctx.voicePurchaseBusy,true);assert.equal(t.stats().verified,0);assert.equal(t.stats().finished,0);assert.equal(t.stats().removed,0);
 for(const fn of ['confirmVoicePurchase','reconcileVoicePurchases']){t=setup('candidate.html','success');await t.ctx[fn]();assert.equal(t.ctx.voicePurchaseBusy,false);assert.equal(t.stats().verified,1);assert.equal(t.stats().finished,1);assert.equal(t.stats().removed,fn==='confirmVoicePurchase'?1:0);}
 console.log('PASS candidate: verify/finish waits bounded for confirm/reconcile; retry UI unlocked; attempt not erased; actual purchase wait untouched; successful path unchanged');
});