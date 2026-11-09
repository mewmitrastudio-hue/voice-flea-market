-- Copy only these known, installed function bodies. Original OIDs are retained
-- below with CREATE OR REPLACE so precompiled callers cannot bypass the gates.
-- No caller-supplied SQL, credentials, or runtime data enters this migration.
do $copy_legacy_bodies$
declare f record;definition text;new_header text;
begin
 for f in select * from (values
  ('voice_flea_private','apply_legacy_apple_voice','apply_legacy_apple_voice_before_refund_review','uuid,text,text,text,timestamptz,bigint,text,boolean,uuid'),
  ('voice_flea_private','apply_legacy_apple_boost','apply_legacy_apple_boost_before_refund_review','uuid,text,text,text,timestamptz,boolean'),
  ('public','record_native_refund_observation','record_native_refund_observation_before_legacy_review','uuid,text,text,text,timestamptz,bigint,text,jsonb,text,uuid'),
  ('public','native_retry_admission','native_retry_admission_before_legacy_refund','uuid,text,uuid,uuid,uuid'),
  ('public','prepare_voice_iap_order','prepare_voice_iap_order_before_legacy_refund','uuid,uuid,uuid,text'),
  ('public','prepare_job_voice_iap_order','prepare_job_voice_iap_order_before_legacy_refund','uuid,uuid,uuid,text'),
  ('public','prepare_boost_order_in_environment','prepare_boost_order_in_environment_before_legacy_refund','uuid,uuid,text,text'),
  ('public','native_purchase_attempt','native_purchase_attempt_before_legacy_refund','uuid,text,uuid,text,text,integer,text,uuid,text')
 ) as functions(source_schema,source_name,helper_name,arg_types) loop
  definition=pg_get_functiondef((f.source_schema||'.'||f.source_name||'('||f.arg_types||')')::regprocedure);
  new_header='CREATE FUNCTION voice_flea_private.'||f.helper_name||'(';
  definition=replace(definition,'CREATE OR REPLACE FUNCTION '||f.source_schema||'.'||f.source_name||'(',new_header);
  if position(new_header in definition)<>1 then raise exception 'Unexpected source function definition';end if;
  definition=replace(definition,f.source_name||'.',f.helper_name||'.');
  execute definition;
  execute 'revoke all on function voice_flea_private.'||f.helper_name||'('||f.arg_types||') from public,anon,authenticated,service_role';
 end loop;
end $copy_legacy_bodies$;

-- Durable review for legacy receipts, without adopting a v3 intent or treating
-- inconsistent signed refund evidence as permission to grant/refund/pay funds.
-- Service callers must independently verify both signatures/current identity.
create table voice_flea_private.legacy_apple_refund_reviews (
 environment text not null check(environment in ('Sandbox','Production')),
 transaction_id text not null check(transaction_id ~ '^[0-9]{1,40}$'), order_id uuid not null,
 order_kind text not null check(order_kind in ('voice_listing','voice_job','boost')),
 owner_id uuid not null references auth.users(id), subject_id uuid not null,
 product_id text not null, amount_jpy integer not null check(amount_jpy>0), purchased_at timestamptz not null,
 classification text not null check(classification in ('winner_review','unfulfilled_review','excess_payment_review')),
 payment_id uuid references public.payments(id), revoked boolean not null default false,
 first_observed_at timestamptz not null default clock_timestamp(),last_observed_at timestamptz not null default clock_timestamp(),
 primary key(environment,transaction_id)
);
create table voice_flea_private.legacy_apple_refund_evidence (
 id bigint generated always as identity primary key,environment text not null,transaction_id text not null,
 evidence jsonb check(evidence is null or jsonb_typeof(evidence)='object' and octet_length(evidence::text)<=30000),
 signed_transaction text not null check(length(signed_transaction) between 1 and 30000),
 observed_at timestamptz not null default clock_timestamp(),
 foreign key(environment,transaction_id) references voice_flea_private.legacy_apple_refund_reviews(environment,transaction_id)
);
alter table voice_flea_private.legacy_apple_refund_reviews enable row level security;
alter table voice_flea_private.legacy_apple_refund_evidence enable row level security;
revoke all on voice_flea_private.legacy_apple_refund_reviews,voice_flea_private.legacy_apple_refund_evidence from public,anon,authenticated,service_role;

