import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';

const seller='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
const buyer='00000000-0000-4000-8000-000000000003';
const migration=fs.readFileSync(new URL('../supabase/migrations/20261028084936_apple_finance_classification.sql',import.meta.url),'utf8');
test('seller summary distinguishes verified Apple Sandbox and unknown proceeds without trusting Stripe evidence on an Apple row',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to authenticated;
   create table payments(seller_id uuid,buyer_id uuid,seller_amount_jpy integer,status text,payment_channel text,
    stripe_livemode boolean,stripe_reconciled_at timestamptz,refunded_amount_jpy integer,apple_environment text,apple_verified_at timestamptz);
   alter table payments enable row level security;grant select on payments to authenticated;
   create policy own on payments for select to authenticated using(seller_id=auth.uid() or buyer_id=auth.uid());
   insert into payments values
    ('${seller}','${buyer}',850,'paid','web',true,now(),0,null,null),
    ('${seller}','${buyer}',850,'paid','web',false,now(),0,null,null),
    ('${seller}','${buyer}',850,'paid','web',null,null,null,null,null),
    ('${seller}','${buyer}',null,'paid','ios',null,null,0,'Sandbox',now()),
    ('${seller}','${buyer}',null,'paid','ios',null,null,0,'Production',now()),
    ('${seller}','${buyer}',null,'paid','ios',null,null,0,'Production',null),
    ('${seller}','${buyer}',99999,'paid','ios',true,now(),0,'Production',now()),
    ('${seller}','${buyer}',null,'refunded','ios',null,null,1000,'Production',now()),
    ('${seller}','${buyer}',850,'partially_refunded','web',true,now(),500,null,null),
    ('${other}','${buyer}',999,'paid','web',true,now(),0,null,null);
  `);
  await db.exec(migration);
  assert.equal((await db.query("select has_function_privilege('anon','public.seller_finance_summary()','execute') p")).rows[0].p,false);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
  const summary=async()=>(await db.query('select public.seller_finance_summary() r')).rows[0].r;
  assert.deepEqual(await summary(),{count:1,payout:850,unverified:2,test:2,adjusting:2,apple_settlement_pending:2});
  await db.exec(`set request.jwt.claim.sub='${other}'`);
  assert.deepEqual(await summary(),{count:1,payout:999,unverified:0,test:0,adjusting:0,apple_settlement_pending:0});
  await db.exec(`set request.jwt.claim.sub='${buyer}'`);assert.equal((await summary()).payout,0);
  await db.exec("set request.jwt.claim.sub=''");assert.equal((await summary()).count,0);
 }finally{await db.close();}
});

test('finance notice identifies Apple proceeds awaiting reconciliation and handles an older server without claiming zero',()=>{
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const c={Number};vm.createContext(c);
 vm.runInContext(html.slice(html.indexOf('function sellerFinanceNotice('),html.indexOf('function applySellerFinance(')),c);
 const data={unverified:1,test:2,adjusting:3,apple_settlement_pending:4};
 assert.match(c.sellerFinanceNotice(data),/Apple本番購入の精算待ち 4件/);
 assert.match(c.sellerFinanceNotice(data),/金額に含めません/);
 delete data.apple_settlement_pending;
 assert.match(c.sellerFinanceNotice(data),/Apple購入の精算状況は未確認/);
 assert.doesNotMatch(c.sellerFinanceNotice(data),/精算待ち 0件/);
});
