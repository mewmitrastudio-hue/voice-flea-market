import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import test from 'node:test';
async function suite(file){
 const s=fs.readFileSync(file,'utf8');
 const helper=s.slice(s.indexOf('async function loadListingPurchaseRows('),s.indexOf('async function loadListings('));
 const ready=s.slice(s.indexOf('function listingPurchaseReadiness('),s.indexOf('async function loadListingPurchaseRows('));
 let dataset=[],calls=[],mode='',current=true;
 const sb={from(table){assert.equal(table,'payments');let q={};const chain={select(v,opt){assert.equal(opt.count,'exact');return chain},eq(k,v){assert.equal(k,'buyer_id');q.owner=v;return chain},in(k,v){assert.equal(k,'listing_id');q.ids=v;return chain},order(k,v){assert.equal(k,'id');assert.equal(v.ascending,true);return chain},async range(a,b){calls.push({...q,a,b});let rows=dataset.filter(r=>r.owner===q.owner&&q.ids.includes(r.listing_id)).sort((a,b)=>a.id.localeCompare(b.id));let page=rows.slice(a,b+1),count=rows.length;if(mode==='error'&&a>0)return {error:{message:'offline'},data:null,count:null};if(mode==='throw')throw Error('offline');if(mode==='count'&&a>0)count++;if(mode==='duplicate'&&a>0)page[0]=rows[0];if(mode==='stale')current=false;return {data:page,error:null,count};}};return chain;}};
 const ctx=vm.createContext({sb});vm.runInContext(helper+ready,ctx);
 const run=()=>ctx.loadListingPurchaseRows('buyer',['target'],()=>current);
 const rows=n=>Array.from({length:n},(_,i)=>({id:String(i).padStart(6,'0'),owner:'buyer',listing_id:'target',status:'failed',conversations:[]}));
 dataset=rows(1001);let result=await run();assert.equal(result.length,1001);assert.equal(calls.length,3);assert.equal(ctx.listingPurchaseReadiness(result).blocked,false);
 dataset=rows(1001).map(r=>({...r,listing_id:'other'}));calls=[];result=await run();assert.equal(result.length,0);assert.equal(calls.length,1);assert.equal(ctx.listingPurchaseReadiness(result).blocked,false);
 dataset=[...rows(1001),{id:'zzz',owner:'buyer',listing_id:'target',status:'pending'}];result=await run();assert.equal(ctx.listingPurchaseReadiness(result).blocked,true);
 for(const m of ['error','throw','count','duplicate','stale']){mode=m;current=true;dataset=rows(1001);assert.equal(await run(),null,m);assert.equal(ctx.listingPurchaseReadiness(null).blocked,true);}
 mode='';current=true;dataset=rows(10001);assert.equal(await run(),null);
 dataset=[{id:'a',owner:'buyer',listing_id:'target',status:'paid',conversations:[{payment_id:'a',is_inquiry:false,delivery_status:'accepted'}]}];assert.equal(ctx.listingPurchaseReadiness(await run()).blocked,false);
 dataset[0].conversations[0].delivery_status='submitted';assert.equal(ctx.listingPurchaseReadiness(await run()).blocked,true);
 dataset[0].status='authorized';assert.equal(ctx.listingPurchaseReadiness(await run()).blocked,true);
 console.log('PASS',file,': 1001 complete; unrelated excluded; pending/paid/authorized guards; error/throw/count/duplicate/stale/cap fail closed');
}
test('displayed listing histories paginate completely and fail closed on inconsistent reads',async()=>{await suite(new URL('../index.html',import.meta.url));});
