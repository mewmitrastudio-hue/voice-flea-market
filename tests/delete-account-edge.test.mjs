import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
function fixture({finishReject=false,storageReject=false,files=[{bucket:'voice-samples',name:'user/sample.m4a'},{bucket:'profile-avatars',name:'user/avatar.png'},{bucket:'voice-deliveries',name:'private/paid.m4a'}]}={}){
 let handler;const calls=[];let storageAttempts=0;
 const admin={auth:{getUser:async()=>({data:{user:{id:'user'}}}),admin:{signOut:async()=>{calls.push('signout');return{};},deleteUser:async(id,soft)=>{assert.equal(id,'user');assert.equal(soft,true);calls.push('authdelete');return{};}}},from:()=>({select:()=>({eq:()=>({single:async()=>({data:{stripe_account_id:null}})})})}),rpc:async(name,args)=>{assert.equal(args.target,'user');calls.push(name);return name==='prepare_account_deletion'?{data:{allowed:true,files}}:{error:finishReject?{code:'APPLE_SETTLEMENT_PENDING'}:null};},storage:{from:bucket=>({remove:async paths=>{calls.push({bucket,paths:[...paths]});return {error:(storageReject===true||(storageReject==='once'&&storageAttempts++===0))?{code:'storage_unavailable'}:null};}})}};
 const context={Request,Response,URL,AbortSignal,console:{error(){}},createClient:()=>admin,fetch:async()=>Response.json({data:[],has_more:false}),Deno:{serve:f=>handler=f,env:{get:k=>({SUPABASE_URL:'https://local.invalid',SUPABASE_SERVICE_ROLE_KEY:'unit',STRIPE_SECRET_KEY:'sk_test_unit'})[k]}}};
 const code=fs.readFileSync(new URL('../supabase/functions/delete-account/index.ts',import.meta.url),'utf8').replace(/^import .*\n/gm,'');vm.runInNewContext(stripTypeScriptTypes(code),context);
 return {calls,send:()=>handler(new Request('https://local.invalid',{method:'POST',headers:{Authorization:'Bearer unit'},body:JSON.stringify({confirmation:'DELETE_MY_ACCOUNT',user_id:'other'})}))};
}
test('late financial hold at finish preserves all Storage and Auth state',async()=>{
 const f=fixture({finishReject:true});const response=await f.send();assert.equal(response.status,500);assert.equal((await response.json()).pending,true);assert.deepEqual(f.calls,['prepare_account_deletion','finish_account_deletion']);
});
test('invalid file plan is rejected before finish or any destructive operation',async()=>{
 const f=fixture({files:[{bucket:'voice-samples',name:123}]});assert.equal((await f.send()).status,500);assert.deepEqual(f.calls,['prepare_account_deletion']);
});
test('finish succeeds before public files removal, and private deliveries are untouched',async()=>{
 const f=fixture();assert.equal((await f.send()).status,200);assert.deepEqual(f.calls,['prepare_account_deletion','finish_account_deletion',{bucket:'voice-samples',paths:['user/sample.m4a']},{bucket:'profile-avatars',paths:['user/avatar.png']},'signout','authdelete']);
});
test('Storage failure after finish retains pending cleanup without signing out or deleting Auth',async()=>{
 const f=fixture({storageReject:true});const response=await f.send();assert.equal(response.status,500);assert.equal((await response.json()).pending,true);assert.deepEqual(f.calls,['prepare_account_deletion','finish_account_deletion',{bucket:'voice-samples',paths:['user/sample.m4a']}]);
});

test('Storage transient failure permits a retry, repeats finish before cleanup, and keeps private files',async()=>{
 const f=fixture({storageReject:'once'});assert.equal((await f.send()).status,500);assert.equal((await f.send()).status,200);
 assert.equal(f.calls.filter(x=>x==='finish_account_deletion').length,2);
 assert.equal(f.calls.filter(x=>x==='authdelete').length,1);
 assert.equal(f.calls.filter(x=>typeof x==='object'&&x.bucket==='voice-deliveries').length,0);
});
