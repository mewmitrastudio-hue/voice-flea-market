import test from 'node:test';
import assert from 'node:assert/strict';
import {createSignatureHandler} from '../signature-only.mjs';
import {createAppleAdapter} from '../supabase-adapter.mjs';
const secret='test-only-shared-secret-0123456789abcdef';
const tx={transactionId:'123456789',environment:'Sandbox',productId:'com.ayuhide.koenofurima.boost.silver',type:'Consumable',quantity:1,inAppOwnershipType:'PURCHASED',appAccountToken:'12345678-1234-1234-1234-123456789012',purchaseDate:1000000000000};
const response=x=>Response.json(x);

test('signature service operates without signing key and rejects unauthenticated requests before verification',async()=>{
 let calls=0;const h=createSignatureHandler(async()=>{calls++;return [{environment:'Sandbox',verifier:{verifyAndDecodeNotification:async()=>({notificationType:'TEST'})}}]});
 const request=auth=>new Request('https://local.invalid/v1/notification',{method:'POST',headers:auth?{Authorization:`Bearer ${secret}`}:{},body:JSON.stringify({signedPayload:'a.b.c'})});
 assert.equal((await h(request(false),{APPLE_VERIFIER_SHARED_SECRET:secret})).status,401);assert.equal(calls,0);
 const r=await h(request(true),{APPLE_VERIFIER_SHARED_SECRET:secret});assert.equal(r.status,200);assert.deepEqual(await r.json(),{notification:{notificationType:'TEST',environment:'Sandbox'}});
});

test('signature service rejects excessive bodies before certificate parsing',async()=>{
 let calls=0;const h=createSignatureHandler(async()=>{calls++;throw Error('must not run')});
 const r=await h(new Request('https://local.invalid/v1/transaction',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:'x'.repeat(70001)}),{APPLE_VERIFIER_SHARED_SECRET:secret});
 assert.equal(r.status,413);assert.equal(calls,0);
});

async function setup(fetchHandler){
 const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const pem='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';
 const env={APPLE_VERIFIER_URL:'https://verify.example/',APPLE_VERIFIER_SHARED_SECRET:secret,APPLE_IAP_PRIVATE_KEY:pem,APPLE_IAP_KEY_ID:'TESTKEY',APPLE_IAP_ISSUER_ID:'test-issuer'};
 return {keys,pem,adapter:createAppleAdapter({getEnv:n=>env[n],fetchImpl:async(url,options)=>fetchHandler(String(url),options,{keys,pem})})};
}

test('upstream signs Apple request locally and never sends its private key to the verifier',async()=>{
 let verifierCalls=0,appleCalls=0;
 const {adapter}=await setup(async(url,options,{keys,pem})=>{
  if(url.startsWith('https://verify.example/')){verifierCalls++;assert.equal(options.headers.Authorization,`Bearer ${secret}`);assert.ok(!options.body.includes(pem));assert.equal(options.redirect,'error');return response({transaction:tx});}
  appleCalls++;assert.equal(url,'https://api.storekit-sandbox.apple.com/inApps/v1/transactions/123456789');
  const jwt=options.headers.Authorization.slice(7).split('.');const claims=JSON.parse(Buffer.from(jwt[1],'base64url'));
  assert.equal(claims.bid,'com.ayuhide.koenofurima');assert.equal(claims.aud,'appstoreconnect-v1');assert.equal(claims.exp-claims.iat,180);
  assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},keys.publicKey,Buffer.from(jwt[2],'base64url'),new TextEncoder().encode(jwt.slice(0,2).join('.'))),true);
  return response({signedTransactionInfo:'authoritative.signed.transaction'});
 });
 assert.deepEqual(await adapter.verifiedTransaction('incoming.signed.transaction'),tx);assert.equal(verifierCalls,2);assert.equal(appleCalls,1);
});

test('unverified input never reaches Apple API and authoritative identity changes fail closed',async()=>{
 let calls=0;const first=await setup(async()=>{calls++;return new Response('{}',{status:503})});
 await assert.rejects(first.adapter.verifiedTransaction('bad'),/APPLE_SIGNATURE_UNVERIFIED/);assert.equal(calls,1);
 let verified=0;const second=await setup(async url=>url.startsWith('https://verify.example/')?response({transaction:++verified===1?tx:{...tx,appAccountToken:'99999999-1234-1234-1234-123456789012'}}):response({signedTransactionInfo:'latest'}));
 await assert.rejects(second.adapter.verifiedTransaction('original'),/TRANSACTION_MISMATCH/);
});

test('authoritative revocation is preserved and API authentication failure never produces a purchase',async()=>{
 let verified=0;const valid=await setup(async url=>url.startsWith('https://verify.example/')?response({transaction:++verified===1?tx:{...tx,revocationDate:1000000001000}}):response({signedTransactionInfo:'latest'}));
 assert.equal((await valid.adapter.verifiedTransaction('original')).revocationDate,1000000001000);
 const failure=await setup(async url=>url.startsWith('https://verify.example/')?response({transaction:tx}):new Response('',{status:401}));
 await assert.rejects(failure.adapter.verifiedTransaction('original'),/APPLE_API_UNAVAILABLE/);
});
