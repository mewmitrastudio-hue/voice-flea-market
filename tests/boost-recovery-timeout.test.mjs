import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import test from 'node:test';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function setup(stage){
 const calls=[],notices=[];let late;
 const stalled=()=>new Promise(resolve=>{late=resolve;});
 const plugin={pendingTransactions:async()=>({transactions:[{signedTransaction:'jws',transactionId:'tx'}]}),purchase:async()=>{calls.push('purchase');return stage==='purchase'?stalled():{status:'purchased',signedTransaction:'jws',transactionId:'tx'};},finish:async()=>{calls.push('finish');return stage==='finish'?stalled():{finished:true};}};
 const ctx={setTimeout:(f,m)=>setTimeout(f,Math.min(m,5)),clearTimeout,currentUser:{id:'owner'},boostBusy:false,boostReady:true,boostHistoryReady:true,boostRequest:1,boostEnvironment:'Sandbox',boostStoreProducts:[],boostProductReadiness:()=>({ready:true}),boostActiveListing:()=>false,boostListingChanged(){},boostNotice:s=>notices.push(s),document:{getElementById:()=>({value:'listing'})},nativeBoost:async()=>({plugin}),isNativeBoost:()=>true,formatJpDateTime:()=>'',openBoostPreview:async()=>{calls.push('refresh');},boostApi:async body=>{calls.push(body.action);if(body.action==='prepare')return {orderId:'order',productId:'silver'};return stage==='verify'?stalled():{success:true};}};
 vm.createContext(ctx);
 vm.runInContext(html.slice(html.indexOf('async function boostRead('),html.indexOf('async function openBoostPreview('))+html.slice(html.indexOf('async function purchaseBoost('),html.indexOf('function closeBoostPreview()')),ctx);
 return {ctx,calls,notices,plugin,late:()=>late?.({success:true})};
}
for(const fn of ['purchaseBoost','reconcileBoostPurchases'])for(const stage of ['verify','finish'])test(fn+' releases recovery lock on stalled '+stage+' without granting late success',async()=>{
 const s=setup(stage);if(fn==='purchaseBoost')s.plugin.pendingTransactions=async()=>({transactions:[]});
 await s.ctx[fn]('silver');assert.equal(s.ctx.boostBusy,false);assert.equal(s.ctx.boostReady,false);assert.match(s.notices.at(-1),/時間内/);assert.ok(!s.calls.includes('refresh'));
 if(stage==='verify')assert.ok(!s.calls.includes('finish'));
 const before=[...s.calls];s.late();await new Promise(r=>setTimeout(r,10));assert.deepEqual(s.calls,before);assert.match(s.notices.at(-1),/再購入せず/);
});
test('actual Apple purchase remains locked, not timed out',async()=>{
 const s=setup('purchase');s.plugin.pendingTransactions=async()=>({transactions:[]});void s.ctx.purchaseBoost('silver');await new Promise(r=>setTimeout(r,30));assert.equal(s.ctx.boostBusy,true);assert.deepEqual(s.calls,['prepare','purchase']);
});
test('successful boost recovery verifies before finish',async()=>{
 const s=setup('success');await s.ctx.reconcileBoostPurchases();assert.deepEqual(s.calls,['verify','finish','refresh']);assert.equal(s.ctx.boostBusy,false);
});
