import fs from 'node:fs';
import {jobDatabase} from './receipt-database.mjs';
const owner='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',listing='00000000-0000-4000-8000-000000000004';
const order='00000000-0000-4000-8000-000000000005',fresh='00000000-0000-4000-8000-000000000006',another='00000000-0000-4000-8000-000000000007',sku='com.ayuhide.koenofurima.voice.jpy1000';
const boostListing='00000000-0000-4000-8000-000000000008';
const read=n=>fs.readFileSync(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8');
export async function admissionDatabase(kind='voice'){
 const db=await jobDatabase();await db.exec(`
 create table voice_flea_private.account_deletions(user_id uuid primary key);
 create function voice_flea_private.resolution_operator(actor uuid) returns boolean language sql as $$select false$$;
 create table voice_flea_private.boost_orders(id uuid primary key default gen_random_uuid(),seller_id uuid,listing_id uuid,plan text,product_id text,state text default 'pending',environment text,transaction_id text unique,created_at timestamptz default now(),applied_at timestamptz);
 create table listing_boosts(id uuid primary key default gen_random_uuid(),listing_id uuid,seller_id uuid,plan text,amount_jpy integer,duration_days integer,status text,starts_at timestamptz,ends_at timestamptz,apple_transaction_id text unique,payment_source text,environment text);
 insert into listings(id,seller_id,price_jpy,is_active,title) values('${boostListing}','${owner}',1000,true,'Own listing');
 update voice_flea_private.voice_iap_products set sandbox_enabled=true;`);
 for(const n of ['20261028020000_priced_boost_receipts.sql','20261109010000_dual_iap_preparation.sql','20261109020000_native_purchase_attempts.sql','20261109030000_native_purchase_retry_intents.sql'])await db.exec(read(n));
 if(kind==='voice')await db.query('select public.prepare_voice_iap_order($1,$2,$3,$4)',[owner,listing,order,'Sandbox']);
 else if(kind==='boost')await db.query("insert into voice_flea_private.boost_orders(id,seller_id,listing_id,plan,product_id,environment) values($1,$2,$3,'silver','com.ayuhide.koenofurima.boost.silver','Sandbox')",[order,owner,boostListing]);
 if(kind==='job'){
  await db.exec(`insert into jobs(id,buyer_id,title,budget_jpy) values('${listing}','${owner}','Job',1000);insert into applications(id,job_id,applicant_id,status,proposed_price_jpy) values('${another}','${listing}','${seller}','pending',1000);update applications set status='accepted' where id='${another}';`);
  await db.query('select public.prepare_job_voice_iap_order($1,$2,$3,$4)',[owner,another,order,'Sandbox']);
 }
 return db;
}
