import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003';
const listing='00000000-0000-4000-8000-000000000004',attempt='00000000-0000-4000-8000-000000000005';
const sku='com.ayuhide.koenofurima.voice.jpy1000';
const read=path=>fs.readFileSync(new URL('../../'+path,import.meta.url),'utf8');
export async function receiptDatabase(){
 const db=new PGlite();await db.exec(`
 create role anon;create role authenticated;create role service_role;
 create schema auth;create schema voice_flea_private;grant usage on schema auth,voice_flea_private to authenticated,service_role;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);insert into auth.users values('${buyer}'),('${seller}'),('${other}');
 create table disabled_accounts(id uuid);
 create function voice_flea_private.account_available(actor uuid) returns boolean language sql as $$select actor is not null and not exists(select 1 from public.disabled_accounts where id=actor)$$;
 create table listings(id uuid primary key,seller_id uuid,price_jpy integer,is_active boolean,title text);
 insert into listings values('${listing}','${seller}',1000,true,'Voice');
 create table user_blocks(blocker_id uuid,blocked_user_id uuid);
 create table jobs(id uuid primary key,buyer_id uuid,title text,budget_jpy integer,status text default 'open');create table applications(id uuid primary key default gen_random_uuid(),job_id uuid,applicant_id uuid,status text,proposed_price_jpy integer,delivery_days integer,created_at timestamptz default now());
 create table payments(id uuid primary key default gen_random_uuid(),listing_id uuid,buyer_id uuid,seller_id uuid,
 amount_jpy integer not null,platform_fee_jpy integer not null default 0,seller_amount_jpy integer not null default 0,
 status text,stripe_checkout_session_id text,stripe_payment_intent_id text,stripe_charge_id text,
 stripe_reconciled_at timestamptz,stripe_livemode boolean,refunded_amount_jpy integer,refunded_at timestamptz,
 paid_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
 create table conversations(id uuid primary key default gen_random_uuid(),listing_id uuid,buyer_id uuid,seller_id uuid,
 job_id uuid,is_inquiry boolean default false,delivery_status text default 'none',delivery_path text,
 delivered_at timestamptz,accepted_at timestamptz,created_at timestamptz default now());
 alter table conversations enable row level security;grant select,insert,update on conversations to authenticated;
 create policy own on conversations to authenticated using(buyer_id=auth.uid() or seller_id=auth.uid()) with check(buyer_id=auth.uid() or seller_id=auth.uid());
 alter table payments enable row level security;grant select on payments to authenticated;
 create policy own on payments for select to authenticated using(buyer_id=auth.uid() or seller_id=auth.uid());
 `);
 await db.exec(read('supabase/migrations/20261024095131_exact_purchase_conversation_and_fee_policy.sql'));
 await db.exec(read('supabase/migrations/20261024100350_freeze_refunded_trade_fulfillment.sql'));
 await db.exec(read('tests/fixtures/trade-authority.sql'));
 await db.exec(read('supabase/migrations/20261028010000_voice_iap.sql'));
 await db.exec(`alter table payments add constraint payments_status_check check(status in ('pending','paid','failed','refunded','partially_refunded','canceled'));
 create unique index payment_pi on payments(stripe_payment_intent_id);
 create table profiles(id uuid primary key,stripe_account_id text);insert into profiles values('${seller}','acct_seller');
 create table voice_flea_private.checkout_reservations(id uuid primary key default gen_random_uuid(),buyer_id uuid,seller_id uuid,attempt_id uuid,session_id text,state text default 'prepared');
 create function public.reserve_checkout_attempt(buyer uuid,seller uuid,attempt uuid) returns uuid language plpgsql as $$declare r uuid;begin insert into voice_flea_private.checkout_reservations(buyer_id,seller_id,attempt_id) values(buyer,seller,attempt) returning id into r;return r;end $$;
 create table voice_flea_private.trade_cancellations(conversation_id uuid,state text,buyer_approved boolean default false,seller_approved boolean default false);
 create table messages(conversation_id uuid,sender_id uuid,body text);`);
 await db.exec(read('supabase/migrations/20261028223344_receipt_capture.sql'));
 return db;
}
export async function jobDatabase(){const db=await receiptDatabase();await db.exec(read('supabase/migrations/20261028232049_paid_job_orders.sql'));return db;}
