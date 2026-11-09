import fs from 'node:fs';import {receiptDatabase} from './receipt-database.mjs';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8');
export const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',listing='00000000-0000-4000-8000-000000000004';
export async function refundDatabase({monotonic=true}={}){
 const db=await receiptDatabase();
 await db.exec(`alter table public.payments add column stripe_dispute_review_required boolean not null default false;
 alter table voice_flea_private.trade_cancellations add column id uuid primary key default gen_random_uuid(),add column payment_id uuid unique references payments(id),add column created_at timestamptz not null default now();
 create table voice_flea_private.refund_auto_jobs(id uuid primary key default gen_random_uuid(),cancellation_id uuid not null unique references voice_flea_private.trade_cancellations(id),payment_id uuid not null unique references payments(id),state text not null default 'queued' check(state in ('queued','processing','waiting','succeeded','needs_review')),attempts integer not null default 0,first_attempt_at timestamptz,next_attempt_at timestamptz not null default now(),lease_id uuid,lease_until timestamptz,provider_refund_id text,provider_status text,error_code text,created_at timestamptz not null default now(),completed_at timestamptz);
 create schema vault;create table vault.decrypted_secrets(id uuid,decrypted_secret text);insert into vault.decrypted_secrets values('00000000-0000-4000-8000-000000000090','unit-worker-only');
 create table voice_flea_private.refund_auto_config(singleton boolean primary key default true check(singleton),enabled boolean not null default false,worker_secret_id uuid not null,wake_after timestamptz not null default '-infinity');
 insert into voice_flea_private.refund_auto_config values(true,true,'00000000-0000-4000-8000-000000000090','-infinity');
 create table voice_flea_private.app_mail_outbox(dedupe_key text primary key,recipient_id uuid,kind text,subject text,body text);
 create function voice_flea_private.dispatch_app_mail() returns void language plpgsql as $$begin end$$;`);
 // Exact observed function source (fixture config uses only a synthetic worker credential).
 await db.exec(read('tests/fixtures/refund-baseline/refund-auto-claim.sql'));
 const resultSource=read('tests/fixtures/refund-baseline/refund-auto-result.sql');const privateStart=resultSource.indexOf('CREATE OR REPLACE FUNCTION voice_flea_private.');await db.exec(resultSource.slice(privateStart));await db.exec(resultSource.slice(0,privateStart));
 let snapshot=read('supabase/migrations/20261024080918_payment_reconciliation.sql');snapshot=snapshot.slice(snapshot.indexOf('create function public.record_stripe_payment_snapshot'),snapshot.indexOf('create function voice_flea_private.admin_payment_receipts'));
 await db.exec(snapshot);
 await db.exec(`create function public.prepare_account_deletion(target uuid) returns jsonb language sql as $$select '{"allowed":true}'::jsonb$$;create function public.finish_account_deletion(target uuid) returns void language plpgsql as $$begin end$$;`);
 await db.exec(read('supabase/migrations/20261109053637_stripe_refund_dispatch_journal.sql'));
 if(monotonic){await db.exec(read('supabase/migrations/20261109060227_preserve_verified_stripe_refund_facts.sql'));await db.exec(read('supabase/migrations/20261109064000_stripe_refund_event_conflicts.sql'));}
 await db.exec('grant execute on function public.refund_auto_claim(text),public.refund_auto_result(uuid,uuid,text,text,text,boolean) to service_role');
 await db.exec("update voice_flea_private.stripe_refund_dispatch_config set enabled=true,platform_id='acct_platform',cutover_at=now()-interval '1 hour'");
 const p=(await db.query(`insert into payments(listing_id,buyer_id,seller_id,amount_jpy,platform_fee_jpy,seller_amount_jpy,status,payment_channel,stripe_payment_intent_id,stripe_charge_id,stripe_livemode,stripe_reconciled_at,refunded_amount_jpy,stripe_destination) values($1,$2,$3,1000,150,850,'paid','web','pi_refund','ch_refund',true,now(),0,'acct_seller') returning *`,[listing,buyer,seller])).rows[0];
 const c=(await db.query("insert into conversations(listing_id,buyer_id,seller_id,payment_id) values($1,$2,$3,$4) returning id",[listing,buyer,seller,p.id])).rows[0].id;
 const cancel=(await db.query("insert into voice_flea_private.trade_cancellations(conversation_id,payment_id,buyer_approved,seller_approved,state) values($1,$2,true,true,'queued') returning id",[c,p.id])).rows[0].id;
 const job=(await db.query('insert into voice_flea_private.refund_auto_jobs(cancellation_id,payment_id) values($1,$2) returning id',[cancel,p.id])).rows[0].id;
 return {db,p,c,job};
}
export const prepareArgs=p=>({payment_id:p.id,origin:'manual',actor:buyer,job_id:null,lease:null,platform_id:'acct_platform',live:true});
export function dbAdapter(db){return {rpc:async(name,args)=>{
 try{const keys=Object.keys(args);const r=await db.query(`select public.${name}(${keys.map((k,i)=>k+' => $'+(i+1)).join(',')}) r`,Object.values(args));return {data:r.rows[0].r,error:null};}catch(error){return {data:null,error};}
}};}
