import fs from 'node:fs';
import {jobDatabase} from './receipt-database.mjs';
const owner='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003';
const listing='00000000-0000-4000-8000-000000000004',order='00000000-0000-4000-8000-000000000005',fresh='00000000-0000-4000-8000-000000000006';
const boostListing='00000000-0000-4000-8000-000000000008',report='00000000-0000-4000-8000-000000000088';
const sku='com.ayuhide.koenofurima.voice.jpy1000',boostSku='com.ayuhide.koenofurima.boost.silver';
const quoteCache=new WeakMap();
const read=n=>fs.readFileSync(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8');
export async function guardedAdmissionDatabase(kind='voice',env='Sandbox',register=false,install=true){
 const db=await jobDatabase();await db.exec(`
 create table voice_flea_private.account_deletions(user_id uuid primary key,completed_at timestamptz);
 create table voice_flea_private.moderators(user_id uuid primary key);insert into voice_flea_private.moderators values('${seller}');
 create function voice_flea_private.is_moderator() returns boolean language sql as $$select auth.uid()='${seller}'::uuid$$;
 create table voice_flea_private.apple_financial_reports(id uuid primary key,snapshot jsonb);
 create table voice_flea_private.boost_orders(id uuid primary key default gen_random_uuid(),seller_id uuid,listing_id uuid,plan text,product_id text,state text default 'pending',environment text,transaction_id text unique,created_at timestamptz default now(),applied_at timestamptz);
 create table listing_boosts(id uuid primary key default gen_random_uuid(),listing_id uuid,seller_id uuid,plan text,amount_jpy integer,duration_days integer,status text,starts_at timestamptz,ends_at timestamptz,apple_transaction_id text unique,payment_source text,environment text);
 insert into listings(id,seller_id,price_jpy,is_active,title) values('${boostListing}','${owner}',1000,true,'Own listing');
 update voice_flea_private.voice_iap_products set sandbox_enabled=true,production_enabled=true;`);
 for(const n of ['20261028020000_priced_boost_receipts.sql','20261029033154_apple_proceeds_allocation_ledger.sql','20261102003116_keep_allocated_apple_proceeds_pending.sql','20261102020226_guard_apple_refund_settlement_on_deletion.sql','20261102040116_apple_settlement_dispatch_journal.sql','20261102055040_apple_refund_recovery_journal.sql','20261102140552_apple_refund_review_holds.sql','20261102142155_apple_financial_resolution_audit.sql','20261109010000_dual_iap_preparation.sql','20261109020000_native_purchase_attempts.sql','20261109030000_native_purchase_retry_intents.sql','20261109040000_native_refund_observations.sql','20261109050000_native_submitted_receipt_evidence.sql','20261109060000_legacy_refund_observations.sql'])if(install||n!=='20261109060000_legacy_refund_observations.sql')await db.exec(read(n));

 return db;
}
