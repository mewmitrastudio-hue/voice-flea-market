import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {jobDatabase} from './fixtures/receipt-database.mjs';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',job='00000000-0000-4000-8000-000000000010',application='00000000-0000-4000-8000-000000000011';
async function setup(){
 const db=await jobDatabase();
 await db.exec(`create schema storage;create table storage.objects(bucket_id text,name text,owner_id text);create table voice_flea_private.account_deletions(user_id uuid primary key);create table listing_boosts(seller_id uuid,status text,ends_at timestamptz);
 insert into jobs(id,buyer_id,title,budget_jpy,status) values('${job}','${buyer}','Job voice',1500,'open');
 insert into applications(id,job_id,applicant_id,status) values('${application}','${job}','${seller}','pending');
 update applications set status='accepted' where id='${application}';`);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261028234040_terminal_trade_and_deletion.sql',import.meta.url),'utf8'));
 const q=(await db.query('select public.prepare_job_checkout($1,$2,$3) q',[buyer,application,'acct_seller'])).rows[0].q;
 const snapshot={reservation_id:q.reservation_id,job_id:job,job_application_id:application,buyer_id:buyer,seller_id:seller,amount_jpy:1500,stripe_payment_intent_id:'pi_job',stripe_charge_id:'ch_job',stripe_checkout_session_id:'cs_test_job',stripe_livemode:false,stripe_destination:'acct_seller',stripe_reconciled_at:new Date().toISOString(),authorization_expires_at:new Date(Date.now()+86400000).toISOString()};
 await db.query('update voice_flea_private.checkout_reservations set session_id=$1 where id=$2',[snapshot.stripe_checkout_session_id,q.reservation_id]);
 await db.query('select public.record_stripe_authorization($1)',[snapshot]);
 await db.query('select public.finish_checkout_reservation($1,$2)',[q.reservation_id,snapshot.stripe_checkout_session_id]);
 const c=(await db.query('select * from conversations')).rows[0];return {db,c,snapshot};
}
const deletion=(db,actor)=>db.query('select public.prepare_account_deletion($1) r',[actor]).then(x=>x.rows[0].r);
test('job cancellation blocks deletion until confirmed, then releases both accounts without erasing payment history',async()=>{
 const {db,c}=await setup();try{
  assert.equal((await deletion(db,buyer)).allowed,false);
  await db.query('select public.prepare_authorization_cancellation($1,$2)',[buyer,c.id]);
  assert.equal((await deletion(db,seller)).allowed,false);
  await db.query('select public.prepare_authorization_cancellation($1,$2)',[seller,c.id]);
  assert.equal((await deletion(db,buyer)).allowed,false);
  await db.query('select public.finish_authorization_cancellation($1,$2)',[buyer,c.id]);
  assert.equal((await db.query('select status from jobs')).rows[0].status,'cancelled');
  assert.equal((await deletion(db,buyer)).allowed,true);assert.equal((await deletion(db,seller)).allowed,true);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,1);
  await assert.rejects(db.query('select public.prepare_voice_renewal_checkout($1,$2)',[buyer,c.id]));
 }finally{await db.close();}
});
test('job renewal preserves delivered audio and price; only final receipt clears both deletion blockers',async()=>{
 const {db,c,snapshot}=await setup();try{
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
  await db.query("update conversations set delivery_status='submitted',delivery_path=id::text||'/voice.m4a' where id=$1",[c.id]);
  await db.exec("reset role;set request.jwt.claim.sub='';update payments set authorization_expires_at=now()-interval '1 second';update jobs set budget_jpy=9000");
  const q=(await db.query('select public.prepare_voice_renewal_checkout($1,$2) q',[buyer,c.id])).rows[0].q;
  assert.equal(q.amount_jpy,1500);assert.equal(q.job_application_id,application);
  assert.equal((await deletion(db,buyer)).allowed,false);
  const fresh={...snapshot,reservation_id:q.reservation_id,stripe_payment_intent_id:'pi_jobrenew',stripe_charge_id:'ch_jobrenew',stripe_checkout_session_id:'cs_test_jobrenew'};
  await db.query('update voice_flea_private.checkout_reservations set session_id=$1 where id=$2',[fresh.stripe_checkout_session_id,q.reservation_id]);
  await db.query('select public.record_stripe_authorization($1)',[fresh]);
  await db.query('select public.finish_checkout_reservation($1,$2)',[q.reservation_id,fresh.stripe_checkout_session_id]);
  const renewed=(await db.query('select * from conversations')).rows;assert.equal(renewed.length,1);assert.equal(renewed[0].id,c.id);assert.equal(renewed[0].delivery_path,c.id+'/voice.m4a');
  assert.equal((await deletion(db,seller)).allowed,false);
  await db.query('select public.prepare_delivery_acceptance($1,$2)',[buyer,c.id]);
  await db.query("update payments set status='paid',stripe_reconciled_at=clock_timestamp() where id=$1",[renewed[0].payment_id]);
  await db.query("select public.finalize_delivery_acceptance($1,$2,'tr_jobrenew')",[buyer,c.id]);
  assert.equal((await db.query('select status from jobs')).rows[0].status,'closed');
  assert.equal((await deletion(db,buyer)).allowed,true);assert.equal((await deletion(db,seller)).allowed,true);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,2);
 }finally{await db.close();}
});
