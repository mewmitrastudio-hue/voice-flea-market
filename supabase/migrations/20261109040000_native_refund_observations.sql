-- Local-only v3 receipt extension. The service must verify the Apple signature
-- AND current transaction before calling these RPCs. SQL validates bindings;
-- it does not authenticate a JWS string or infer missing monetary evidence.
alter table voice_flea_private.native_verified_receipts drop constraint native_verified_receipts_classification_check;
alter table voice_flea_private.native_verified_receipts add constraint native_verified_receipts_classification_check
 check(classification in ('winner','excess_payment_review','refunded_unfulfilled','refund_review_unfulfilled'));

-- An observation is a permanent review hold, not a refund amount or permission
-- to pay/recover funds. Only the exact receipt is held, never the whole order.
create table voice_flea_private.native_refund_review_holds (
 environment text not null, transaction_id text not null,
 evidence jsonb not null check(jsonb_typeof(evidence)='object' and octet_length(evidence::text)<=30000),
 first_observed_at timestamptz not null default clock_timestamp(),
 last_observed_at timestamptz not null default clock_timestamp(),
 primary key(environment,transaction_id),
 foreign key(environment,transaction_id) references voice_flea_private.native_verified_receipts(environment,transaction_id)
);
create table voice_flea_private.native_refund_observation_evidence (
 id bigint generated always as identity primary key, environment text not null, transaction_id text not null,
 evidence jsonb not null check(jsonb_typeof(evidence)='object' and octet_length(evidence::text)<=30000),
 signed_transaction text not null check(length(signed_transaction) between 1 and 30000),
 observed_at timestamptz not null default clock_timestamp(),
 foreign key(environment,transaction_id) references voice_flea_private.native_refund_review_holds(environment,transaction_id)
);
alter table voice_flea_private.native_refund_review_holds enable row level security;
alter table voice_flea_private.native_refund_observation_evidence enable row level security;
revoke all on voice_flea_private.native_refund_review_holds,voice_flea_private.native_refund_observation_evidence from public,anon,authenticated,service_role;

