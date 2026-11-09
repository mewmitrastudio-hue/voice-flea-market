import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {jobDatabase} from './fixtures/receipt-database.mjs';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',listing='00000000-0000-4000-8000-000000000004';
async function setup(){const db=await jobDatabase();await db.exec(`create schema storage;create table storage.objects(bucket_id text,name text,owner_id text);create table voice_flea_private.account_deletions(user_id uuid primary key);create table listing_boosts(seller_id uuid,status text,ends_at timestamptz);`);await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261028234040_terminal_trade_and_deletion.sql',import.meta.url),'utf8'));await db.exec(`create table voice_flea_private.apple_financial_reports(id uuid primary key,snapshot jsonb);
 create function voice_flea_private.is_moderator() returns boolean language sql as $$select true$$;`);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261029033154_apple_proceeds_allocation_ledger.sql',import.meta.url),'utf8'));
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261102020226_guard_apple_refund_settlement_on_deletion.sql',import.meta.url),'utf8'));
 return db;}
const deletion=db=>db.query('select public.prepare_account_deletion($1) r',[buyer]).then(x=>x.rows[0].r);
async function trade(db){
 const p=(await db.query("insert into payments(listing_id,buyer_id,seller_id,amount_jpy,platform_fee_jpy,seller_amount_jpy,status,stripe_reconciled_at,stripe_livemode,refunded_amount_jpy) values($1,$2,$3,1000,150,850,'paid',now(),false,0) returning id",[listing,buyer,seller])).rows[0].id;
 const c=(await db.query('insert into conversations(listing_id,buyer_id,seller_id,payment_id) values($1,$2,$3,$4) returning id',[listing,buyer,seller,p])).rows[0].id;return {p,c};
}
test('a full verified refund closes an unaccepted trade; a status label without refund evidence does not',async()=>{
 const db=await setup();try{const {p}=await trade(db);assert.equal((await deletion(db)).allowed,false);
 await db.query("update payments set status='refunded',refunded_amount_jpy=1000,stripe_reconciled_at=null where id=$1",[p]);assert.equal((await deletion(db)).allowed,false);
 await db.query('update payments set stripe_reconciled_at=now() where id=$1',[p]);assert.equal((await deletion(db)).allowed,true);
 }finally{await db.close();}
});
test('another accepted purchase cannot release an unlinked payment from account deletion checks',async()=>{
 const db=await setup();try{const {c}=await trade(db);await db.query("update conversations set delivery_status='accepted',delivery_path='voice.m4a',accepted_at=now() where id=$1",[c]);assert.equal((await deletion(db)).allowed,true);
 await db.query("insert into payments(listing_id,buyer_id,seller_id,amount_jpy,status) values($1,$2,$3,1000,'paid')",[listing,buyer,seller]);const result=await deletion(db);assert.equal(result.allowed,false);assert.match(result.message,/対応が未確認/);
 }finally{await db.close();}
});
test('only an exact completed authorization cancellation releases an undelivered trade',async()=>{
 const db=await setup();try{const {p,c}=await trade(db);await db.query("update payments set status='canceled',stripe_capture_method='manual' where id=$1",[p]);assert.equal((await deletion(db)).allowed,false);
 await db.query("insert into voice_flea_private.authorization_cancellations(conversation_id,payment_id,buyer_approved,seller_approved,state) values($1,$2,true,true,'canceled')",[c,p]);assert.equal((await deletion(db)).allowed,true);
 }finally{await db.close();}
});

test('an already paid boost does not force waiting for expiry to delete; an unsettled purchase still needs reconciliation',async()=>{
 const db=await setup();try{
 await db.query("insert into listing_boosts values($1,'active',now()+interval '30 days')",[buyer]);assert.equal((await deletion(db)).allowed,true);
 await db.query("insert into listing_boosts values($1,'pending',null)",[buyer]);assert.equal((await deletion(db)).allowed,false);
 }finally{await db.close();}
});

test('a canceled unpaid job agreement does not trap the account behind an abandoned chat',async()=>{
 const db=await setup();try{
 const job='00000000-0000-4000-8000-000000000010';await db.query("insert into jobs(id,buyer_id,title,budget_jpy) values($1,$2,'Job',1000)",[job,buyer]);
 await db.query("insert into applications(job_id,applicant_id,status) values($1,$2,'pending')",[job,seller]);
 await db.query('insert into conversations(job_id,buyer_id,seller_id) values($1,$2,$3)',[job,buyer,seller]);
 assert.equal((await deletion(db)).allowed,true);
 }finally{await db.close();}
});

async function appleSale(db,withAllocation){
 const p=(await db.query("insert into payments(listing_id,buyer_id,seller_id,amount_jpy,payment_channel,apple_transaction_id,apple_environment,apple_verified_at,platform_fee_jpy,seller_amount_jpy,status,refunded_amount_jpy) values($1,$2,$3,1000,'ios','123456','Production',now(),null,null,'paid',0) returning id",[listing,buyer,seller])).rows[0].id;
 await db.query("insert into conversations(listing_id,buyer_id,seller_id,payment_id,delivery_status,delivery_path,accepted_at) values($1,$2,$3,$4,'accepted','voice.m4a',now())",[listing,buyer,seller,p]);
 if(withAllocation){
  const report=(await db.query("insert into voice_flea_private.apple_financial_reports values(gen_random_uuid(),'{}') returning id")).rows[0].id;
  const batch=(await db.query("insert into voice_flea_private.apple_proceeds_batches(report_id,report_line,payment_ids,source_proceeds,allocated_jpy,fractional_remainder,allocated_by) values($1,2,$2,700,700,0,$3) returning id",[report,[p],buyer])).rows[0].id;
  await db.query("insert into voice_flea_private.apple_proceeds_allocations(payment_id,batch_id,seller_id,net_jpy,platform_fee_jpy,seller_amount_jpy) values($1,$2,$3,700,105,595)",[p,batch,seller]);
 }
 return p;
}
test('an Apple refund after allocation cannot delete the seller while recovery is unresolved',async()=>{
 const db=await setup();try{
  const p=await appleSale(db,true);
  await db.query("update payments set status='refunded',refunded_amount_jpy=1000 where id=$1",[p]);
  assert.equal((await db.query('select state from voice_flea_private.apple_proceeds_allocations where payment_id=$1',[p])).rows[0].state,'adjustment_required');
  const result=(await db.query('select public.prepare_account_deletion($1) r',[seller])).rows[0].r;
  assert.equal(result.allowed,false);assert.match(result.message,/Apple売上の精算/);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.account_deletions where user_id=$1',[seller])).rows[0].n,0);
  assert.equal((await db.query('select is_active from listings where id=$1',[listing])).rows[0].is_active,true);
  assert.equal((await deletion(db)).allowed,true,'buyer refund is complete and must not inherit seller debt');
 }finally{await db.close();}
});
test('an unallocated verified full Apple refund does not invent a seller liability',async()=>{
 const db=await setup();try{
  const p=await appleSale(db,false);
  assert.equal((await db.query('select public.prepare_account_deletion($1) r',[seller])).rows[0].r.allowed,false);
  await db.query("update payments set status='refunded',refunded_amount_jpy=1000 where id=$1",[p]);
  assert.equal((await db.query('select public.prepare_account_deletion($1) r',[seller])).rows[0].r.allowed,true);
 }finally{await db.close();}
});

test('prepared stopped account regenerates remaining public Storage plan after anonymization and partial removal',async()=>{
 const db=await setup();try{
 await db.query("insert into storage.objects values('voice-samples','owner/sample.m4a',$1),('profile-avatars','owner/avatar.png',$1),('deliveries','paid/private.m4a',$1)",[buyer]);
 const first=await deletion(db);assert.equal(first.allowed,true);assert.equal(first.files.length,2);
 // finish clears public paths, but Storage owns the cleanup inventory independently.
 await db.exec('alter table listings add column if not exists sample_path text');
 await db.query('update listings set sample_path=null,is_active=false where seller_id=$1',[buyer]);
 await db.query("delete from storage.objects where bucket_id='voice-samples' and owner_id=$1",[buyer]);
 const retry=await deletion(db);assert.equal(retry.allowed,true);
 assert.deepEqual(retry.files,[{bucket:'profile-avatars',name:'owner/avatar.png'}]);
 assert.equal((await db.query('select count(*)::int n from voice_flea_private.account_deletions')).rows[0].n,1);
 }finally{await db.close();}
});
