import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppleAdapter} from '../supabase/functions/_shared/apple-adapter.mjs';

const recording='https://neotkrfsquysuatdruhg.supabase.co';
const production='https://tyulybijubckitybgubc.supabase.co';
const transaction=environment=>({transactionId:'123456789',environment,
 productId:'com.ayuhide.koenofurima.voice.jpy1000',type:'Consumable',quantity:1,
 inAppOwnershipType:'PURCHASED',appAccountToken:'00000000-0000-4000-8000-000000000001',
 purchaseDate:1000000000000,price:1000000,currency:'JPY'});
function fixture({project=recording,environment='Production',authoritativeEnvironment=environment}={}){
 const calls=[];let signatures=0;
 const env={SUPABASE_URL:project,APPLE_VERIFIER_URL:'https://verifier.example.invalid/',
  APPLE_VERIFIER_SHARED_SECRET:'unit-test-only-verifier-credential-32bytes',
  APPLE_IAP_PRIVATE_KEY:'AA==',APPLE_IAP_KEY_ID:'TESTKEY',APPLE_IAP_ISSUER_ID:'test-issuer'};
 const adapter=createAppleAdapter({getEnv:name=>env[name],cryptoImpl:{subtle:{
  importKey:async()=>({}),sign:async()=>{signatures++;return new Uint8Array(64);}
 }},fetchImpl:async(url,options)=>{
  const target=String(url);calls.push(target);
  if(target==='https://verifier.example.invalid/v1/notification')return Response.json({notification:{notificationType:'TEST',environment}});
  if(target==='https://verifier.example.invalid/v1/transaction'){
   const body=JSON.parse(options.body);
   return Response.json({transaction:transaction(body.signedTransaction==='authoritative'?authoritativeEnvironment:environment)});
  }
  assert.ok(target.startsWith('https://api.storekit-sandbox.apple.com/')||target.startsWith('https://api.storekit.apple.com/'));
  return Response.json({signedTransactionInfo:'authoritative'});
 }});
 return {adapter,calls,signatures:()=>signatures};
}

test('recording database rejects signed Production receipt before Apple signing or authoritative API lookup',async()=>{
 const f=fixture();await assert.rejects(f.adapter.verifiedTransaction('submitted'),/SANDBOX_ENVIRONMENT_REQUIRED/);
 assert.deepEqual(f.calls,['https://verifier.example.invalid/v1/transaction']);assert.equal(f.signatures(),0);
});
test('recording database rejects direct Production refresh before any network request',async()=>{
 const f=fixture();await assert.rejects(f.adapter.verifiedTransactionById('123456789','Production'),/SANDBOX_ENVIRONMENT_REQUIRED/);
 assert.deepEqual(f.calls,[]);assert.equal(f.signatures(),0);
});
test('recording database rejects a signed Production notification instead of acknowledging it',async()=>{
 const f=fixture();await assert.rejects(f.adapter.verifyAndDecodeNotification('signed-test'),/SANDBOX_ENVIRONMENT_REQUIRED/);
 assert.deepEqual(f.calls,['https://verifier.example.invalid/v1/notification']);assert.equal(f.signatures(),0);
});
test('recording database preserves Sandbox receipt verification and canonical lookup',async()=>{
 const f=fixture({environment:'Sandbox'});assert.deepEqual(await f.adapter.verifiedTransaction('submitted'),transaction('Sandbox'));
 assert.deepEqual(f.calls,['https://verifier.example.invalid/v1/transaction','https://api.storekit-sandbox.apple.com/inApps/v1/transactions/123456789','https://verifier.example.invalid/v1/transaction']);assert.equal(f.signatures(),1);
});
test('recording database preserves Sandbox direct refresh and TEST notifications',async()=>{
 const f=fixture({environment:'Sandbox'});assert.equal((await f.adapter.verifiedTransactionById('123456789','Sandbox')).environment,'Sandbox');
 assert.equal((await f.adapter.verifyAndDecodeNotification('signed-test')).notificationType,'TEST');
 assert.ok(f.calls.every(url=>!url.startsWith('https://api.storekit.apple.com/')));
});
test('recording database rejects an authoritative response that switches environment',async()=>{
 const f=fixture({environment:'Sandbox',authoritativeEnvironment:'Production'});
 await assert.rejects(f.adapter.verifiedTransaction('submitted'),/SANDBOX_ENVIRONMENT_REQUIRED/);
 assert.equal(f.calls.filter(url=>url.startsWith('https://api.storekit-sandbox.apple.com/')).length,1);
 assert.equal(f.calls.filter(url=>url.startsWith('https://api.storekit.apple.com/')).length,0);
});
test('recording host detection accepts canonical URL variations without permitting Production',async()=>{
 for(const project of [recording+'/', 'https://NEOTKRFSQUYSUATDRUHG.supabase.co:443/']){
  const f=fixture({project});await assert.rejects(f.adapter.verifiedTransactionById('123456789','Production'),/SANDBOX_ENVIRONMENT_REQUIRED/);assert.equal(f.calls.length,0);
 }
});
test('existing production database retains Production verification and notification behavior',async()=>{
 const f=fixture({project:production});assert.deepEqual(await f.adapter.verifiedTransaction('submitted'),transaction('Production'));
 assert.ok(f.calls.includes('https://api.storekit.apple.com/inApps/v1/transactions/123456789'));
 assert.equal((await f.adapter.verifyAndDecodeNotification('signed-test')).environment,'Production');assert.equal(f.signatures(),1);
});
test('existing adapter callers without a project URL retain prior behavior',async()=>{
 const f=fixture({project:''});assert.equal((await f.adapter.verifiedTransactionById('123456789','Production')).environment,'Production');
 assert.ok(f.calls.includes('https://api.storekit.apple.com/inApps/v1/transactions/123456789'));
});
