import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const user='00000000-0000-4000-8000-000000000001';
const listing='00000000-0000-4000-8000-000000000002';
const attempt='00000000-0000-4000-8000-000000000003';
function fixture({enabled=false,product='com.ayuhide.koenofurima.voice.jpy1000',applyFailure=false}={}){
 const calls=[];let handler;
 const admin={auth:{getUser:async token=>token==='valid'?{data:{user:{id:user}}}:{data:{user:null},error:{}}},rpc:async(name,args)=>{calls.push({name,args});return {data:{orderId:attempt,productId:product,amountJpy:1000,environment:'Sandbox',state:'prepared'}};}};
 const c={Response,Request,Uint8Array,TextDecoder,JSON,console:{error(){}},Deno:{env:{get:name=>({SUPABASE_URL:'https://test.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-only',VOICE_IAP_ENABLED:enabled?'true':'false',VOICE_IAP_ENVIRONMENT:'Sandbox'})[name]},serve:fn=>handler=fn},
  createClient:()=>admin,appleConfig(){},verifiedTransaction:async()=>({productId:product,price:1000000,currency:'JPY'}),
  applyTransaction:async(db,tx,actor)=>{calls.push({actor,tx});if(applyFailure)throw Error('database unavailable');return {paymentId:'payment',conversationId:'trade'};}
 };
 const src=fs.readFileSync(new URL('../supabase/functions/voice-iap/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 vm.createContext(c);vm.runInContext(stripTypeScriptTypes(src),c);
 const send=(body,token='valid')=>handler(new Request('https://edge.invalid',{method:'POST',headers:token?{Authorization:`Bearer ${token}`}:{},body:typeof body==='string'?body:JSON.stringify(body)}));
 return {calls,send};
}
test('voice Edge authorizes the current buyer and reconciles paid receipts even with new sales off',async()=>{
 const f=fixture();assert.equal((await f.send({action:'verify'},null)).status,401);assert.equal((await f.send({action:'verify'},'invalid')).status,401);
 assert.equal((await f.send({action:'prepare',listingId:listing,attemptId:attempt})).status,409);assert.equal(f.calls.length,0);
 const r=await f.send({action:'verify',signedTransaction:'signed',actor:'attacker'});assert.equal(r.status,200);assert.equal((await r.json()).success,true);assert.equal(f.calls[0].actor,user);
});
test('voice Edge bounds the body and ignores client supplied owner, environment, price and SKU',async()=>{
 const f=fixture({enabled:true});assert.equal((await f.send('x'.repeat(35001))).status,413);assert.equal(f.calls.length,0);
 const r=await f.send({action:'prepare',listingId:listing,attemptId:attempt,owner_id:'attacker',tx_environment:'Production',price:1,sku:'cheap'});
 assert.equal(r.status,200);assert.equal(f.calls[0].name,'prepare_voice_iap_order');
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args)),{owner_id:user,listing,attempt,tx_environment:'Sandbox'});
});
test('voice Edge rejects boost receipts and persistence failures never report a granted purchase',async()=>{
 const wrong=fixture({product:'com.ayuhide.koenofurima.boost.silver'});
 assert.equal((await wrong.send({action:'verify',signedTransaction:'signed'})).status,400);assert.equal(wrong.calls.length,0);
 const failed=fixture({applyFailure:true});const r=await failed.send({action:'verify',signedTransaction:'signed'});assert.equal(r.status,503);assert.equal((await r.json()).success,undefined);
});
