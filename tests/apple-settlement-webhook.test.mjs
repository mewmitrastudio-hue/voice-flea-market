import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createHmac,webcrypto} from 'node:crypto';
import {reconcileAppleSettlementEvent} from '../supabase/functions/_shared/apple-settlement.mjs';
const id='00000000-0000-4000-8000-000000000001',payment='00000000-0000-4000-8000-000000000002';
function endpoint({dbFail=false}={}){
 let handler;const calls=[];
 const op={id,payment_id:payment,platform_id:'acct_platform',destination:'acct_seller',amount_jpy:541,state:'dispatching'};
 const transfer={id:'tr_apple',object:'transfer',livemode:true,amount:541,currency:'jpy',destination:'acct_seller',source_transaction:null,reversed:true,amount_reversed:541,metadata:{apple_settlement_id:id,payment_id:payment},transfer_group:'apple_settlement_'+id};
 const env={STRIPE_WEBHOOK_SECRET:'whsec_test',STRIPE_SECRET_KEY:'sk_live_unit',SUPABASE_URL:'https://local.invalid',SUPABASE_SERVICE_ROLE_KEY:'unit',APPLE_SETTLEMENT_STRIPE_ACCOUNT_ID:'acct_platform'};
 const context={Response,Request,TextEncoder,Uint8Array,Date,JSON,crypto:webcrypto,console:{error(){}},reconcileAppleSettlementEvent,
  Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn},
  createClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return name==='get_apple_settlement'?{data:op}:dbFail?{error:true}:{data:{}};}}),
  fetch:async(url)=>{calls.push({name:'fetch'});return Response.json(url.endsWith('/account')?{id:'acct_platform'}:transfer);}};
 const source=fs.readFileSync(new URL('../supabase/functions/stripe-webhook/index.ts',import.meta.url),'utf8');
 vm.runInNewContext(stripTypeScriptTypes(source.replace(/^import .*\n/gm,'')),context);
 const send=async(valid=true,eventType='transfer.created')=>{
  // Stale creation event says unreversed; current Stripe retrieve says reversed.
  const raw=JSON.stringify({livemode:true,type:eventType,data:{object:{...transfer,reversed:false,amount_reversed:0}}}),t=Math.floor(Date.now()/1000);
  const sig=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  return handler(new Request('https://local.invalid',{method:'POST',body:raw,headers:{'stripe-signature':`t=${t},v1=${valid?sig:'0'.repeat(64)}`}}));
 };return {calls,send};
}
test('signed transfer webhook retrieves current reversal evidence; duplicate events do not create money',async()=>{
 const e=endpoint();assert.equal((await e.send()).status,200);assert.equal((await e.send(true,'transfer.reversed')).status,200);
 const records=e.calls.filter(x=>x.name==='record_apple_settlement');assert.equal(records.length,2);assert.equal(records[0].args.evidence.amount_reversed,541);
});
test('unsigned events never access the ledger; persistence failures return retryable status',async()=>{
 const e=endpoint();assert.equal((await e.send(false)).status,400);assert.equal(e.calls.length,0);
 assert.equal((await endpoint({dbFail:true}).send()).status,503);
});