create function voice_flea_private.legacy_apple_order_binding(requested_order uuid)
returns table(order_kind text,owner_id uuid,subject_id uuid,product_id text,environment text,amount_jpy integer,created_at timestamptz,transaction_id text,payment_id uuid)
language sql stable security invoker set search_path='' as $$
 select case when o.job_id is null then 'voice_listing' else 'voice_job' end,o.buyer_id,coalesce(o.job_id,o.listing_id),o.product_id,o.environment,o.amount_jpy,o.created_at,o.transaction_id,o.payment_id
 from voice_flea_private.voice_iap_orders o where o.id=requested_order
 union all
 select 'boost',b.seller_id,b.listing_id,b.product_id,b.environment,case b.plan when 'silver' then 300 when 'gold' then 800 when 'platinum' then 1500 end,b.created_at,b.transaction_id,null::uuid
 from voice_flea_private.boost_orders b where b.id=requested_order and not exists(select 1 from voice_flea_private.voice_iap_orders o where o.id=requested_order)
$$;
revoke all on function voice_flea_private.legacy_apple_order_binding(uuid) from public,anon,authenticated,service_role;

-- Owner locks precede the shared transaction-identity lock. Every public sink
-- and every old low-level grant obtains this lock, so the two receipt ledgers
-- cannot concurrently claim the same Apple identity for different orders.
create function voice_flea_private.lock_apple_refund_identity(requested_order uuid,tx text,env text,actor uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare o record;
begin
 select * into o from voice_flea_private.legacy_apple_order_binding(requested_order);
 if not found or (actor is not null and actor<>o.owner_id) then raise exception 'Order owner mismatch'; end if;
 if tx is null or tx!~'^[0-9]{1,40}$' or env is null or env not in ('Sandbox','Production') then raise exception 'Transaction identity mismatch'; end if;
 perform pg_advisory_xact_lock(hashtextextended(o.owner_id::text,16));
 perform pg_advisory_xact_lock(hashtextextended(o.owner_id::text,913));
 perform pg_advisory_xact_lock(hashtextextended(env||':'||tx,914));
 if exists(select 1 from voice_flea_private.native_verified_receipts r where r.environment=env and r.transaction_id=tx and (r.order_id<>requested_order or r.owner_id<>o.owner_id))
  or exists(select 1 from voice_flea_private.legacy_apple_refund_reviews r where r.environment=env and r.transaction_id=tx and (r.order_id<>requested_order or r.owner_id<>o.owner_id))
  or exists(select 1 from voice_flea_private.voice_iap_orders x where x.environment=env and x.transaction_id=tx and x.id<>requested_order)
  or exists(select 1 from voice_flea_private.boost_orders x where x.environment=env and x.transaction_id=tx and x.id<>requested_order) then raise exception 'Transaction already assigned'; end if;
end $$;
revoke all on function voice_flea_private.lock_apple_refund_identity(uuid,text,text,uuid) from public,anon,authenticated,service_role;

create function voice_flea_private.legacy_refund_purpose_pending(requested_order uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from voice_flea_private.legacy_apple_order_binding(requested_order) o
  join voice_flea_private.legacy_apple_refund_reviews r on r.owner_id=o.owner_id and r.order_kind=o.order_kind and r.subject_id=o.subject_id)
$$;
revoke all on function voice_flea_private.legacy_refund_purpose_pending(uuid) from public,anon,authenticated,service_role;
create function voice_flea_private.guard_legacy_refund_adoption(requested_order uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if voice_flea_private.legacy_refund_purpose_pending(requested_order)
  and not exists(select 1 from voice_flea_private.native_retry_attempts a where a.order_id=requested_order)
  and exists(select 1 from voice_flea_private.legacy_apple_order_binding(requested_order) o join voice_flea_private.native_fulfillment_intents i
   on i.owner_id=o.owner_id and i.kind=o.order_kind and i.subject_id=o.subject_id) then
  raise exception 'Legacy refund purpose requires review before native adoption';
 end if;
end $$;
revoke all on function voice_flea_private.guard_legacy_refund_adoption(uuid) from public,anon,authenticated,service_role;

create function voice_flea_private.legacy_refund_result(r voice_flea_private.legacy_apple_refund_reviews)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('handled',true,'observationProtocol','legacy','orderId',r.order_id,'transactionId',r.transaction_id,
  'environment',r.environment,'legacyClassification',r.classification,'reviewRequired',true,'financiallyRecorded',true,
  'fulfillmentGranted',false,'revoked',r.revoked)
  ||case when r.payment_id is not null then jsonb_build_object('paymentId',r.payment_id) else '{}'::jsonb end
$$;
revoke all on function voice_flea_private.legacy_refund_result(voice_flea_private.legacy_apple_refund_reviews) from public,anon,authenticated,service_role;

create function voice_flea_private.record_legacy_refund_observation(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,price_milliunits bigint,currency text,evidence jsonb,signed_transaction text,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare o record;r voice_flea_private.legacy_apple_refund_reviews;p public.payments;h voice_flea_private.apple_refund_review_holds;
 kind text;pay uuid;fully_revoked boolean:=false;
begin
 perform voice_flea_private.lock_apple_refund_identity(order_id,tx_id,tx_environment,actor);
 if exists(select 1 from voice_flea_private.native_retry_attempts a where a.order_id=record_legacy_refund_observation.order_id)
  or exists(select 1 from voice_flea_private.native_verified_receipts n where n.environment=tx_environment and n.transaction_id=tx_id) then raise exception 'Native receipt requires its own review gate'; end if;
 select * into o from voice_flea_private.legacy_apple_order_binding(order_id);
 if o.order_kind='boost' then perform 1 from voice_flea_private.boost_orders where id=order_id for update;
 else perform 1 from voice_flea_private.voice_iap_orders where id=order_id for update;end if;
 select * into o from voice_flea_private.legacy_apple_order_binding(order_id);
 if sku is distinct from o.product_id or (o.environment is not null and tx_environment<>o.environment)
  or currency is distinct from 'JPY' or price_milliunits is distinct from o.amount_jpy::bigint*1000
  or purchased_at is null or purchased_at<o.created_at-interval '10 minutes' or purchased_at>now()+interval '5 minutes'
  or signed_transaction is null or length(signed_transaction) not between 1 and 30000 then raise exception 'Legacy refund receipt mismatch'; end if;
 if evidence is null or jsonb_typeof(evidence)<>'object' or octet_length(evidence::text)>30000
  or not (coalesce(evidence->'revocationDate','null'::jsonb)<>'null'::jsonb or coalesce(evidence->'revocationType','null'::jsonb)<>'null'::jsonb or coalesce(evidence->'revocationPercentage','null'::jsonb)<>'null'::jsonb) then raise exception 'Refund observation required'; end if;
 if coalesce(evidence->'revocationDate','null'::jsonb)<>'null'::jsonb then
  if jsonb_typeof(evidence->'revocationDate')<>'number' then raise exception 'Invalid refund date'; end if;
  if (evidence->>'revocationDate')::numeric<=0 or (evidence->>'revocationDate')::numeric>9007199254740991 then raise exception 'Invalid refund date'; end if;
 end if;
 kind=case when o.transaction_id=tx_id then 'winner_review' when o.transaction_id is not null then 'excess_payment_review' else 'unfulfilled_review' end;
 if kind='winner_review' and o.order_kind<>'boost' then
  select * into p from public.payments where id=o.payment_id for update;
  if p.id is null or p.buyer_id is distinct from o.owner_id or p.payment_channel is distinct from 'ios'
   or p.apple_transaction_id is distinct from tx_id or p.apple_environment is distinct from tx_environment
   or p.amount_jpy is distinct from o.amount_jpy then raise exception 'Winner payment mismatch'; end if;
  pay=p.id;fully_revoked=p.status='refunded' and p.refunded_amount_jpy=p.amount_jpy;
  select * into h from voice_flea_private.apple_refund_review_holds x where x.order_id=record_legacy_refund_observation.order_id;
  if found and (h.transaction_id<>tx_id or h.environment<>tx_environment) then raise exception 'Refund review identity mismatch'; end if;
  -- Only the exact existing winner is bridged into the historical order-bound
  -- hold. First/unfulfilled and duplicate observations NEVER use that table.
  insert into voice_flea_private.apple_refund_review_holds(order_id,transaction_id,environment,evidence)
   values(order_id,tx_id,tx_environment,evidence)
   on conflict on constraint apple_refund_review_holds_pkey do update set last_observed_at=clock_timestamp();
 elsif kind='winner_review' and o.order_kind='boost' then
  select state='revoked' into fully_revoked from voice_flea_private.boost_orders where id=order_id;
  if exists(select 1 from public.listing_boosts b where b.apple_transaction_id=tx_id and b.environment=tx_environment and (b.seller_id is distinct from o.owner_id or b.listing_id is distinct from o.subject_id)) then raise exception 'Winner Boost mismatch';end if;
  if not exists(select 1 from public.listing_boosts b where b.apple_transaction_id=tx_id and b.environment=tx_environment) then kind='unfulfilled_review';end if;
 end if;
 select * into r from voice_flea_private.legacy_apple_refund_reviews x where x.environment=tx_environment and x.transaction_id=tx_id for update;
 if found then
  if r.order_id<>order_id or r.owner_id<>o.owner_id or r.product_id<>sku or r.amount_jpy<>o.amount_jpy or r.purchased_at<>purchased_at then raise exception 'Legacy transaction already assigned'; end if;
  if r.classification='winner_review' and kind<>'winner_review' then raise exception 'Legacy winner identity changed';end if;
  update voice_flea_private.legacy_apple_refund_reviews x set classification=kind,payment_id=coalesce(r.payment_id,pay),
   revoked=r.revoked or coalesce(fully_revoked,false),last_observed_at=clock_timestamp() where x.environment=tx_environment and x.transaction_id=tx_id returning * into r;
 else
  insert into voice_flea_private.legacy_apple_refund_reviews(environment,transaction_id,order_id,order_kind,owner_id,subject_id,product_id,amount_jpy,purchased_at,classification,payment_id,revoked)
   values(tx_environment,tx_id,order_id,o.order_kind,o.owner_id,o.subject_id,sku,o.amount_jpy,purchased_at,kind,pay,coalesce(fully_revoked,false)) returning * into r;
 end if;
 insert into voice_flea_private.legacy_apple_refund_evidence(environment,transaction_id,evidence,signed_transaction)
  select tx_environment,tx_id,evidence,signed_transaction where not exists(select 1 from voice_flea_private.legacy_apple_refund_evidence e
   where e.environment=tx_environment and e.transaction_id=tx_id and e.evidence=record_legacy_refund_observation.evidence and e.signed_transaction=record_legacy_refund_observation.signed_transaction);
 return voice_flea_private.legacy_refund_result(r);
end $$;
revoke all on function voice_flea_private.record_legacy_refund_observation(uuid,text,text,text,timestamptz,bigint,text,jsonb,text,uuid) from public,anon,authenticated,service_role;

create or replace function public.record_native_refund_observation(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,price_milliunits bigint,currency text,evidence jsonb,signed_transaction text,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;
begin
 perform voice_flea_private.lock_apple_refund_identity(order_id,tx_id,tx_environment,actor);
 if exists(select 1 from voice_flea_private.legacy_apple_refund_reviews x where x.environment=tx_environment and x.transaction_id=tx_id) then
  return voice_flea_private.record_legacy_refund_observation(order_id,tx_id,sku,tx_environment,purchased_at,price_milliunits,currency,evidence,signed_transaction,actor);
 end if;
 perform voice_flea_private.guard_legacy_refund_adoption(order_id);
 r=voice_flea_private.record_native_refund_observation_before_legacy_review(order_id,tx_id,sku,tx_environment,purchased_at,price_milliunits,currency,evidence,signed_transaction,actor);
 if r->'handled'='true'::jsonb then return r; end if;
 return voice_flea_private.record_legacy_refund_observation(order_id,tx_id,sku,tx_environment,purchased_at,price_milliunits,currency,evidence,signed_transaction,actor);
end $$;
revoke all on function public.record_native_refund_observation(uuid,text,text,text,timestamptz,bigint,text,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.record_native_refund_observation(uuid,text,text,text,timestamptz,bigint,text,jsonb,text,uuid) to service_role;

-- Gate the lowest common grant implementations, retaining their original OIDs.
-- Stage1 directly invokes the private voice implementation for legacy.
revoke all on function voice_flea_private.apply_legacy_apple_voice_before_refund_review(uuid,text,text,text,timestamptz,bigint,text,boolean,uuid),voice_flea_private.apply_legacy_apple_boost_before_refund_review(uuid,text,text,text,timestamptz,boolean) from public,anon,authenticated,service_role;

create function voice_flea_private.check_legacy_refund_replay(order_id uuid,tx_id text,sku text,tx_environment text,purchased_at timestamptz,revoked boolean,
 price_milliunits bigint default null,currency text default null,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare r voice_flea_private.legacy_apple_refund_reviews;o record;
begin
 perform voice_flea_private.lock_apple_refund_identity(order_id,tx_id,tx_environment,actor);
 select * into r from voice_flea_private.legacy_apple_refund_reviews x where x.environment=tx_environment and x.transaction_id=tx_id for update;
 if not found then return null;end if;
 select * into o from voice_flea_private.legacy_apple_order_binding(order_id);
 if r.order_id<>order_id or r.product_id is distinct from sku or r.purchased_at is distinct from purchased_at or revoked is null
  or (r.order_kind<>'boost' and (price_milliunits is distinct from r.amount_jpy::bigint*1000 or currency is distinct from 'JPY')) then raise exception 'Legacy held receipt mismatch';end if;
 if not revoked then raise exception 'APPLE_REFUND_REVIEW_HELD' using errcode='55000';end if;
 -- Full verified revocation advances only this receipt. An unfulfilled/excess
 -- receipt must not create a new refunded payment, consume an order or affect
 -- another transaction's Boost. No hold is cleared by this observation.
 update voice_flea_private.legacy_apple_refund_reviews x set revoked=true,
  classification=case when o.transaction_id is not null and o.transaction_id<>tx_id then 'excess_payment_review' else r.classification end,
  last_observed_at=clock_timestamp() where x.environment=tx_environment and x.transaction_id=tx_id returning * into r;
 return voice_flea_private.legacy_refund_result(r);
end $$;
revoke all on function voice_flea_private.check_legacy_refund_replay(uuid,text,text,text,timestamptz,boolean,bigint,text,uuid) from public,anon,authenticated,service_role;
create or replace function voice_flea_private.apply_legacy_apple_voice(order_id uuid,tx_id text,sku text,tx_environment text,purchased_at timestamptz,price_milliunits bigint,currency text,revoked boolean,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare held jsonb;result jsonb;
begin
 held=voice_flea_private.check_legacy_refund_replay(order_id,tx_id,sku,tx_environment,purchased_at,revoked,price_milliunits,currency,actor);
 if held is not null and held->>'legacyClassification'<>'winner_review' then return held;end if;
 result=voice_flea_private.apply_legacy_apple_voice_before_refund_review(order_id,tx_id,sku,tx_environment,purchased_at,price_milliunits,currency,revoked,actor);
 return result||coalesce(held,'{}'::jsonb);
end $$;
create or replace function voice_flea_private.apply_legacy_apple_boost(order_id uuid,tx_id text,sku text,tx_environment text,purchased_at timestamptz,revoked boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare held jsonb;result jsonb;
begin
 held=voice_flea_private.check_legacy_refund_replay(order_id,tx_id,sku,tx_environment,purchased_at,revoked);
 if held is not null and held->>'legacyClassification'<>'winner_review' then return held;end if;
 result=voice_flea_private.apply_legacy_apple_boost_before_refund_review(order_id,tx_id,sku,tx_environment,purchased_at,revoked);
 return result||coalesce(held,'{}'::jsonb);
end $$;
revoke all on function voice_flea_private.apply_legacy_apple_voice(uuid,text,text,text,timestamptz,bigint,text,boolean,uuid),voice_flea_private.apply_legacy_apple_boost(uuid,text,text,text,timestamptz,boolean) from public,anon,authenticated,service_role;

-- Unchanged v3 gate, preserved behind the legacy preflight.
create function voice_flea_private.apply_native_verified_receipt_before_legacy_review(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,price_milliunits bigint,currency text,revoked boolean,signed_transaction text,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare a voice_flea_private.native_retry_attempts; r voice_flea_private.native_verified_receipts; result jsonb; actual_owner uuid;
begin
 select owner_id into actual_owner from voice_flea_private.native_retry_attempts x where x.order_id=apply_native_verified_receipt_before_legacy_review.order_id;
 if actual_owner is null then
  select buyer_id into actual_owner from voice_flea_private.voice_iap_orders where id=order_id;
  if actual_owner is null then select seller_id into actual_owner from voice_flea_private.boost_orders where id=order_id; end if;
 end if;
 if actual_owner is not null then
  perform pg_advisory_xact_lock(hashtextextended(actual_owner::text,16));
  perform pg_advisory_xact_lock(hashtextextended(actual_owner::text,913));
 end if;
 -- Re-read after owner serialization so an observation committed while waiting
 -- cannot be missed. No stale-positive receipt may reach the grant function.
 select * into r from voice_flea_private.native_verified_receipts x where x.environment=tx_environment and x.transaction_id=tx_id;
 if r.transaction_id is null or not exists(select 1 from voice_flea_private.native_refund_review_holds h where h.environment=tx_environment and h.transaction_id=tx_id) then
  return voice_flea_private.apply_native_verified_receipt(order_id,tx_id,sku,tx_environment,purchased_at,price_milliunits,currency,revoked,signed_transaction,actor);
 end if;
 select * into a from voice_flea_private.native_retry_attempts x where x.order_id=apply_native_verified_receipt_before_legacy_review.order_id;
 if a.order_id is null or (actor is not null and actor<>a.owner_id) then raise exception 'Owner mismatch'; end if;
 perform 1 from voice_flea_private.native_fulfillment_intents where id=a.intent_id for update;
 select * into r from voice_flea_private.native_verified_receipts x where x.environment=tx_environment and x.transaction_id=tx_id for update;
 if r.order_id<>a.order_id or r.intent_id<>a.intent_id or r.owner_id<>a.owner_id or r.product_id is distinct from sku
  or tx_environment is distinct from a.environment or currency is distinct from 'JPY'
  or price_milliunits is distinct from a.amount_jpy::bigint*1000 or r.purchased_at is distinct from purchased_at
  or revoked is null or signed_transaction is null or length(signed_transaction) not between 1 and 30000 then raise exception 'Verified receipt mismatch'; end if;
 if revoked then
  -- Only the verified full-revocation entrypoint may advance revocation. The
  -- durable hold survives: a customer refund is not settled seller liability.
  result=voice_flea_private.apply_native_verified_receipt(order_id,tx_id,sku,tx_environment,purchased_at,price_milliunits,currency,true,signed_transaction,actor);
  if r.classification='refund_review_unfulfilled' then
   update voice_flea_private.native_verified_receipts x set classification='refunded_unfulfilled' where x.environment=tx_environment and x.transaction_id=tx_id;
  end if;
 else
  insert into voice_flea_private.native_verified_receipt_evidence(environment,transaction_id,signed_transaction)
   select tx_environment,tx_id,signed_transaction where not exists(select 1 from voice_flea_private.native_verified_receipt_evidence x
    where x.environment=tx_environment and x.transaction_id=tx_id and x.signed_transaction=apply_native_verified_receipt_before_legacy_review.signed_transaction);
  result=r.result;
 end if;
 select * into r from voice_flea_private.native_verified_receipts x where x.environment=tx_environment and x.transaction_id=tx_id;
 result=coalesce(result,'{}'::jsonb)||jsonb_build_object('intentId',a.intent_id,'orderId',a.order_id,'transactionId',tx_id,
  'environment',tx_environment,'receiptClassification',r.classification,'financiallyRecorded',true,
  'fulfillmentGranted',false,'reviewRequired',true,'revoked',r.revoked);
 update voice_flea_private.native_verified_receipts x set result=result,updated_at=clock_timestamp() where x.environment=tx_environment and x.transaction_id=tx_id;
 return result;
end $$;
revoke all on function voice_flea_private.apply_native_verified_receipt_before_legacy_review(uuid,text,text,text,timestamptz,bigint,text,boolean,text,uuid) from public,anon,authenticated,service_role;

create or replace function public.apply_native_verified_receipt(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,price_milliunits bigint,currency text,revoked boolean,signed_transaction text,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare r voice_flea_private.legacy_apple_refund_reviews;result jsonb;
begin
 perform voice_flea_private.lock_apple_refund_identity(order_id,tx_id,tx_environment,actor);
 select * into r from voice_flea_private.legacy_apple_refund_reviews x where x.environment=tx_environment and x.transaction_id=tx_id for update;
 if not found then
  perform voice_flea_private.guard_legacy_refund_adoption(order_id);
  return voice_flea_private.apply_native_verified_receipt_before_legacy_review(order_id,tx_id,sku,tx_environment,purchased_at,price_milliunits,currency,revoked,signed_transaction,actor);
 end if;
 if exists(select 1 from voice_flea_private.native_retry_attempts a where a.order_id=apply_native_verified_receipt.order_id) then raise exception 'Legacy refund receipt cannot be adopted into native intent';end if;
 if r.order_id<>order_id or r.product_id is distinct from sku or r.purchased_at is distinct from purchased_at
  or price_milliunits is distinct from r.amount_jpy::bigint*1000 or currency is distinct from 'JPY' or revoked is null
  or signed_transaction is null or length(signed_transaction) not between 1 and 30000 then raise exception 'Legacy held receipt mismatch';end if;
 if revoked then
  if r.order_kind='boost' then result=voice_flea_private.apply_legacy_apple_boost(order_id,tx_id,sku,tx_environment,purchased_at,true);
  else result=voice_flea_private.apply_legacy_apple_voice(order_id,tx_id,sku,tx_environment,purchased_at,price_milliunits,currency,true,actor);end if;
 end if;
 insert into voice_flea_private.legacy_apple_refund_evidence(environment,transaction_id,signed_transaction)
  select tx_environment,tx_id,signed_transaction where not exists(select 1 from voice_flea_private.legacy_apple_refund_evidence e
   where e.environment=tx_environment and e.transaction_id=tx_id and e.signed_transaction=apply_native_verified_receipt.signed_transaction);
 select * into r from voice_flea_private.legacy_apple_refund_reviews x where x.environment=tx_environment and x.transaction_id=tx_id;
 return coalesce(result,'{}'::jsonb)||voice_flea_private.legacy_refund_result(r);
end $$;
revoke all on function public.apply_native_verified_receipt(uuid,text,text,text,timestamptz,bigint,text,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.apply_native_verified_receipt(uuid,text,text,text,timestamptz,bigint,text,boolean,text,uuid) to service_role;

create or replace function public.retain_native_verified_evidence(actor uuid,order_id uuid,tx_id text,tx_environment text,signed_transaction text)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare n voice_flea_private.native_verified_receipts;r voice_flea_private.legacy_apple_refund_reviews;
begin
 perform voice_flea_private.lock_apple_refund_identity(order_id,tx_id,tx_environment,actor);
 if signed_transaction is null or length(signed_transaction) not between 1 and 30000 then raise exception 'Receipt evidence binding mismatch';end if;
 select * into n from voice_flea_private.native_verified_receipts x where x.environment=tx_environment and x.transaction_id=tx_id for update;
 if found then
  if n.order_id is distinct from order_id or (actor is not null and n.owner_id<>actor) then raise exception 'Receipt evidence binding mismatch'; end if;
  insert into voice_flea_private.native_verified_receipt_evidence(environment,transaction_id,signed_transaction)
   select tx_environment,tx_id,signed_transaction where not exists(select 1 from voice_flea_private.native_verified_receipt_evidence e
    where e.environment=tx_environment and e.transaction_id=tx_id and e.signed_transaction=retain_native_verified_evidence.signed_transaction);
 else
  select * into r from voice_flea_private.legacy_apple_refund_reviews x where x.environment=tx_environment and x.transaction_id=tx_id for update;
  if not found or r.order_id is distinct from order_id or (actor is not null and r.owner_id<>actor) then raise exception 'Receipt evidence binding mismatch';end if;
  insert into voice_flea_private.legacy_apple_refund_evidence(environment,transaction_id,signed_transaction)
   select tx_environment,tx_id,signed_transaction where not exists(select 1 from voice_flea_private.legacy_apple_refund_evidence e
    where e.environment=tx_environment and e.transaction_id=tx_id and e.signed_transaction=retain_native_verified_evidence.signed_transaction);
 end if;
 return jsonb_build_object('retained',true);
end $$;

create or replace function public.native_retry_admission(actor uuid,operation text,requested_order uuid,requested_nonce uuid default null,fresh_order uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if actor is null then raise exception 'Owner required';end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text,16));perform pg_advisory_xact_lock(hashtextextended(actor::text,913));
 if (operation in ('begin','retry') or operation='register' and not exists(select 1 from voice_flea_private.native_retry_attempts a where a.order_id=requested_order))
  and voice_flea_private.legacy_refund_purpose_pending(requested_order) then raise exception 'Legacy refund purpose requires review before native registration or launch';end if;
 return voice_flea_private.native_retry_admission_before_legacy_refund(actor,operation,requested_order,requested_nonce,fresh_order);
end $$;
revoke all on function public.native_retry_admission(uuid,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.native_retry_admission(uuid,text,uuid,uuid,uuid) to service_role;

create function voice_flea_private.legacy_refund_pending_for_user(target uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from voice_flea_private.legacy_apple_refund_reviews r left join voice_flea_private.voice_iap_orders o on o.id=r.order_id where r.owner_id=target or o.seller_id=target)
$$;
revoke all on function voice_flea_private.legacy_refund_pending_for_user(uuid) from public,anon,authenticated,service_role;
create or replace function voice_flea_private.apple_settlement_pending_for_user(target uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select voice_flea_private.apple_settlement_pending_before_native_refund(target) or voice_flea_private.native_refund_pending_for_user(target) or voice_flea_private.legacy_refund_pending_for_user(target)
$$;
create or replace function voice_flea_private.guard_native_retry_deletion()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,16));
 if exists(select 1 from voice_flea_private.native_retry_attempts a where a.owner_id=new.user_id and a.admission_state<>'transaction_observed')
  or exists(select 1 from voice_flea_private.native_verified_receipts r where r.owner_id=new.user_id and r.classification='excess_payment_review' and not r.revoked)
  or voice_flea_private.native_refund_pending_for_user(new.user_id) or voice_flea_private.legacy_refund_pending_for_user(new.user_id) then
  raise exception 'Unresolved Apple attempt or excess payment or refund review; reconcile before account deletion';
 end if;
 return new;
end $$;
create or replace function voice_flea_private.apple_refund_review_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare n bigint;
begin
 if auth.uid() is null or not voice_flea_private.account_available(auth.uid()) then raise exception 'Sign in required' using errcode='42501';end if;
 select count(*) into n from (
  select h.environment,h.transaction_id from voice_flea_private.apple_refund_review_holds h join voice_flea_private.voice_iap_orders o on o.id=h.order_id where auth.uid() in (o.buyer_id,o.seller_id)
  union
  select h.environment,h.transaction_id from voice_flea_private.native_refund_review_holds h join voice_flea_private.native_verified_receipts r using(environment,transaction_id)
   left join voice_flea_private.voice_iap_orders o on o.id=r.order_id where r.owner_id=auth.uid() or o.seller_id=auth.uid()
  union
  select r.environment,r.transaction_id from voice_flea_private.legacy_apple_refund_reviews r left join voice_flea_private.voice_iap_orders o on o.id=r.order_id where r.owner_id=auth.uid() or o.seller_id=auth.uid()
 ) q;
 return jsonb_build_object('reviewRequired',n>0,'count',n);
end $$;
create function public.legacy_refund_receipt_history(actor uuid,operator_view boolean default false,after_environment text default null,after_transaction text default null,page_size integer default 25)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;
begin
 if actor is null or page_size is null or page_size not between 1 and 100 then raise exception 'Invalid reader';end if;
 if (after_environment is null)<>(after_transaction is null) then raise exception 'Complete cursor required';end if;
 if after_environment is not null and (after_environment not in ('Sandbox','Production') or after_transaction!~'^[0-9]{1,40}$') then raise exception 'Invalid cursor';end if;
 if operator_view and voice_flea_private.resolution_operator(actor) is not true then raise exception 'Operator required';end if;
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into rows from (
  select r.environment,r.transaction_id,r.order_id,r.owner_id,r.product_id,r.amount_jpy,r.classification,r.revoked,r.first_observed_at,r.last_observed_at,true as refund_review_required
  from voice_flea_private.legacy_apple_refund_reviews r where (operator_view or r.owner_id=actor)
   and (after_environment is null or (r.environment,r.transaction_id)>(after_environment,after_transaction))
  order by r.environment,r.transaction_id limit page_size
 ) q;
 return jsonb_build_object('receipts',rows,'paymentMovementAuthorized',false);
end $$;
revoke all on function public.legacy_refund_receipt_history(uuid,boolean,text,text,integer) from public,anon,authenticated;
grant execute on function public.legacy_refund_receipt_history(uuid,boolean,text,text,integer) to service_role;

-- A durable review is also a pre-charge admission barrier for old clients.
-- This never rejects an independently verified, late distinct receipt.
create function voice_flea_private.legacy_refund_subject_pending(owner uuid,kind text,subject uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from voice_flea_private.legacy_apple_refund_reviews r where r.owner_id=owner and r.order_kind=kind and r.subject_id=subject)
$$;
revoke all on function voice_flea_private.legacy_refund_subject_pending(uuid,text,uuid) from public,anon,authenticated,service_role;
create or replace function public.prepare_voice_iap_order(owner_id uuid,listing uuid,attempt uuid,tx_environment text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,16));perform pg_advisory_xact_lock(hashtextextended(owner_id::text,913));
 if voice_flea_private.legacy_refund_subject_pending(owner_id,'voice_listing',listing) then raise exception 'APPLE_REFUND_REVIEW_HELD';end if;
 return voice_flea_private.prepare_voice_iap_order_before_legacy_refund(owner_id,listing,attempt,tx_environment);
end $$;
create or replace function public.prepare_job_voice_iap_order(owner_id uuid,application uuid,attempt uuid,tx_environment text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare subject uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,16));perform pg_advisory_xact_lock(hashtextextended(owner_id::text,913));
 select job_id into subject from public.applications where id=application;
 if voice_flea_private.legacy_refund_subject_pending(owner_id,'voice_job',subject) then raise exception 'APPLE_REFUND_REVIEW_HELD';end if;
 return voice_flea_private.prepare_job_voice_iap_order_before_legacy_refund(owner_id,application,attempt,tx_environment);
end $$;
create or replace function public.prepare_boost_order_in_environment(owner_id uuid,listing uuid,tier text,tx_environment text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,16));perform pg_advisory_xact_lock(hashtextextended(owner_id::text,913));
 if voice_flea_private.legacy_refund_subject_pending(owner_id,'boost',listing) then raise exception 'APPLE_REFUND_REVIEW_HELD';end if;
 return voice_flea_private.prepare_boost_order_in_environment_before_legacy_refund(owner_id,listing,tier,tx_environment);
end $$;
revoke all on function public.prepare_voice_iap_order(uuid,uuid,uuid,text),public.prepare_job_voice_iap_order(uuid,uuid,uuid,text),public.prepare_boost_order_in_environment(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.prepare_voice_iap_order(uuid,uuid,uuid,text),public.prepare_job_voice_iap_order(uuid,uuid,uuid,text),public.prepare_boost_order_in_environment(uuid,uuid,text,text) to service_role;
create or replace function public.native_purchase_attempt(actor uuid,operation text,requested_order uuid default null,sku text default null,tx_environment text default null,price_jpy integer default null,tx_id text default null,requested_nonce uuid default null,requested_signed text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if operation='begin' then
  perform pg_advisory_xact_lock(hashtextextended(actor::text,16));perform pg_advisory_xact_lock(hashtextextended(actor::text,913));
  if voice_flea_private.legacy_refund_purpose_pending(requested_order) then raise exception 'APPLE_REFUND_REVIEW_HELD';end if;
 end if;
 return voice_flea_private.native_purchase_attempt_before_legacy_refund(actor,operation,requested_order,sku,tx_environment,price_jpy,tx_id,requested_nonce,requested_signed);
end $$;
revoke all on function public.native_purchase_attempt(uuid,text,uuid,text,text,integer,text,uuid,text) from public,anon,authenticated;
grant execute on function public.native_purchase_attempt(uuid,text,uuid,text,text,integer,text,uuid,text) to service_role;
