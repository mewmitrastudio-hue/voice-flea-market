import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler,verifyTransaction} from '../index.mjs';

const secret='test-only-service-key-0123456789abcdef';
const env={APPLE_VERIFIER_SHARED_SECRET:secret};
const request=(body,auth=secret,path='/v1/notification')=>new Request(`https://verifier.invalid${path}`,{method:'POST',headers:{Authorization:`Bearer ${auth}`},body:JSON.stringify(body)});
const valid={transactionId:'123',environment:'Sandbox',productId:'com.ayuhide.koenofurima.boost.silver',type:'Consumable',quantity:1,inAppOwnershipType:'PURCHASED',appAccountToken:'00000000-0000-4000-8000-000000000001',purchaseDate:1000};

test('authentication fails before signed data or configuration is processed',async()=>{
 let calls=0;const handler=createHandler(()=>{calls++;throw new Error('must not reach');});
 assert.equal((await handler(request({signedPayload:'a.b.c'},'wrong'),env)).status,401);
 assert.equal((await handler(request({signedPayload:'a.b.c'}),{})).status,503);
 assert.equal(calls,0);
});
test('malformed and oversized requests never reach the verifier',async()=>{
 let calls=0;const handler=createHandler(()=>{calls++;return [];});
 assert.equal((await handler(request({signedPayload:'invalid'}),env)).status,400);
 assert.equal((await handler(request({signedPayload:'a'.repeat(70001)}),env)).status,413);
 assert.equal(calls,0);
});
test('only a verified TEST notification is acknowledged',async()=>{
 const handler=createHandler(()=>[{environment:'Sandbox',verifier:{verifyAndDecodeNotification:async()=>({notificationType:'TEST'})}}]);
 const response=await handler(request({signedPayload:'a.b.c'}),env);
 assert.deepEqual(await response.json(),{notificationType:'TEST'});
 const failed=createHandler(()=>[{verifier:{verifyAndDecodeNotification:async()=>{throw {status:1};}}}]);
 assert.equal((await failed(request({signedPayload:'a.b.c'}),env)).status,503);
});
test('production purchases use the authenticated production verifier and API',async()=>{
 let sandboxApiCalls=0,productionApiCalls=0;
 const tx={...valid,environment:'Production'};
 const config=[{environment:'Sandbox',verifier:{verifyAndDecodeTransaction:async()=>{throw {status:4};}},client:{getTransactionInfo:async()=>{sandboxApiCalls++;}}},{environment:'Production',verifier:{verifyAndDecodeTransaction:async()=>tx},client:{getTransactionInfo:async()=>{productionApiCalls++;return {signedTransactionInfo:'authoritative'};}}}];
 const verified=await verifyTransaction(config,'submitted');
 assert.equal(verified.environment,'Production');assert.equal(sandboxApiCalls,0);assert.equal(productionApiCalls,1);
});
test('invalid signatures do not fall through to a second environment',async()=>{
 let fallbackCalls=0;
 await assert.rejects(verifyTransaction([{verifier:{verifyAndDecodeTransaction:async()=>{throw {status:1};}}},{verifier:{verifyAndDecodeTransaction:async()=>{fallbackCalls++;return valid;}}}],'signed'));
 assert.equal(fallbackCalls,0);
});
test('server response must match transaction, environment, product and ownership',async()=>{
 for(const change of [{transactionId:'999'},{environment:'Production'},{productId:'unrelated'},{type:'Auto-Renewable Subscription'},{quantity:2},{inAppOwnershipType:'FAMILY_SHARED'},{appAccountToken:undefined},{purchaseDate:NaN}]){
  let calls=0;const config={environment:'Sandbox',verifier:{verifyAndDecodeTransaction:async()=>calls++?{...valid,...change}:valid},client:{getTransactionInfo:async()=>({signedTransactionInfo:'authoritative'})}};
  await assert.rejects(verifyTransaction([config],'submitted'),/TRANSACTION_MISMATCH/);
 }
});
