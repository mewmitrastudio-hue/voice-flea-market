import test from 'node:test';
import assert from 'node:assert/strict';
import {createSignatureHandler} from '../signature-only.mjs';
import {createAppleAdapter} from '../../../supabase/functions/_shared/apple-adapter.mjs';
const secret='test-only-shared-secret-0123456789abcdef';
const tx={transactionId:'123456789',environment:'Sandbox',productId:'com.ayuhide.koenofurima.voice.jpy1000',type:'Consumable',quantity:1,inAppOwnershipType:'PURCHASED',appAccountToken:'12345678-1234-1234-1234-123456789012',purchaseDate:Date.now(),price:1000000,currency:'JPY'};
test('deployed signature worker preserves authenticated voice amount and rejects missing/foreign price metadata',async()=>{
 let value=tx;
 const h=createSignatureHandler(async()=>[{environment:'Sandbox',verifier:{verifyAndDecodeTransaction:async()=>value}}]);
 const request=()=>new Request('https://local.invalid/v1/transaction',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:JSON.stringify({signedTransaction:'a.b.c'})});
 const r=await h(request(),{APPLE_VERIFIER_SHARED_SECRET:secret});assert.equal(r.status,200);assert.deepEqual((await r.json()).transaction,tx);
 for(const changed of [{price:undefined},{price:1000.1},{currency:'USD'},{productId:tx.productId+'.arbitrary'},{quantity:2}]){
  value={...tx,...changed};assert.equal((await h(request(),{APPLE_VERIFIER_SHARED_SECRET:secret})).status,503);
 }
});
test('actual Edge adapter checks authoritative Apple price and current revocation before returning a voice receipt',async()=>{
 const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const pem='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';
 const env={APPLE_VERIFIER_URL:'https://verify.example/',APPLE_VERIFIER_SHARED_SECRET:secret,APPLE_IAP_PRIVATE_KEY:pem,APPLE_IAP_KEY_ID:'TESTKEY',APPLE_IAP_ISSUER_ID:'test-issuer'};
 let count=0,price=tx.price;
 const adapter=createAppleAdapter({getEnv:k=>env[k],fetchImpl:async(url)=>String(url).startsWith('https://verify.example/')?Response.json({transaction:++count%2===1?tx:{...tx,price,revocationDate:Date.now()}}):Response.json({signedTransactionInfo:'latest.signed.transaction'})});
 assert.ok((await adapter.verifiedTransaction('incoming.signed.transaction')).revocationDate);
 price=999000;await assert.rejects(adapter.verifiedTransaction('incoming.signed.transaction'),/TRANSACTION_MISMATCH/);
});
