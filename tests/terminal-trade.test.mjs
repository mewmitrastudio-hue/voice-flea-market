import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {jobDatabase} from './fixtures/receipt-database.mjs';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',listing='00000000-0000-4000-8000-000000000004';
async function setup(){const db=await jobDatabase();await db.exec(`create schema storage;create table storage.objects(bucket_id text,name text,owner_id text);create table voice_flea_private.account_deletions(user_id uuid primary key);create table listing_boosts(seller_id uuid,status text,ends_at timestamptz);`);await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261028234040_terminal_trade_and_deletion.sql',import.meta.url),'utf8'));return db;}
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
