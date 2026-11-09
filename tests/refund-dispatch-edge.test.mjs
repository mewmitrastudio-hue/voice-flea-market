import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
const uuid='00000000-0000-4000-8000-000000000001';
function endpoint(kind,options={}){
 let handler;const calls=[],env={STRIPE_SECRET_KEY:'sk_live_unit',ADMIN_USER_ID:uuid,SUPABASE_URL:'https://unit.invalid',SUPABASE_SERVICE_ROLE_KEY:'unit',STRIPE_REFUND_DISPATCH_ENABLED:options.disabled?'false':'true',STRIPE_DISPUTE_PLATFORM_ACCOUNT_ID:'acct_platform'};
 const c={Response,Request,JSON,URLSearchParams,console:{error(){}},Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn},
 createClient:()=>({auth:{getUser:async()=>({data:{user:options.badUser?{id:'other'}:{id:uuid}},error:null})},rpc:async(n,a)=>{calls.push({n,a});if(n==='refund_auto_claim')return options.badWorker?{error:true}:{data:[{id:uuid,payment_id:uuid,lease_id:uuid}]};return {error:null};}}),
 stripeRefundTransport:key=>({key}),dispatchStripeRefund:async args=>{calls.push({n:'dispatch',args});return {ok:true,operation_id:uuid,status:'pending',dispatch_state:'pending',review_required:false};}};
 const source=fs.readFileSync(new URL('../supabase/functions/'+kind+'/index.ts',import.meta.url),'utf8');vm.runInNewContext(stripTypeScriptTypes(source.replace(/^import .*\n/gm,'')),c);
 return {calls,send:(body,token='unit-token',method='POST')=>handler(new Request('https://unit.invalid',{method,headers:token?{Authorization:'Bearer '+token}:undefined,body:method==='POST'?JSON.stringify(body):undefined}))};
}
test('actual refund-payment retains exact admin authentication and routes valid request through common journal',async()=>{
 const x=endpoint('refund-payment');assert.equal((await x.send({payment_id:uuid})).status,200);const a=x.calls[0].args;assert.equal(a.origin,'manual');assert.equal(a.actor,uuid);assert.equal(a.platformId,'acct_platform');assert.equal(a.live,true);
 for(const options of [{badUser:true},{disabled:true}]){const y=endpoint('refund-payment',options);assert.ok((await y.send({payment_id:uuid})).status>=400);assert.equal(y.calls.length,0);}
 const y=endpoint('refund-payment');assert.equal((await y.send({payment_id:uuid},null)).status,401);assert.equal(y.calls.length,0);
});
test('actual auto-refund preserves worker RPC authentication, leases and common outcome dispatch',async()=>{
 const x=endpoint('auto-refund');assert.equal((await x.send({action:'drain'})).status,200);assert.equal(x.calls[0].n,'refund_auto_claim');assert.equal(x.calls[0].a.provided_token,'unit-token');assert.equal(x.calls[1].args.origin,'auto');assert.equal(x.calls[1].args.lease,uuid);assert.equal(x.calls[2].n,'refund_auto_result');
 const bad=endpoint('auto-refund',{badWorker:true});assert.equal((await bad.send({action:'drain'})).status,403);assert.equal(bad.calls.length,1);
 const off=endpoint('auto-refund',{disabled:true});assert.equal((await off.send({action:'drain'})).status,503);assert.equal(off.calls.length,0);
});
