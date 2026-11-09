-- Local, opt-in backend stage. No Edge/native caller is switched to this protocol.
-- Admission is not money: a client cancellation report NEVER cancels an Apple charge.
create table voice_flea_private.native_retry_protocol_epoch (singleton boolean primary key default true check(singleton), installed_at timestamptz not null default clock_timestamp());
insert into voice_flea_private.native_retry_protocol_epoch(singleton) values(true);
revoke all on voice_flea_private.native_retry_protocol_epoch from public,anon,authenticated;
create table voice_flea_private.native_fulfillment_intents (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
 kind text not null check(kind in ('voice_listing','voice_job','boost')), subject_id uuid not null,
 environment text not null check(environment in ('Sandbox','Production')),
 winner_environment text, winner_transaction_id text, created_at timestamptz not null default now(),
 unique(owner_id,kind,subject_id,environment),
 check((winner_environment is null)=(winner_transaction_id is null))
);
create table voice_flea_private.native_retry_attempts (
 order_id uuid primary key, previous_order_id uuid unique references voice_flea_private.native_retry_attempts(order_id), intent_id uuid not null references voice_flea_private.native_fulfillment_intents(id),
 owner_id uuid not null references auth.users(id), nonce uuid not null unique,
 protocol_origin text not null default 'v3' check(protocol_origin in ('v3','legacy_overlap')),
 product_id text not null, amount_jpy integer not null check(amount_jpy>0),
 environment text not null check(environment in ('Sandbox','Production')),
 admission_state text not null default 'prepared' check(admission_state in ('prepared','dispatch_unknown','pending_approval','client_reported_cancelled','transaction_observed','retired')),
 client_cancel_reported_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index native_retry_one_admission_per_owner on voice_flea_private.native_retry_attempts(owner_id)
 where admission_state in ('prepared','dispatch_unknown','pending_approval');
create table voice_flea_private.native_verified_receipts (
 environment text not null, transaction_id text not null, order_id uuid not null references voice_flea_private.native_retry_attempts(order_id),
 intent_id uuid not null references voice_flea_private.native_fulfillment_intents(id), owner_id uuid not null,
 product_id text not null, amount_jpy integer not null, purchased_at timestamptz not null,
 classification text not null check(classification in ('winner','excess_payment_review','refunded_unfulfilled')),
 revoked boolean not null, signed_transaction text not null, result jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(environment,transaction_id), check(length(signed_transaction) between 1 and 30000)
);
create unique index native_retry_one_fulfillment on voice_flea_private.native_verified_receipts(intent_id) where classification='winner';
create table voice_flea_private.native_verified_receipt_evidence (
 id bigint generated always as identity primary key, environment text not null, transaction_id text not null,
 signed_transaction text not null check(length(signed_transaction) between 1 and 30000), observed_at timestamptz not null default now(),
 foreign key(environment,transaction_id) references voice_flea_private.native_verified_receipts(environment,transaction_id)
);
revoke all on voice_flea_private.native_verified_receipt_evidence from public,anon,authenticated;
revoke all on voice_flea_private.native_fulfillment_intents,voice_flea_private.native_retry_attempts,voice_flea_private.native_verified_receipts from public,anon,authenticated;

-- Claim a prepared, server-validated immutable order. Never adopt an old launched
-- v2 purchase or an already paid order into a fresh fulfillment intent.
create function public.native_retry_admission(actor uuid, operation text, requested_order uuid,
 requested_nonce uuid default null, fresh_order uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare a voice_flea_private.native_retry_attempts; i voice_flea_private.native_fulfillment_intents;
 v voice_flea_private.voice_iap_orders; b voice_flea_private.boost_orders;
 kind text; subject uuid; owner uuid; product text; env text; amount integer; intent uuid; fresh_nonce uuid;
begin
 if actor is null then raise exception 'Owner required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text,16));
 perform pg_advisory_xact_lock(hashtextextended(actor::text,913));
 if operation='register' then
  if not voice_flea_private.account_available(actor) then raise exception 'Account unavailable'; end if;
  select * into a from voice_flea_private.native_retry_attempts where order_id=requested_order;
  if found then
   if a.owner_id<>actor then raise exception 'Attempt owner mismatch'; end if;
   return jsonb_build_object('orderId',a.order_id,'intentId',a.intent_id,'attemptNonce',a.nonce,'state',a.admission_state,'launchGranted',false);
  end if;
  if exists(select 1 from voice_flea_private.native_purchase_attempts where order_id=requested_order) then raise exception 'Legacy attempt requires reconciliation'; end if;
  select * into v from voice_flea_private.voice_iap_orders where id=requested_order for update;
  if found then
   if v.state<>'prepared' or v.transaction_id is not null then raise exception 'Order not prepared'; end if;
   if v.created_at<(select installed_at from voice_flea_private.native_retry_protocol_epoch) then raise exception 'Legacy prepared order requires reconciliation'; end if;
   if exists(select 1 from voice_flea_private.voice_iap_orders x where x.id<>v.id and x.buyer_id=v.buyer_id and x.state='prepared' and ((v.job_id is not null and x.job_id=v.job_id) or (v.listing_id is not null and x.listing_id=v.listing_id))) then raise exception 'Overlapping prepared order requires reconciliation'; end if;
   -- A legacy receipt may have changed another prepared order to paid since
   -- this quote was created. Prepared-only checks miss that race. Stage 1 does
   -- not infer a new fulfillment lifecycle from a new quote/price/order ID.
   if exists(select 1 from public.payments p where p.buyer_id=v.buyer_id and
    ((v.job_id is not null and p.job_id=v.job_id) or (v.listing_id is not null and p.listing_id=v.listing_id))) then
    raise exception 'Existing financial history requires explicit intent reconciliation';
   end if;
   owner=v.buyer_id; product=v.product_id; env=v.environment; amount=v.amount_jpy;
   kind=case when v.job_id is null then 'voice_listing' else 'voice_job' end; subject=coalesce(v.job_id,v.listing_id);
  else
   select * into b from voice_flea_private.boost_orders where id=requested_order for update;
   if not found or b.state<>'pending' or b.transaction_id is not null then raise exception 'Order not prepared'; end if;
   if b.created_at<(select installed_at from voice_flea_private.native_retry_protocol_epoch) then raise exception 'Legacy prepared order requires reconciliation'; end if;
   if exists(select 1 from voice_flea_private.boost_orders x where x.id<>b.id and x.seller_id=b.seller_id and x.listing_id=b.listing_id and x.state='pending') then raise exception 'Overlapping prepared order requires reconciliation'; end if;
   if exists(select 1 from public.listing_boosts x where x.seller_id=b.seller_id and x.listing_id=b.listing_id)
    or exists(select 1 from voice_flea_private.boost_orders x where x.id<>b.id and x.seller_id=b.seller_id and x.listing_id=b.listing_id and x.transaction_id is not null) then
    raise exception 'Existing boost history requires explicit intent reconciliation';
   end if;
   owner=b.seller_id; product=b.product_id; env=b.environment;
   amount=case b.plan when 'silver' then 300 when 'gold' then 800 when 'platinum' then 1500 end;
   kind='boost';subject=b.listing_id;
  end if;
  if owner is distinct from actor or env not in ('Sandbox','Production') or amount is null then raise exception 'Order mismatch'; end if;
  -- Do not infer a new intent from a new order UUID, price or tier.
  if exists(select 1 from voice_flea_private.native_fulfillment_intents n where n.owner_id=actor and n.kind=kind and n.subject_id=subject) then raise exception 'Use the existing fulfillment intent'; end if;
  insert into voice_flea_private.native_fulfillment_intents(owner_id,kind,subject_id,environment)
   values(actor,kind,subject,env) returning id into intent;
  fresh_nonce=gen_random_uuid();
  insert into voice_flea_private.native_retry_attempts(order_id,intent_id,owner_id,nonce,product_id,amount_jpy,environment)
   values(requested_order,intent,actor,fresh_nonce,product,amount,env);
  return jsonb_build_object('orderId',requested_order,'intentId',intent,'attemptNonce',fresh_nonce,'state','prepared','launchGranted',false);
 end if;
 select * into a from voice_flea_private.native_retry_attempts where order_id=requested_order;
 if not found or a.owner_id is distinct from actor or a.nonce is distinct from requested_nonce then raise exception 'Attempt binding mismatch'; end if;
 select * into i from voice_flea_private.native_fulfillment_intents where id=a.intent_id for update;
 select * into a from voice_flea_private.native_retry_attempts where order_id=requested_order for update;
 if operation='status' then
  return jsonb_build_object('orderId',a.order_id,'intentId',a.intent_id,'attemptNonce',a.nonce,'state',a.admission_state,'launchGranted',false,'hasWinner',i.winner_transaction_id is not null);
 elsif operation='begin' then
  if not voice_flea_private.account_available(actor) then raise exception 'Account unavailable'; end if;
  if i.winner_transaction_id is not null then raise exception 'Intent already fulfilled'; end if;
  if a.admission_state<>'prepared' then
   -- Replay returns status, NEVER a fresh permit to invoke StoreKit.
   return jsonb_build_object('orderId',a.order_id,'state',a.admission_state,'launchGranted',false);
  end if;
  update voice_flea_private.native_retry_attempts set admission_state='dispatch_unknown',updated_at=now() where order_id=a.order_id;
  return jsonb_build_object('orderId',a.order_id,'state','dispatch_unknown','launchGranted',true);
 elsif operation='pending' then
  if a.admission_state='dispatch_unknown' then
   update voice_flea_private.native_retry_attempts set admission_state='pending_approval',updated_at=now() where order_id=a.order_id;
  elsif a.admission_state not in ('pending_approval','transaction_observed') then raise exception 'Invalid pending transition'; end if;
 elsif operation='client_cancel' then
  if a.admission_state='pending_approval' then raise exception 'Approval is not cancellation'; end if;
  if a.admission_state='prepared' then raise exception 'Purchase was not dispatched'; end if;
  -- This is an authenticated client REPORT, not Apple attestation. A late report
  -- cannot rewind observed money; repeated reports are harmless.
  update voice_flea_private.native_retry_attempts set
   admission_state=case when admission_state='dispatch_unknown' then 'client_reported_cancelled' else admission_state end,
   client_cancel_reported_at=coalesce(client_cancel_reported_at,now()),updated_at=now() where order_id=a.order_id;
 elsif operation='retry' then
  if not voice_flea_private.account_available(actor) then raise exception 'Account unavailable'; end if;
  if fresh_order is null or fresh_order=requested_order then raise exception 'Fresh order required'; end if;
  if i.winner_transaction_id is not null then raise exception 'Intent already fulfilled'; end if;
  if exists(select 1 from voice_flea_private.native_retry_attempts x where x.order_id=fresh_order and x.previous_order_id=a.order_id and x.intent_id=a.intent_id and x.owner_id=actor) then
   return (select jsonb_build_object('orderId',x.order_id,'intentId',x.intent_id,'attemptNonce',x.nonce,'state',x.admission_state,'launchGranted',false) from voice_flea_private.native_retry_attempts x where x.order_id=fresh_order);
  end if;
  if a.admission_state<>'client_reported_cancelled' then raise exception 'Retry requires reported cancellation'; end if;
  if exists(select 1 from voice_flea_private.native_retry_attempts where intent_id=a.intent_id and created_at>a.created_at) then raise exception 'Use latest attempt'; end if;
  -- Stage 1 freezes the retry quote. Changed listing price/contract must be
  -- requoted explicitly in a later flow, never silently substituted here.
  if i.kind in ('voice_listing','voice_job') then
   select * into v from voice_flea_private.voice_iap_orders where id=a.order_id for update;
   if v.transaction_id is not null or v.state<>'prepared' then raise exception 'Order already consumed'; end if;
   if not voice_flea_private.account_available(v.seller_id) then raise exception 'Seller unavailable'; end if;
   if v.listing_id is not null and not exists(select 1 from public.listings l where l.id=v.listing_id and l.is_active and l.seller_id=v.seller_id and l.price_jpy=v.amount_jpy) then raise exception 'Fresh quote required'; end if;
   if v.job_id is not null and not exists(select 1 from public.jobs j join public.applications ap on ap.job_id=j.id where j.id=v.job_id and j.status='open' and ap.id=v.job_application_id and ap.status='accepted' and ap.applicant_id=v.seller_id and ap.agreed_price_jpy=v.amount_jpy) then raise exception 'Fresh contract required'; end if;
   if exists(select 1 from public.user_blocks u where (u.blocker_id=actor and u.blocked_user_id=v.seller_id) or (u.blocker_id=v.seller_id and u.blocked_user_id=actor)) then raise exception 'Purchase unavailable'; end if;
   if not exists(select 1 from voice_flea_private.voice_iap_products p where p.product_id=v.product_id and p.amount_jpy=v.amount_jpy and case when v.environment='Production' then p.production_enabled else p.sandbox_enabled end) then raise exception 'Product unavailable'; end if;
   insert into voice_flea_private.voice_iap_orders(id,buyer_id,seller_id,listing_id,job_id,job_application_id,product_id,amount_jpy,environment)
    values(fresh_order,v.buyer_id,v.seller_id,v.listing_id,v.job_id,v.job_application_id,v.product_id,v.amount_jpy,v.environment);
  else
   select * into b from voice_flea_private.boost_orders where id=a.order_id for update;
   if b.transaction_id is not null or b.state<>'pending' then raise exception 'Order already consumed'; end if;
   if not exists(select 1 from public.listings l where l.id=b.listing_id and l.seller_id=actor and l.is_active) then raise exception 'Listing unavailable'; end if;
   if exists(select 1 from public.listing_boosts x where x.listing_id=b.listing_id and x.environment=b.environment and x.status='active' and x.ends_at>now()) then raise exception 'Boost already active'; end if;
   insert into voice_flea_private.boost_orders(id,seller_id,listing_id,plan,product_id,environment)
    values(fresh_order,b.seller_id,b.listing_id,b.plan,b.product_id,b.environment);
  end if;
  fresh_nonce=gen_random_uuid();
  update voice_flea_private.native_retry_attempts set admission_state='retired',updated_at=now() where order_id=a.order_id;
  insert into voice_flea_private.native_retry_attempts(order_id,previous_order_id,intent_id,owner_id,nonce,product_id,amount_jpy,environment)
   values(fresh_order,a.order_id,a.intent_id,actor,fresh_nonce,a.product_id,a.amount_jpy,a.environment);
  return jsonb_build_object('orderId',fresh_order,'intentId',a.intent_id,'attemptNonce',fresh_nonce,'state','prepared','launchGranted',false);
 else raise exception 'Unknown operation'; end if;
 return jsonb_build_object('accepted',true,'launchGranted',false);
end $$;
revoke all on function public.native_retry_admission(uuid,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.native_retry_admission(uuid,text,uuid,uuid,uuid) to service_role;

-- Move original per-order grant implementations behind the intent gate. Merely
-- calling the legacy public route for an opted-in order must not bypass it.
alter function public.apply_verified_apple_voice(uuid,text,text,text,timestamptz,bigint,text,boolean,uuid) set schema voice_flea_private;
alter function voice_flea_private.apply_verified_apple_voice(uuid,text,text,text,timestamptz,bigint,text,boolean,uuid) rename to apply_legacy_apple_voice;
alter function public.apply_verified_apple_boost(uuid,text,text,text,timestamptz,boolean) set schema voice_flea_private;
alter function voice_flea_private.apply_verified_apple_boost(uuid,text,text,text,timestamptz,boolean) rename to apply_legacy_apple_boost;
revoke all on function voice_flea_private.apply_legacy_apple_voice(uuid,text,text,text,timestamptz,bigint,text,boolean,uuid),voice_flea_private.apply_legacy_apple_boost(uuid,text,text,text,timestamptz,boolean) from public,anon,authenticated,service_role;
create function public.apply_verified_apple_voice(order_id uuid,tx_id text,sku text,tx_environment text,purchased_at timestamptz,price_milliunits bigint,currency text,revoked boolean,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actual_owner uuid;
begin
 select o.buyer_id into actual_owner from voice_flea_private.voice_iap_orders o where o.id=apply_verified_apple_voice.order_id;
 if actual_owner is null then raise exception 'Transaction mismatch'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actual_owner::text,16));
 perform pg_advisory_xact_lock(hashtextextended(actual_owner::text,913));
 perform 1 from voice_flea_private.voice_iap_orders o where o.id=apply_verified_apple_voice.order_id for update;
 if exists(select 1 from voice_flea_private.native_retry_attempts a where a.order_id=apply_verified_apple_voice.order_id) then raise exception 'Use native verified receipt gate'; end if;
 return voice_flea_private.apply_legacy_apple_voice(order_id,tx_id,sku,tx_environment,purchased_at,price_milliunits,currency,revoked,actor);
end $$;
create function public.apply_verified_apple_boost(order_id uuid,tx_id text,sku text,tx_environment text,purchased_at timestamptz,revoked boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actual_owner uuid;
begin
 select o.seller_id into actual_owner from voice_flea_private.boost_orders o where o.id=apply_verified_apple_boost.order_id;
 if actual_owner is null then raise exception 'Transaction mismatch'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actual_owner::text,16));
 perform pg_advisory_xact_lock(hashtextextended(actual_owner::text,913));
 perform 1 from voice_flea_private.boost_orders o where o.id=apply_verified_apple_boost.order_id for update;
 if exists(select 1 from voice_flea_private.native_retry_attempts a where a.order_id=apply_verified_apple_boost.order_id) then raise exception 'Use native verified receipt gate'; end if;
 return voice_flea_private.apply_legacy_apple_boost(order_id,tx_id,sku,tx_environment,purchased_at,revoked);
end $$;
revoke all on function public.apply_verified_apple_voice(uuid,text,text,text,timestamptz,bigint,text,boolean,uuid),public.apply_verified_apple_boost(uuid,text,text,text,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.apply_verified_apple_voice(uuid,text,text,text,timestamptz,bigint,text,boolean,uuid),public.apply_verified_apple_boost(uuid,text,text,text,timestamptz,boolean) to service_role;

-- This is a SERVICE-ONLY sink for already Apple-verified fields plus JWS.
-- It does not verify a JWS itself. Edge must run the existing signature/current
-- Apple lookup before calling. No authenticated-user RPC execution is granted.
create function public.apply_native_verified_receipt(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,price_milliunits bigint,currency text,revoked boolean,signed_transaction text,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare a voice_flea_private.native_retry_attempts; i voice_flea_private.native_fulfillment_intents;
 r voice_flea_private.native_verified_receipts; result jsonb; classification text;
 v voice_flea_private.voice_iap_orders; b voice_flea_private.boost_orders;
 legacy_owner uuid; legacy_subject uuid; legacy_kind text; legacy_env text; legacy_product text; legacy_amount integer; legacy_created timestamptz; legacy_consumed boolean;
begin
 select * into a from voice_flea_private.native_retry_attempts x where x.order_id=apply_native_verified_receipt.order_id;
 if not found then
  -- Exceptional old-client overlap: retain already-paid proof for review, do
  -- not lose it in a 409 and do not silently grant another fulfillment.
  select * into v from voice_flea_private.voice_iap_orders where id=apply_native_verified_receipt.order_id;
  if found then
   legacy_owner=v.buyer_id;legacy_subject=coalesce(v.job_id,v.listing_id);legacy_kind=case when v.job_id is null then 'voice_listing' else 'voice_job' end;
   legacy_env=v.environment;legacy_product=v.product_id;legacy_amount=v.amount_jpy;legacy_created=v.created_at;legacy_consumed=v.transaction_id is not null;
  else
   select * into b from voice_flea_private.boost_orders where id=apply_native_verified_receipt.order_id;
   if not found then raise exception 'Native or legacy order missing'; end if;
   legacy_owner=b.seller_id;legacy_subject=b.listing_id;legacy_kind='boost';legacy_env=coalesce(b.environment,tx_environment);legacy_product=b.product_id;
   legacy_amount=case b.plan when 'silver' then 300 when 'gold' then 800 when 'platinum' then 1500 end;legacy_created=b.created_at;legacy_consumed=b.transaction_id is not null;
  end if;
  if actor is not null and actor<>legacy_owner then raise exception 'Owner mismatch'; end if;
  perform pg_advisory_xact_lock(hashtextextended(legacy_owner::text,16));
  perform pg_advisory_xact_lock(hashtextextended(legacy_owner::text,913));
  -- Re-read the original order under its row lock after admission serialization;
  -- a legacy verification may have completed while we waited. Never quarantine
  -- an already-consumed historical order based on a stale prepared snapshot.
  if legacy_kind='boost' then
   select transaction_id is not null into legacy_consumed from voice_flea_private.boost_orders where id=apply_native_verified_receipt.order_id for update;
  else
   select transaction_id is not null into legacy_consumed from voice_flea_private.voice_iap_orders where id=apply_native_verified_receipt.order_id for update;
  end if;
  select * into i from voice_flea_private.native_fulfillment_intents n where n.owner_id=legacy_owner and n.kind=legacy_kind and n.subject_id=legacy_subject for update;
  if not found or legacy_consumed then
   -- Unrelated/already-consumed legacy transactions retain their old contract.
   if legacy_kind='boost' then
    return public.apply_priced_apple_boost(order_id,tx_id,sku,tx_environment,purchased_at,revoked,price_milliunits,currency);
   end if;
   return voice_flea_private.apply_legacy_apple_voice(order_id,tx_id,sku,tx_environment,purchased_at,price_milliunits,currency,revoked,actor);
  end if;
  insert into voice_flea_private.native_retry_attempts(order_id,intent_id,owner_id,nonce,protocol_origin,product_id,amount_jpy,environment,admission_state,created_at)
   values(order_id,i.id,legacy_owner,gen_random_uuid(),'legacy_overlap',legacy_product,legacy_amount,legacy_env,'transaction_observed',legacy_created)
   on conflict on constraint native_retry_attempts_pkey do nothing;
  select * into a from voice_flea_private.native_retry_attempts x where x.order_id=apply_native_verified_receipt.order_id;
 end if;
 -- Same lock order as admission; notification actor may be null but owner is
 -- always derived from the immutable attempt, never the caller's claim.
 perform pg_advisory_xact_lock(hashtextextended(a.owner_id::text,16));
 perform pg_advisory_xact_lock(hashtextextended(a.owner_id::text,913));
 select * into i from voice_flea_private.native_fulfillment_intents where id=a.intent_id for update;
 if actor is not null and actor<>a.owner_id then raise exception 'Owner mismatch'; end if;
 if sku is distinct from a.product_id or tx_environment is distinct from a.environment or currency is distinct from 'JPY'
  or price_milliunits is distinct from a.amount_jpy::bigint*1000 or tx_id is null or tx_id!~'^[0-9]{1,40}$'
  or purchased_at is null or purchased_at<a.created_at-interval '10 minutes' or purchased_at>now()+interval '5 minutes'
  or revoked is null or signed_transaction is null or length(signed_transaction) not between 1 and 30000 then raise exception 'Verified receipt mismatch'; end if;
 select * into r from voice_flea_private.native_verified_receipts x where x.environment=tx_environment and x.transaction_id=tx_id for update;
 if found then
  if r.order_id<>a.order_id or r.intent_id<>a.intent_id or r.product_id<>sku or r.amount_jpy<>a.amount_jpy or r.purchased_at<>purchased_at then raise exception 'Transaction already assigned'; end if;
  -- Revocation is monotonic. Old positive payloads never resurrect any receipt.
  revoked=revoked or r.revoked; classification=r.classification;
 else
  classification=case when a.protocol_origin='legacy_overlap' or i.winner_transaction_id is not null then 'excess_payment_review' when revoked then 'refunded_unfulfilled' else 'winner' end;
  insert into voice_flea_private.native_verified_receipts(environment,transaction_id,order_id,intent_id,owner_id,product_id,amount_jpy,purchased_at,classification,revoked,signed_transaction)
   values(tx_environment,tx_id,a.order_id,a.intent_id,a.owner_id,sku,a.amount_jpy,purchased_at,classification,revoked,signed_transaction);
  if classification='winner' then
   update voice_flea_private.native_fulfillment_intents set winner_environment=tx_environment,winner_transaction_id=tx_id where id=a.intent_id;
  end if;
 end if;
 insert into voice_flea_private.native_verified_receipt_evidence(environment,transaction_id,signed_transaction)
 select tx_environment,tx_id,signed_transaction where not exists(select 1 from voice_flea_private.native_verified_receipt_evidence e
  where e.environment=tx_environment and e.transaction_id=tx_id and e.signed_transaction=apply_native_verified_receipt.signed_transaction);
 if classification='winner' then
  if i.kind='boost' then result=voice_flea_private.apply_legacy_apple_boost(order_id,tx_id,sku,tx_environment,purchased_at,revoked);
  else result=voice_flea_private.apply_legacy_apple_voice(order_id,tx_id,sku,tx_environment,purchased_at,price_milliunits,currency,revoked,actor); end if;
 else
  -- No payment/conversation/boost/seller allocation is created for excess money.
  -- Its durable ledger is a liability/review record, NOT a refund confirmation.
  result=jsonb_build_object('environment',tx_environment,'revoked',revoked,'reviewRequired',classification='excess_payment_review','fulfillmentGranted',false);
 end if;
 result=result||jsonb_build_object('intentId',a.intent_id,'orderId',a.order_id,'transactionId',tx_id,'receiptClassification',classification,'financiallyRecorded',true);
 update voice_flea_private.native_verified_receipts x set revoked=apply_native_verified_receipt.revoked,
  signed_transaction=apply_native_verified_receipt.signed_transaction,result=result,updated_at=now()
  where x.environment=tx_environment and x.transaction_id=tx_id;
 update voice_flea_private.native_retry_attempts set admission_state='transaction_observed',updated_at=now() where native_retry_attempts.order_id=a.order_id;
 return result;
end $$;
revoke all on function public.apply_native_verified_receipt(uuid,text,text,text,timestamptz,bigint,text,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.apply_native_verified_receipt(uuid,text,text,text,timestamptz,bigint,text,boolean,text,uuid) to service_role;

-- Read-only review surface. Raw proof stays private; no money movement or
-- permission to mark a refund successful is exposed by this endpoint.
create function public.native_retry_receipt_history(actor uuid, operator_view boolean default false,
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
   (r.classification='excess_payment_review' and not r.revoked) as refund_review_required
  from voice_flea_private.native_verified_receipts r
  where (operator_view or r.owner_id=actor)
   and (after_environment is null and after_transaction is null or (r.environment,r.transaction_id)>(after_environment,after_transaction))
  order by r.environment,r.transaction_id limit page_size
 ) q;
 return jsonb_build_object('receipts',rows,'paymentMovementAuthorized',false);
end $$;
revoke all on function public.native_retry_receipt_history(uuid,boolean,text,text,integer) from public,anon,authenticated;
grant execute on function public.native_retry_receipt_history(uuid,boolean,text,text,integer) to service_role;

create function voice_flea_private.guard_native_retry_deletion()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,16));
 if exists(select 1 from voice_flea_private.native_retry_attempts a where a.owner_id=new.user_id and a.admission_state<>'transaction_observed')
  or exists(select 1 from voice_flea_private.native_verified_receipts r where r.owner_id=new.user_id and r.classification='excess_payment_review' and not r.revoked) then
  raise exception 'Unresolved Apple attempt or excess payment; reconcile before account deletion';
 end if;
 return new;
end $$;
revoke all on function voice_flea_private.guard_native_retry_deletion() from public,anon,authenticated;
create trigger guard_native_retry_deletion before insert or update on voice_flea_private.account_deletions
for each row execute function voice_flea_private.guard_native_retry_deletion();

-- Cross-version admission: old clients must not create a parallel untracked
-- order for the same fulfillment purpose after v3 opt-in. No legacy order is
-- silently adopted. V3 retries create immutable clones through admission above.
alter function public.prepare_voice_iap_order(uuid,uuid,uuid,text) set schema voice_flea_private;
alter function voice_flea_private.prepare_voice_iap_order(uuid,uuid,uuid,text) rename to prepare_legacy_voice_iap_order;
alter function public.prepare_job_voice_iap_order(uuid,uuid,uuid,text) set schema voice_flea_private;
alter function voice_flea_private.prepare_job_voice_iap_order(uuid,uuid,uuid,text) rename to prepare_legacy_job_voice_iap_order;
alter function public.prepare_boost_order_in_environment(uuid,uuid,text,text) set schema voice_flea_private;
alter function voice_flea_private.prepare_boost_order_in_environment(uuid,uuid,text,text) rename to prepare_legacy_boost_order_in_environment;
revoke all on function voice_flea_private.prepare_legacy_voice_iap_order(uuid,uuid,uuid,text),voice_flea_private.prepare_legacy_job_voice_iap_order(uuid,uuid,uuid,text),voice_flea_private.prepare_legacy_boost_order_in_environment(uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.prepare_voice_iap_order(owner_id uuid,listing uuid,attempt uuid,tx_environment text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,16));
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,913));
 if exists(select 1 from voice_flea_private.native_fulfillment_intents i where i.owner_id=prepare_voice_iap_order.owner_id and i.kind='voice_listing' and i.subject_id=listing) then raise exception 'Use native intent recovery'; end if;
 return voice_flea_private.prepare_legacy_voice_iap_order(owner_id,listing,attempt,tx_environment);
