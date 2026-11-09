-- Durable pre-charge latch: reinstall and another device must not turn an
-- empty StoreKit.unfinished stream into permission to buy again.
create table voice_flea_private.native_purchase_attempts (
 order_id uuid primary key, attempt_nonce uuid not null, owner_id uuid not null references auth.users(id),
 product_id text not null, environment text not null check(environment in ('Sandbox','Production')),
 amount_jpy integer not null check(amount_jpy>0), state text not null check(state in ('pending','cancelled','granted','applied_finish_uncertain','finished')),
 transaction_id text, signed_transaction text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index native_purchase_one_pending_owner on voice_flea_private.native_purchase_attempts(owner_id) where state in ('pending','granted');
revoke all on voice_flea_private.native_purchase_attempts from public,anon,authenticated;
create function public.native_purchase_attempt(actor uuid, operation text, requested_order uuid default null,
 sku text default null, tx_environment text default null, price_jpy integer default null, tx_id text default null, requested_nonce uuid default null, requested_signed text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a voice_flea_private.native_purchase_attempts; actual_owner uuid; actual_sku text; actual_env text; actual_price integer;
begin
 if actor is null then raise exception 'Owner required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text,16));
 perform pg_advisory_xact_lock(hashtextextended(actor::text,911));
 if operation='status' then
  select * into a from voice_flea_private.native_purchase_attempts where owner_id=actor and state in ('pending','granted');
  if not found then return jsonb_build_object('pending',null); end if;
  return jsonb_build_object('pending',jsonb_build_object('orderId',a.order_id,'ownerId',a.owner_id,'productId',a.product_id,'environment',a.environment,'amountJpy',a.amount_jpy,'state',a.state,'attemptNonce',a.attempt_nonce,'transactionId',a.transaction_id,'signedTransaction',a.signed_transaction));
 end if;
 if operation='begin' then
  if not voice_flea_private.account_available(actor) then raise exception 'Account unavailable'; end if;
  if requested_nonce is null then raise exception 'Attempt nonce required'; end if;
  select buyer_id,product_id,environment,amount_jpy into actual_owner,actual_sku,actual_env,actual_price from voice_flea_private.voice_iap_orders where id=requested_order and state='prepared';
  if not found then
   select seller_id,product_id,environment,case plan when 'silver' then 300 when 'gold' then 800 when 'platinum' then 1500 end into actual_owner,actual_sku,actual_env,actual_price from voice_flea_private.boost_orders where id=requested_order and state='pending';
  end if;
  if actual_owner is distinct from actor or actual_sku is distinct from sku or actual_env is distinct from tx_environment or actual_price is distinct from price_jpy then raise exception 'Order mismatch'; end if;
  -- No idempotent re-entry into the charge phase. A lost begin response remains
  -- unresolved, not an invitation to open a second StoreKit confirmation sheet.
  insert into voice_flea_private.native_purchase_attempts(order_id,attempt_nonce,owner_id,product_id,environment,amount_jpy,state) values(requested_order,requested_nonce,actor,sku,tx_environment,price_jpy,'pending')
  on conflict(order_id) do update set state='pending',attempt_nonce=requested_nonce,updated_at=now() where native_purchase_attempts.state='cancelled' and native_purchase_attempts.owner_id=actor and native_purchase_attempts.product_id=sku and native_purchase_attempts.environment=tx_environment and native_purchase_attempts.amount_jpy=price_jpy;
  if not found then raise exception 'Attempt unresolved'; end if;
 elsif operation in ('cancel','settle','finish','defer_finish') then
  select * into a from voice_flea_private.native_purchase_attempts where order_id=requested_order for update;
  if not found then
   if operation='settle' then return jsonb_build_object('settled',true); end if;
   raise exception 'Attempt missing';
  end if;
  if a.owner_id is distinct from actor or a.product_id is distinct from sku or a.environment is distinct from tx_environment or a.amount_jpy is distinct from price_jpy then raise exception 'Attempt mismatch'; end if;
  if operation='cancel' then
   -- Neither a JWT nor the returned generation nonce proves Apple cancellation.
   raise exception 'Cancellation requires independent reconciliation';
  elsif operation in ('finish','defer_finish') then
   if requested_nonce is null or a.attempt_nonce is distinct from requested_nonce or a.transaction_id is distinct from tx_id or a.state not in ('granted','applied_finish_uncertain','finished') then raise exception 'Finish evidence mismatch'; end if;
   update voice_flea_private.native_purchase_attempts set state=case when state='finished' or operation='finish' then 'finished' else 'applied_finish_uncertain' end,updated_at=now() where order_id=requested_order;
  else
   if requested_signed is null or length(requested_signed)>30000 then raise exception 'Signed evidence required'; end if;
   if tx_id is null or tx_id!~'^[0-9]{1,40}$' or (a.transaction_id is not null and a.transaction_id<>tx_id) then raise exception 'Transaction mismatch'; end if;
   update voice_flea_private.native_purchase_attempts set state=case when state in ('finished','applied_finish_uncertain') then state else 'granted' end,transaction_id=tx_id,signed_transaction=requested_signed,updated_at=now() where order_id=requested_order;
  end if;
 else raise exception 'Unknown operation'; end if;
 return jsonb_build_object('accepted',true,'attemptNonce',case when operation='settle' then a.attempt_nonce else requested_nonce end);
end $$;
revoke all on function public.native_purchase_attempt(uuid,text,uuid,text,text,integer,text,uuid,text) from public,anon,authenticated;
grant execute on function public.native_purchase_attempt(uuid,text,uuid,text,text,integer,text,uuid,text) to service_role;

-- 'finished' records an owner acknowledgement, NOT independent Apple finish evidence.
-- 'applied_finish_uncertain' releases only an already durably applied purchase,
-- retaining signed proof and transaction identity for future finish reconciliation.
-- Do not remove login access while an Apple approval or finish is unresolved.
create function voice_flea_private.guard_native_purchase_account_deletion()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,16));
 if exists(select 1 from voice_flea_private.native_purchase_attempts where owner_id=new.user_id and state in ('pending','granted')) then
  raise exception 'Unresolved Apple purchase; reconcile before account deletion';
 end if;
 return new;
end $$;
revoke all on function voice_flea_private.guard_native_purchase_account_deletion() from public,anon,authenticated;
create trigger guard_native_purchase_account_deletion before insert or update on voice_flea_private.account_deletions
for each row execute function voice_flea_private.guard_native_purchase_account_deletion();