create function public.record_native_refund_observation(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,price_milliunits bigint,currency text,evidence jsonb,signed_transaction text,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare a voice_flea_private.native_retry_attempts; i voice_flea_private.native_fulfillment_intents;
 r voice_flea_private.native_verified_receipts; v voice_flea_private.voice_iap_orders; b voice_flea_private.boost_orders;
 p public.payments; h voice_flea_private.apple_refund_review_holds; result jsonb;
 actual_owner uuid; subject uuid; kind text; product text; env text; amount integer; created timestamptz; consumed boolean;
begin
 select * into a from voice_flea_private.native_retry_attempts x where x.order_id=record_native_refund_observation.order_id;
 if not found then
  select * into v from voice_flea_private.voice_iap_orders where id=order_id;
  if found then
   actual_owner=v.buyer_id;subject=coalesce(v.job_id,v.listing_id);kind=case when v.job_id is null then 'voice_listing' else 'voice_job' end;
   product=v.product_id;env=v.environment;amount=v.amount_jpy;created=v.created_at;
  else
   select * into b from voice_flea_private.boost_orders where id=order_id;
   if not found then raise exception 'Native or legacy order missing'; end if;
   actual_owner=b.seller_id;subject=b.listing_id;kind='boost';product=b.product_id;env=coalesce(b.environment,tx_environment);
   amount=case b.plan when 'silver' then 300 when 'gold' then 800 when 'platinum' then 1500 end;created=b.created_at;
  end if;
  if actor is not null and actor<>actual_owner then raise exception 'Owner mismatch'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actual_owner::text,16));
  perform pg_advisory_xact_lock(hashtextextended(actual_owner::text,913));
  -- The legacy order may have been consumed while waiting; preserve that
  -- historical reconciliation path rather than retroactively adopting it.
  if kind='boost' then
   select transaction_id is not null into consumed from voice_flea_private.boost_orders where id=order_id for update;
  else
   select transaction_id is not null into consumed from voice_flea_private.voice_iap_orders where id=order_id for update;
  end if;
  select * into a from voice_flea_private.native_retry_attempts x where x.order_id=record_native_refund_observation.order_id;
  if not found then
   select * into i from voice_flea_private.native_fulfillment_intents n where n.owner_id=actual_owner and n.kind=kind and n.subject_id=subject for update;
   if not found or consumed then return jsonb_build_object('handled',false); end if;
   insert into voice_flea_private.native_retry_attempts(order_id,intent_id,owner_id,nonce,protocol_origin,product_id,amount_jpy,environment,admission_state,created_at)
    values(order_id,i.id,actual_owner,gen_random_uuid(),'legacy_overlap',product,amount,env,'transaction_observed',created);
   select * into a from voice_flea_private.native_retry_attempts x where x.order_id=record_native_refund_observation.order_id;
  end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(a.owner_id::text,16));
 perform pg_advisory_xact_lock(hashtextextended(a.owner_id::text,913));
 select * into i from voice_flea_private.native_fulfillment_intents where id=a.intent_id for update;
 if actor is not null and actor<>a.owner_id then raise exception 'Owner mismatch'; end if;
 if sku is distinct from a.product_id or tx_environment is distinct from a.environment or currency is distinct from 'JPY'
  or price_milliunits is distinct from a.amount_jpy::bigint*1000 or tx_id is null or tx_id!~'^[0-9]{1,40}$'
  or purchased_at is null or purchased_at<a.created_at-interval '10 minutes' or purchased_at>now()+interval '5 minutes'
  or signed_transaction is null or length(signed_transaction) not between 1 and 30000 then raise exception 'Verified receipt mismatch'; end if;
 -- Unsupported/missing version, type or percentage is retained, never trusted
 -- as full refund authority. Missing date is not manufactured. A supplied date
 -- must still be a valid finite positive millisecond value.
 if evidence is null or jsonb_typeof(evidence)<>'object' or octet_length(evidence::text)>30000
  or not (coalesce(evidence->'revocationDate','null'::jsonb)<>'null'::jsonb
       or coalesce(evidence->'revocationType','null'::jsonb)<>'null'::jsonb
       or coalesce(evidence->'revocationPercentage','null'::jsonb)<>'null'::jsonb) then raise exception 'Refund observation required'; end if;
 if coalesce(evidence->'revocationDate','null'::jsonb)<>'null'::jsonb then
  if jsonb_typeof(evidence->'revocationDate')<>'number' then raise exception 'Invalid refund date'; end if;
  if (evidence->>'revocationDate')::numeric<=0 or (evidence->>'revocationDate')::numeric>9007199254740991 then raise exception 'Invalid refund date'; end if;
 end if;
 select * into r from voice_flea_private.native_verified_receipts x where x.environment=tx_environment and x.transaction_id=tx_id for update;
 if found then
  if r.order_id<>a.order_id or r.intent_id<>a.intent_id or r.owner_id<>a.owner_id or r.product_id<>sku or r.amount_jpy<>a.amount_jpy or r.purchased_at<>purchased_at then raise exception 'Transaction already assigned'; end if;
 else
  insert into voice_flea_private.native_verified_receipts(environment,transaction_id,order_id,intent_id,owner_id,product_id,amount_jpy,purchased_at,classification,revoked,signed_transaction)
   values(tx_environment,tx_id,a.order_id,a.intent_id,a.owner_id,sku,a.amount_jpy,purchased_at,
    case when a.protocol_origin='legacy_overlap' or i.winner_transaction_id is not null then 'excess_payment_review' else 'refund_review_unfulfilled' end,false,signed_transaction)
   returning * into r;
 end if;
 -- Never call the order-bound hold for a same-order distinct transaction. Only
 -- a winner with its own exact payment is bridged into existing fulfillment,
 -- allocation, dispatch, recovery and terminal-settlement eligibility guards.
 if r.classification='winner' and i.kind<>'boost' then
  select * into v from voice_flea_private.voice_iap_orders where id=a.order_id for update;
  select * into p from public.payments where id=v.payment_id for update;
  if p.id is null or v.transaction_id is distinct from tx_id or v.environment is distinct from tx_environment
   or p.apple_transaction_id is distinct from tx_id or p.apple_environment is distinct from tx_environment
   or p.payment_channel is distinct from 'ios' or p.buyer_id is distinct from a.owner_id then raise exception 'Winner payment mismatch'; end if;
  select * into h from voice_flea_private.apple_refund_review_holds x where x.order_id=a.order_id;
  if found and (h.transaction_id<>tx_id or h.environment<>tx_environment) then raise exception 'Refund review identity mismatch'; end if;
  insert into voice_flea_private.apple_refund_review_holds(order_id,transaction_id,environment,evidence)
   values(a.order_id,tx_id,tx_environment,evidence)
   on conflict on constraint apple_refund_review_holds_pkey do update set last_observed_at=clock_timestamp();
 end if;
 insert into voice_flea_private.native_refund_review_holds(environment,transaction_id,evidence) values(tx_environment,tx_id,evidence)
  on conflict on constraint native_refund_review_holds_pkey do update set last_observed_at=clock_timestamp();
 insert into voice_flea_private.native_refund_observation_evidence(environment,transaction_id,evidence,signed_transaction)
  select tx_environment,tx_id,evidence,signed_transaction where not exists(select 1 from voice_flea_private.native_refund_observation_evidence x
   where x.environment=tx_environment and x.transaction_id=tx_id and x.evidence=record_native_refund_observation.evidence and x.signed_transaction=record_native_refund_observation.signed_transaction);
 insert into voice_flea_private.native_verified_receipt_evidence(environment,transaction_id,signed_transaction)
  select tx_environment,tx_id,signed_transaction where not exists(select 1 from voice_flea_private.native_verified_receipt_evidence x
   where x.environment=tx_environment and x.transaction_id=tx_id and x.signed_transaction=record_native_refund_observation.signed_transaction);
 result=coalesce(r.result,'{}'::jsonb)||jsonb_build_object('handled',true,'intentId',a.intent_id,'orderId',a.order_id,
  'transactionId',tx_id,'environment',tx_environment,'receiptClassification',r.classification,'financiallyRecorded',true,
  'fulfillmentGranted',false,'reviewRequired',true,'revoked',r.revoked);
 update voice_flea_private.native_verified_receipts x set result=result,signed_transaction=record_native_refund_observation.signed_transaction,updated_at=clock_timestamp()
  where x.environment=tx_environment and x.transaction_id=tx_id;
 update voice_flea_private.native_retry_attempts x set admission_state='transaction_observed',updated_at=clock_timestamp() where x.order_id=a.order_id;
 -- No payment amounts, boost state/end time, winner identity or funds change.
 return result;
