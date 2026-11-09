import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';import {createHmac,webcrypto} from 'node:crypto';
import {reconcileStripeDispute,stripeDisputeEvents} from '../supabase/functions/_shared/stripe-disputes.mjs';
import {fixture} from './fixtures/stripe-dispute.mjs';
function endpoint({dbFail=false,missingConfig=false}={}){
 const f=fixture(),calls=[];let handler;
 const env={STRIPE_WEBHOOK_SECRET:'whsec_local',STRIPE_SECRET_KEY:'sk_live_local',SUPABASE_URL:'https://local.invalid',SUPABASE_SERVICE_ROLE_KEY:'local',STRIPE_DISPUTE_PLATFORM_ACCOUNT_ID:missingConfig?'':'acct_platform'};
 const context={Response,Request,TextEncoder,Uint8Array,Date,JSON,crypto:webcrypto,console:{error(){}},reconcileStripeDispute,
 Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn},createClient:()=>({rpc:async(n,a)=>{calls.push({n,a});return {error:dbFail};}}),
 fetch:async url=>{const path=url.replace('https://api.stripe.com/v1/','');calls.push({get:path});return Response.json(f.objects[path]);}};
 const source=fs.readFileSync(new URL('../supabase/functions/stripe-webhook/index.ts',import.meta.url),'utf8');
 vm.runInNewContext(stripTypeScriptTypes(source.replace(/^import .*\n/gm,'')),context);
 async function send({valid=true,type=stripeDisputeEvents[0],account,mode=true}={}){
 const raw=JSON.stringify({...f.event,type,account,livemode:mode}),t=Math.floor(Date.now()/1000);
 const sig=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
 return handler(new Request('https://local.invalid',{method:'POST',body:raw,headers:{'stripe-signature':`t=${t},v1=${valid?sig:'0'.repeat(64)}`}}));}
 return {send,calls};
}
test('actual signed Edge handler persists all five dispute events before 200',async()=>{
 for(const type of stripeDisputeEvents){const f=endpoint();assert.equal((await f.send({type})).status,200);assert.equal(f.calls.at(-1).n,'record_stripe_dispute_observation');assert.equal(f.calls.length,5);}
});
test('bad signatures/modes do not read; missing config, foreign scope and failed persistence never silently acknowledge',async()=>{
 for(const input of [{valid:false},{mode:false}]){const f=endpoint();assert.equal((await f.send(input)).status,400);assert.equal(f.calls.length,0);}
 assert.equal((await endpoint().send({account:'acct_other'})).status,503);
 assert.equal((await endpoint({missingConfig:true}).send()).status,503);
 assert.equal((await endpoint({dbFail:true}).send()).status,503);
 assert.equal((await endpoint().send({type:'charge.dispute.future'})).status,503);
});
