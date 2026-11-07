import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=source.indexOf('  const profileOwner=currentUser.id;',source.indexOf('async function loadMe(){'));
const end=source.indexOf('  const {data:receivedReviews}',start);
assert.ok(start>0&&end>start);
const segment=source.slice(start,end);
async function run(response,change){
 const calls=[],warnings=[];
 const ctx={currentUser:{id:'owner'},sb:{rpc:async(...args)=>{calls.push(args);if(change)ctx.currentUser=change();return response;}},setStripeConnectUI:(...args)=>warnings.push(args)};
 vm.createContext(ctx);
 const result=await vm.runInContext(`(async()=>{${segment}\nreturn {continued:true,profile:p};})()`,ctx);
 return {calls,warnings,result};
}
test('own profile uses zero-argument authenticated RPC, not unrestricted table SELECT',async()=>{
 const r=await run({data:{id:'owner',stripe_account_id:'acct_synthetic'},error:null});
 assert.deepEqual(r.calls,[['get_my_recording_profile']]);
 assert.equal(r.result.profile.stripe_account_id,'acct_synthetic');assert.equal(r.warnings.length,0);
 assert.doesNotMatch(segment,/\.from\(['"]profiles/);
});
test('RPC error blocks profile rendering and clears recipient display',async()=>{
 const r=await run({data:null,error:{message:'denied'}});assert.equal(r.result,undefined);assert.equal(r.warnings.length,1);assert.equal(r.warnings[0][0],'');assert.equal(r.warnings[0][3],true);
});
test('RPC response for another owner is rejected',async()=>{
 const r=await run({data:{id:'other',stripe_account_id:'acct_other'},error:null});assert.equal(r.result,undefined);assert.equal(r.warnings.length,1);
});
test('logout during profile request cannot render the old profile',async()=>{
 const r=await run({data:{id:'owner'},error:null},()=>null);assert.equal(r.result,undefined);assert.equal(r.warnings.length,0);
});
test('account switch during profile request cannot render the old profile',async()=>{
 const r=await run({data:{id:'owner'},error:null},()=>({id:'other'}));assert.equal(r.result,undefined);assert.equal(r.warnings.length,0);
});
test('empty own profile does not invent a recipient account',async()=>{
 const r=await run({data:null,error:null});assert.equal(r.result.continued,true);assert.equal(r.result.profile.stripe_account_id,undefined);
});
