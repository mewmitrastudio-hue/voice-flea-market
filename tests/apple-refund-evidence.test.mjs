import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const code=fs.readFileSync(new URL('../supabase/functions/_shared/apple.ts',import.meta.url),'utf8');
const tx={productId:'com.ayuhide.koenofurima.voice.jpy1000',appAccountToken:'order',transactionId:'123',environment:'Production',purchaseDate:1,price:1000000,currency:'JPY',revocationDate:2,refundEvidenceVersion:1};
function harness(){const c={Date};vm.createContext(c);vm.runInContext(stripTypeScriptTypes(code.slice(code.indexOf('export async function applyTransaction')).replace('export ','')),c);return c;}
test('prorated or unknown Apple revocation never becomes a full-refund database mutation',async()=>{
 for(const fields of [{revocationType:'REFUND_PRORATED',revocationPercentage:50000},{revocationType:'REFUND_FULL',revocationPercentage:50000},{revocationType:'FAMILY_REVOKE'},{revocationType:'NEW_TYPE'},{revocationPercentage:NaN},{refundEvidenceVersion:undefined},{revocationDate:0},{revocationDate:null},{revocationDate:undefined,revocationType:'REFUND_PRORATED'}]){
  let writes=[];await assert.rejects(harness().applyTransaction({rpc:async(name)=>{writes.push(name);return {data:{}};}},{...tx,...fields}),/APPLE_REFUND/);assert.ok(writes.every(n=>n==='record_apple_refund_review'));
 }
});
test('an explicit full or versioned legacy full refund retains exact purchase identity',async()=>{
 for(const fields of [{},{revocationType:'REFUND_FULL',revocationPercentage:100000}]){let args;await harness().applyTransaction({rpc:async(name,a)=>{args=a;return {data:{}};}},{...tx,...fields});assert.equal(args.revoked,true);assert.equal(args.tx_id,'123');}
});

test('unsupported refund waits for durable hold and fails when persistence fails',async()=>{
 let calls=[];await assert.rejects(harness().applyTransaction({rpc:async(name,args)=>{calls.push({name,args});return {error:{message:'offline'}};}},{...tx,revocationType:'REFUND_PRORATED',revocationPercentage:50000},'buyer'),/APPLE_REFUND_HOLD_NOT_CONFIRMED/);
 assert.equal(calls.length,1);assert.equal(calls[0].name,'record_apple_refund_review');assert.equal(calls[0].args.actor,'buyer');assert.equal(calls[0].args.evidence.revocationPercentage,50000);
});
