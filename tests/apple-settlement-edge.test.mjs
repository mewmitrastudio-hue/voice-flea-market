import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {dispatchAppleSettlement,reconcileAppleSettlement} from '../supabase/functions/_shared/apple-settlement.mjs';
const id='00000000-0000-4000-8000-000000000001',payment='00000000-0000-4000-8000-000000000002';
function endpoint(options={}){
 let handler;const calls=[];let claimed=false;
 const op={id,payment_id:payment,seller_id:'seller',platform_id:'acct_platform',destination:'acct_seller',amount_jpy:541,currency:'jpy',livemode:true,state:'prepared'};
 const env={SUPABASE_URL:'https://local.invalid',SUPABASE_SERVICE_ROLE_KEY:'unit-only',STRIPE_SECRET_KEY:'sk_live_unit',APPLE_SETTLEMENT_STRIPE_ACCOUNT_ID:'acct_platform',...options.enabled?{APPLE_SETTLEMENT_TRANSFERS_ENABLED:'true',APPLE_SETTLEMENT_FUNDING_APPROVED:'true'}:{}};
 function createClient(url,key,opts){const operator=!!opts.global;return {
  auth:{getUser:async()=>({data:{user:options.authFail?null:{id:'operator'}},error:null})},
  from(){return {select(){return this},eq(){return this},single:async()=>({data:{id:payment,buyer_id:'buyer',apple_transaction_id:'123',apple_environment:'Production',amount_jpy:1000}})};},
  rpc:async(name,args)=>{
   calls.push({name,args,operator});
   if(name==='prepare_apple_settlement'){assert.equal(operator,true);assert.equal(opts.global.headers.Authorization,'Bearer unit');return options.nonAdmin?{error:true}:{data:{...op}};}
   assert.equal(operator,false);
   if(name==='claim_apple_settlement'){claimed=true;return {data:{...op,state:'dispatching'}};}
   if(name==='record_apple_settlement'){assert.equal(claimed,true);return {data:{}};}
   throw Error('unexpected rpc');
  }
 };}
 function Stripe(){return {accounts:{retrieve:async()=>({id:'acct_platform'})},balance:{retrieve:async()=>({object:'balance',livemode:true,available:[{currency:'jpy',amount:1000}]})},transfers:{create:async(params)=>{calls.push({name:'transfer',params});return {id:'tr_test'};},retrieve:async()=>({object:'transfer',id:'tr_test',livemode:true,amount:541,currency:'jpy',destination:'acct_seller',source_transaction:null,amount_reversed:0,reversed:false,metadata:{apple_settlement_id:id,payment_id:payment},transfer_group:'apple_settlement_'+id})}};}
 const c={Response,Request,Error,SyntaxError,Uint8Array,TextDecoder,createClient,Stripe,dispatchAppleSettlement,reconcileAppleSettlement,
  requireRecipient:async()=> 'acct_seller',appleConfig:()=>({verifier:{verifiedTransactionById:async()=>({productId:'com.ayuhide.koenofurima.voice.jpy1000',price:1000000,currency:'JPY'})}}),applyTransaction:async()=>({paymentId:payment,revoked:!!options.revoked}),console:{warn(){}},Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn}};
 const source=fs.readFileSync(new URL('../supabase/functions/apple-settlement/index.ts',import.meta.url),'utf8').replace(/^import .*\n/gm,'');vm.runInNewContext(stripTypeScriptTypes(source),c);
 return {calls,handle:req=>handler(req),send:(action,auth=true)=>handler(new Request('https://local.invalid',{method:'POST',headers:auth?{Authorization:'Bearer unit'}:{},body:JSON.stringify({action,paymentId:payment,amount:1,destination:'acct_attacker'})}))};
}
test('settlement endpoint requires authenticated moderator and defaults to no live dispatch',async()=>{
 for(const opts of [{},{authFail:true},{nonAdmin:true}]){
  const e=endpoint(opts);assert.ok((await e.send('dispatch')).status>=400);assert.equal(e.calls.some(c=>c.name==='transfer'||c.name==='claim_apple_settlement'),false);
 }
 const e=endpoint();assert.equal((await e.send('prepare',false)).status,401);assert.equal(e.calls.length,0);
 assert.equal((await e.send('prepare')).status,200);assert.equal(e.calls.length,1);
});
test('edge dispatch ignores client money, verifies Apple first and records only fresh transfer evidence',async()=>{
 const e=endpoint({enabled:true});const response=await e.send('dispatch');assert.equal(response.status,200);assert.equal((await response.json()).bankPayout,'unverified');
 const transfer=e.calls.find(c=>c.name==='transfer');assert.equal(transfer.params.amount,541);assert.equal(transfer.params.destination,'acct_seller');
 assert.ok(e.calls.findIndex(c=>c.name==='claim_apple_settlement')<e.calls.indexOf(transfer));
 const revoked=endpoint({enabled:true,revoked:true});assert.equal((await revoked.send('dispatch')).status,409);assert.equal(revoked.calls.some(c=>c.name==='claim_apple_settlement'||c.name==='transfer'),false);
});
test('oversized streamed requests stop before authentication or finance access',async()=>{
 const e=endpoint();let canceled=false;
 const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(2049));},cancel(){canceled=true;}},{highWaterMark:0});
 const response=await e.handle(new Request('https://local.invalid',{method:'POST',headers:{Authorization:'Bearer unit'},body,duplex:'half'}));
 assert.equal(response.status,413);assert.equal(canceled,true);assert.equal(e.calls.length,0);
});