end $$;
create function public.prepare_job_voice_iap_order(owner_id uuid,application uuid,attempt uuid,tx_environment text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,16));
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,913));
 select a.job_id into job from public.applications a where a.id=application;
 if exists(select 1 from voice_flea_private.native_fulfillment_intents i where i.owner_id=prepare_job_voice_iap_order.owner_id and i.kind='voice_job' and i.subject_id=job) then raise exception 'Use native intent recovery'; end if;
 return voice_flea_private.prepare_legacy_job_voice_iap_order(owner_id,application,attempt,tx_environment);
end $$;
create function public.prepare_boost_order_in_environment(owner_id uuid,listing uuid,tier text,tx_environment text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,16));
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,913));
 if exists(select 1 from voice_flea_private.native_fulfillment_intents i where i.owner_id=prepare_boost_order_in_environment.owner_id and i.kind='boost' and i.subject_id=listing) then raise exception 'Use native intent recovery'; end if;
 return voice_flea_private.prepare_legacy_boost_order_in_environment(owner_id,listing,tier,tx_environment);
end $$;
revoke all on function public.prepare_voice_iap_order(uuid,uuid,uuid,text),public.prepare_job_voice_iap_order(uuid,uuid,uuid,text),public.prepare_boost_order_in_environment(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.prepare_voice_iap_order(uuid,uuid,uuid,text),public.prepare_job_voice_iap_order(uuid,uuid,uuid,text),public.prepare_boost_order_in_environment(uuid,uuid,text,text) to service_role;

-- The owned outer Boost wrapper used to acquire its row lock before entering
-- apply_priced/apply_verified. Match owner→row ordering here too, otherwise
-- adding owner serialization only in the inner wrapper creates a deadlock.
create or replace function public.apply_owned_priced_apple_boost(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,revoked boolean,price_milliunits bigint,currency text,actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actual_owner uuid;
begin
 select o.seller_id into actual_owner from voice_flea_private.boost_orders o where o.id=apply_owned_priced_apple_boost.order_id;
 if actual_owner is null then raise exception 'Order owner mismatch'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actual_owner::text,16));
 perform pg_advisory_xact_lock(hashtextextended(actual_owner::text,913));
 select o.seller_id into actual_owner from voice_flea_private.boost_orders o where o.id=apply_owned_priced_apple_boost.order_id for update;
 if actor is null or actual_owner is distinct from actor then raise exception 'Order owner mismatch'; end if;
 return public.apply_priced_apple_boost(order_id,tx_id,sku,tx_environment,purchased_at,revoked,price_milliunits,currency);
end $$;
revoke all on function public.apply_owned_priced_apple_boost(uuid,text,text,text,timestamptz,boolean,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.apply_owned_priced_apple_boost(uuid,text,text,text,timestamptz,boolean,bigint,text,uuid) to service_role;
