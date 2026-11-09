import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {purchaseEnvironments,preparationEnvironment} from '../supabase/functions/_shared/iap-environment.mjs';
function fixture(mode='Dual'){
 let handler;const calls=[];
 const admin={auth:{getUser:async()=>({data:{user:{id:'owner'}}})},rpc:async(name,args)=>{calls.push({name,args});return {data:{orderId:'order',environment:args.tx_environment}};}};
 const c={Request,Response,console,purchaseEnvironments,preparationEnvironment,createClient:()=>admin,enabled:()=>true,appleConfig(){},verifiedTransaction:async()=>({productId:'com.ayuhide.koenofurima.boost.silver',environment:'Sandbox'}),applyTransaction:async(db,tx,actor)=>{calls.push({tx,actor});return {environment:tx.environment};},Deno:{serve:fn=>handler=fn,env:{get:k=>({SUPABASE_URL:'https://unit.invalid',SUPABASE_SERVICE_ROLE_KEY:'unit',BOOST_IAP_ENVIRONMENT:mode})[k]}}};
 const source=fs.readFileSync(new URL('../supabase/functions/boost-iap/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 vm.createContext(c);vm.runInContext(stripTypeScriptTypes(source),c);
 return {calls,send:body=>handler(new Request('https://unit.invalid',{method:'POST',headers:{Authorization:'Bearer unit'},body:JSON.stringify(body)}))};
}
test('boost Dual status advertises allowed environments; prepare binds the native hint and server user',async()=>{
 const f=fixture();const status=await (await f.send({action:'status'})).json();assert.deepEqual(status.environments,['Sandbox','Production']);assert.equal(status.environment,null);
 for(const env of ['Sandbox','Production']){
  const response=await f.send({action:'prepare',plan:'silver',listingId:'listing',storeKitEnvironment:env,owner_id:'attacker'});assert.equal(response.status,200);
  const call=f.calls.at(-1);assert.equal(call.name,'prepare_boost_order_in_environment');assert.equal(call.args.owner_id,'owner');assert.equal(call.args.tx_environment,env);
 }
 const count=f.calls.length;assert.equal((await f.send({action:'prepare',plan:'silver',listingId:'listing'})).status,409);assert.equal(f.calls.length,count);
});
test('boost verify ignores environment and actor supplied in body; only verified receipt and authenticated user pass through',async()=>{
 const f=fixture();const r=await f.send({action:'verify',signedTransaction:'signed',storeKitEnvironment:'Production',actor:'attacker'});assert.equal(r.status,200);assert.equal(f.calls[0].actor,'owner');assert.equal(f.calls[0].tx.environment,'Sandbox');
});