end $$;
revoke all on function public.record_native_refund_observation(uuid,text,text,text,timestamptz,bigint,text,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.record_native_refund_observation(uuid,text,text,text,timestamptz,bigint,text,jsonb,text,uuid) to service_role;

-- Keep the audited Stage1 body intact, but make it callable only inside this
-- gate. Keeping its name preserves its existing parameter block qualifiers.
alter function public.apply_native_verified_receipt(uuid,text,text,text,timestamptz,bigint,text,boolean,text,uuid) set schema voice_flea_private;
revoke all on function voice_flea_private.apply_native_verified_receipt(uuid,text,text,text,timestamptz,bigint,text,boolean,text,uuid) from public,anon,authenticated,service_role;
create function public.apply_native_verified_receipt(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,price_milliunits bigint,currency text,revoked boolean,signed_transaction text,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare a voice_flea_private.native_retry_attempts; r voice_flea_private.native_verified_receipts; result jsonb; actual_owner uuid;
begin
 select owner_id into actual_owner from voice_flea_private.native_retry_attempts x where x.order_id=apply_native_verified_receipt.order_id;
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
 select * into a from voice_flea_private.native_retry_attempts x where x.order_id=apply_native_verified_receipt.order_id;
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
    where x.environment=tx_environment and x.transaction_id=tx_id and x.signed_transaction=apply_native_verified_receipt.signed_transaction);
  result=r.result;
 end if;
 select * into r from voice_flea_private.native_verified_receipts x where x.environment=tx_environment and x.transaction_id=tx_id;
 result=coalesce(result,'{}'::jsonb)||jsonb_build_object('intentId',a.intent_id,'orderId',a.order_id,'transactionId',tx_id,
  'environment',tx_environment,'receiptClassification',r.classification,'financiallyRecorded',true,
  'fulfillmentGranted',false,'reviewRequired',true,'revoked',r.revoked);
 update voice_flea_private.native_verified_receipts x set result=result,updated_at=clock_timestamp() where x.environment=tx_environment and x.transaction_id=tx_id;
 return result;
end $$;
revoke all on function public.apply_native_verified_receipt(uuid,text,text,text,timestamptz,bigint,text,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.apply_native_verified_receipt(uuid,text,text,text,timestamptz,bigint,text,boolean,text,uuid) to service_role;

-- Retain all previous legacy eligibility behavior. Native duplicate holds do
-- not enter the old order-bound table and therefore cannot freeze a winner.
create function voice_flea_private.native_refund_pending_for_user(target uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from voice_flea_private.native_refund_review_holds h
  join voice_flea_private.native_verified_receipts r using(environment,transaction_id)
  left join voice_flea_private.voice_iap_orders o on o.id=r.order_id
  where r.owner_id=target or o.seller_id=target)
$$;
revoke all on function voice_flea_private.native_refund_pending_for_user(uuid) from public,anon,authenticated,service_role;
-- Preserve the existing function OID so previously compiled callers also see
-- the extended predicate; copy the unchanged legacy predicate into a helper.
create function voice_flea_private.apple_settlement_pending_before_native_refund(target uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from voice_flea_private.apple_refund_review_holds h join voice_flea_private.voice_iap_orders o on o.id=h.order_id where target in (o.buyer_id,o.seller_id))
 or exists(select 1 from voice_flea_private.apple_proceeds_allocations a where a.seller_id=target and a.state in ('allocated_unpaid','adjustment_required'))
 or exists(select 1 from public.payments p where p.seller_id=target and p.payment_channel='ios' and p.apple_environment='Production' and p.status='paid' and not coalesce(voice_flea_private.verified_voice_refund(p),false)
 and not exists(select 1 from voice_flea_private.apple_terminal_settlements s where s.payment_id=p.id and s.state='settled'))
$$;
revoke all on function voice_flea_private.apple_settlement_pending_before_native_refund(uuid) from public,anon,authenticated,service_role;
create or replace function voice_flea_private.apple_settlement_pending_for_user(target uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select voice_flea_private.apple_settlement_pending_before_native_refund(target) or voice_flea_private.native_refund_pending_for_user(target)
$$;
revoke all on function voice_flea_private.apple_settlement_pending_for_user(uuid) from public,anon,authenticated,service_role;

create or replace function voice_flea_private.guard_native_retry_deletion()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,16));
 if exists(select 1 from voice_flea_private.native_retry_attempts a where a.owner_id=new.user_id and a.admission_state<>'transaction_observed')
  or exists(select 1 from voice_flea_private.native_verified_receipts r where r.owner_id=new.user_id and r.classification='excess_payment_review' and not r.revoked)
  or voice_flea_private.native_refund_pending_for_user(new.user_id) then
  raise exception 'Unresolved Apple attempt or excess payment or refund review; reconcile before account deletion';
 end if;
 return new;
end $$;

create or replace function public.native_retry_receipt_history(actor uuid, operator_view boolean default false,
 after_environment text default null, after_transaction text default null, page_size integer default 25)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;
begin
 if actor is null or page_size is null or page_size not between 1 and 100 then raise exception 'Invalid reader'; end if;
 if (after_environment is null)<>(after_transaction is null) then raise exception 'Complete cursor required'; end if;
 if after_environment is not null and (after_environment not in ('Sandbox','Production') or after_transaction!~'^[0-9]{1,40}$') then raise exception 'Invalid cursor'; end if;
 if operator_view and voice_flea_private.resolution_operator(actor) is not true then raise exception 'Operator required'; end if;
 select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into rows from (
  select r.environment,r.transaction_id,r.order_id,r.intent_id,r.owner_id,r.product_id,r.amount_jpy,
   r.classification,r.revoked,r.created_at,r.updated_at,
   (h.transaction_id is not null or r.classification='excess_payment_review' and not r.revoked) as refund_review_required,
   h.transaction_id is not null as refund_observation_recorded
  from voice_flea_private.native_verified_receipts r left join voice_flea_private.native_refund_review_holds h using(environment,transaction_id)
  where (operator_view or r.owner_id=actor)
   and (after_environment is null and after_transaction is null or (r.environment,r.transaction_id)>(after_environment,after_transaction))
  order by r.environment,r.transaction_id limit page_size
 ) q;
 return jsonb_build_object('receipts',rows,'paymentMovementAuthorized',false);
end $$;

create or replace function voice_flea_private.apple_refund_review_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare n bigint;
begin
 if auth.uid() is null or not voice_flea_private.account_available(auth.uid()) then raise exception 'Sign in required' using errcode='42501';end if;
 select count(*) into n from (
  select h.environment,h.transaction_id from voice_flea_private.apple_refund_review_holds h join voice_flea_private.voice_iap_orders o on o.id=h.order_id where auth.uid() in (o.buyer_id,o.seller_id)
  union
  select h.environment,h.transaction_id from voice_flea_private.native_refund_review_holds h
   join voice_flea_private.native_verified_receipts r using(environment,transaction_id)
   left join voice_flea_private.voice_iap_orders o on o.id=r.order_id where r.owner_id=auth.uid() or o.seller_id=auth.uid()
 ) q;
 return jsonb_build_object('reviewRequired',n>0,'count',n);
end $$;
