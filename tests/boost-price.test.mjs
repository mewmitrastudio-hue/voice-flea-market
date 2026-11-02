import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
test('boost grants require authenticated exact yen amount; refunds can revoke legacy or repriced purchases',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create table calls(sku text,revoked boolean);
   create function public.apply_verified_apple_boost(order_id uuid,tx_id text,sku text,tx_environment text,purchased_at timestamptz,revoked boolean)
   returns jsonb language plpgsql as $$begin insert into public.calls values(sku,revoked);return jsonb_build_object('revoked',revoked);end $$;`);
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261028020000_priced_boost_receipts.sql',import.meta.url),'utf8'));
  const apply=(plan,price,currency='JPY',revoked=false)=>db.query("select public.apply_priced_apple_boost('00000000-0000-4000-8000-000000000001','123',$1,'Sandbox',now(),$2,$3,$4)",['com.ayuhide.koenofurima.boost.'+plan,revoked,price,currency]);
  for(const [plan,amount] of [['silver',300],['gold',800],['platinum',1500]]){
   await apply(plan,amount*1000);
   for(const [price,currency] of [[amount,'JPY'],[amount*1000,'USD'],[null,'JPY'],[0,'JPY']])await assert.rejects(apply(plan,price,currency),/price mismatch/);
  }
  assert.equal((await db.query('select count(*)::int n from calls')).rows[0].n,3);
  await apply('gold',500000,'JPY',true);await apply('silver',null,null,true);
  assert.equal((await db.query('select count(*)::int n from calls where revoked')).rows[0].n,2);
  await assert.rejects(apply('invalid',300000,'JPY',true),/price mismatch/);
  await db.exec('set role authenticated');await assert.rejects(apply('silver',300000),/permission denied/);
 }finally{await db.close();}
});
test('shared Apple dispatcher passes signed price and current buyer without inventing a charge amount',async()=>{
 const code=fs.readFileSync(new URL('../supabase/functions/_shared/apple.ts',import.meta.url),'utf8');
 const c={Date};vm.createContext(c);vm.runInContext(stripTypeScriptTypes(code.slice(code.indexOf('export async function applyTransaction')).replace('export ','')),c);
 const calls=[],admin={rpc:async(name,args)=>{calls.push({name,args});return {data:{success:true}};}};
 const tx={productId:'com.ayuhide.koenofurima.boost.gold',transactionId:'123',appAccountToken:'order',environment:'Sandbox',purchaseDate:Date.now(),price:800000,currency:'JPY'};
 await c.applyTransaction(admin,tx);assert.equal(calls[0].name,'apply_priced_apple_boost');assert.equal(calls[0].args.price_milliunits,800000);
 await c.applyTransaction(admin,{...tx,price:undefined,currency:undefined,revocationDate:Date.now()});assert.equal(calls[1].args.price_milliunits,null);assert.equal(calls[1].args.revoked,true);
 await c.applyTransaction(admin,{...tx,productId:'com.ayuhide.koenofurima.voice.jpy1000',price:1000000},'buyer');
 assert.equal(calls[2].name,'apply_verified_apple_voice');assert.equal(calls[2].args.actor,'buyer');assert.equal(calls[2].args.price_milliunits,1000000);
});
