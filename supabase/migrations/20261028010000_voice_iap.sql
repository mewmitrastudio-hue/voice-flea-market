-- Ordinary voice purchases are distinct from boosts. A verified Apple receipt
-- identifies one immutable order, payment and conversation. Never fake Stripe
-- reconciliation or estimate Apple's net proceeds to make an iOS sale look paid.
alter table public.payments add column payment_channel text not null default 'web'
 check(payment_channel in ('web','ios'));
alter table public.payments add column apple_transaction_id text;
alter table public.payments add column apple_environment text check(apple_environment in ('Sandbox','Production'));
alter table public.payments add column apple_verified_at timestamptz;
alter table public.payments alter column platform_fee_jpy drop not null;
alter table public.payments alter column seller_amount_jpy drop not null;
create unique index payments_apple_transaction on public.payments(apple_environment,apple_transaction_id)
 where apple_transaction_id is not null;
alter table public.payments add constraint payments_channel_evidence check(
 payment_channel='web' and apple_transaction_id is null and apple_verified_at is null and apple_environment is null
 or payment_channel='ios' and stripe_checkout_session_id is null and stripe_payment_intent_id is null
  and stripe_charge_id is null and stripe_livemode is null and stripe_reconciled_at is null
  and apple_transaction_id is not null and apple_transaction_id ~ '^[0-9]{1,40}$' and apple_environment is not null and apple_verified_at is not null
  and platform_fee_jpy is null and seller_amount_jpy is null
 );

-- Products are enabled individually only after App Store Connect configuration
-- and Sandbox verification. No client can create or change the price catalogue.
create table voice_flea_private.voice_iap_products(
 product_id text primary key check(product_id ~ '^com\.ayuhide\.koenofurima\.voice\.jpy[1-9][0-9]{0,7}$'),
 amount_jpy integer not null unique check(amount_jpy between 50 and 99999999),
 sandbox_enabled boolean not null default false,
 production_enabled boolean not null default false,
 check(product_id='com.ayuhide.koenofurima.voice.jpy'||amount_jpy::text)
);
insert into voice_flea_private.voice_iap_products(product_id,amount_jpy)
 values('com.ayuhide.koenofurima.voice.jpy1000',1000);
create table voice_flea_private.voice_iap_orders(
 id uuid primary key,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 seller_id uuid not null references auth.users(id) on delete restrict,
 listing_id uuid not null references public.listings(id) on delete restrict,
 product_id text not null references voice_flea_private.voice_iap_products(product_id),
 amount_jpy integer not null check(amount_jpy>=50),
 environment text not null check(environment in ('Sandbox','Production')),
 payment_id uuid unique references public.payments(id),
 transaction_id text,
 state text not null default 'prepared' check(state in ('prepared','paid','revoked')),
 created_at timestamptz not null default now(),
 check(buyer_id<>seller_id),
 unique(environment,transaction_id)
);
alter table voice_flea_private.voice_iap_products enable row level security;
alter table voice_flea_private.voice_iap_orders enable row level security;
revoke all on voice_flea_private.voice_iap_products,voice_flea_private.voice_iap_orders from public,anon,authenticated;
grant select,insert,update on voice_flea_private.voice_iap_products,voice_flea_private.voice_iap_orders to service_role;

create function voice_flea_private.verified_voice_payment(p public.payments)
returns boolean language sql stable security invoker set search_path='' as $$
 select p.status='paid' and p.refunded_amount_jpy=0 and (
  p.payment_channel='web' and p.stripe_reconciled_at is not null and p.stripe_livemode is not null
  or p.payment_channel='ios' and p.apple_verified_at is not null and p.apple_transaction_id is not null
   and p.apple_environment in ('Sandbox','Production'))
$$;
revoke all on function voice_flea_private.verified_voice_payment(public.payments) from public,anon,authenticated;

create function public.prepare_voice_iap_order(owner_id uuid,listing uuid,attempt uuid,tx_environment text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.listings; o voice_flea_private.voice_iap_orders; product voice_flea_private.voice_iap_products;
begin
 if owner_id is null or attempt is null or tx_environment is null or tx_environment not in ('Sandbox','Production')
  or not voice_flea_private.account_available(owner_id) then raise exception 'Purchase unavailable' using errcode='42501';end if;
 -- Same buyer/listing requests serialize, including requests in different tabs.
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text||listing::text,83));
 select * into o from voice_flea_private.voice_iap_orders where id=attempt;
 if found then
  if o.buyer_id<>owner_id or o.listing_id<>listing or o.environment<>tx_environment then
   raise exception 'Order mismatch' using errcode='42501';end if;
  if o.state<>'prepared' then
   return jsonb_build_object('orderId',o.id,'productId',o.product_id,'amountJpy',o.amount_jpy,'environment',o.environment,'state',o.state);
  end if;
 end if;
 select * into l from public.listings where id=listing and is_active for share;
 if not found or l.seller_id=owner_id or not voice_flea_private.account_available(l.seller_id) or exists(
  select 1 from public.user_blocks b where (b.blocker_id=owner_id and b.blocked_user_id=l.seller_id)
   or (b.blocker_id=l.seller_id and b.blocked_user_id=owner_id)) then
  raise exception 'Listing unavailable' using errcode='42501';end if;
 select * into product from voice_flea_private.voice_iap_products where amount_jpy=l.price_jpy
  and case when tx_environment='Production' then production_enabled else sandbox_enabled end;
 if not found then raise exception 'Apple product not ready' using errcode='55000';end if;
 if o.id is not null and (o.product_id<>product.product_id or o.amount_jpy<>l.price_jpy or o.seller_id<>l.seller_id) then
  raise exception 'Order price changed' using errcode='22023';end if;
 -- Reuse the one unconsumed intent so a lost response cannot cause two orders.
 select * into o from voice_flea_private.voice_iap_orders where buyer_id=owner_id and listing_id=listing
  and environment=tx_environment and state='prepared' and product_id=product.product_id and amount_jpy=l.price_jpy
  order by created_at desc limit 1;
 if not found then
  insert into voice_flea_private.voice_iap_orders(id,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment)
  values(attempt,owner_id,l.seller_id,l.id,product.product_id,l.price_jpy,tx_environment) returning * into o;
 end if;
 return jsonb_build_object('orderId',o.id,'productId',o.product_id,'amountJpy',o.amount_jpy,'environment',o.environment,'state',o.state);
end $$;
revoke all on function public.prepare_voice_iap_order(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_voice_iap_order(uuid,uuid,uuid,text) to service_role;

-- Only the Edge function may call this, AFTER signature and current Apple API
-- verification. actor is the logged-in buyer; null is server notification only.
create function public.apply_verified_apple_voice(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,price_milliunits bigint,currency text,revoked boolean,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o voice_flea_private.voice_iap_orders; p public.payments; c public.conversations;
begin
 select * into o from voice_flea_private.voice_iap_orders where id=order_id for update;
 if not found or (actor is not null and actor<>o.buyer_id) or sku is distinct from o.product_id
  or tx_environment is distinct from o.environment or tx_id is null or tx_id !~ '^[0-9]{1,40}$'
  or purchased_at is null or purchased_at<o.created_at-interval '10 minutes' or purchased_at>now()+interval '5 minutes'
  or currency is distinct from 'JPY' or price_milliunits is distinct from o.amount_jpy::bigint*1000
  or revoked is null then raise exception 'Transaction mismatch' using errcode='42501';end if;
 if o.transaction_id is not null and o.transaction_id<>tx_id then raise exception 'Order already consumed' using errcode='23505';end if;
 if o.payment_id is null then
  insert into public.payments(listing_id,buyer_id,seller_id,amount_jpy,platform_fee_jpy,seller_amount_jpy,status,
   payment_channel,apple_transaction_id,apple_environment,apple_verified_at,paid_at,refunded_amount_jpy,refunded_at)
  values(o.listing_id,o.buyer_id,o.seller_id,o.amount_jpy,null,null,case when revoked then 'refunded' else 'paid' end,
   'ios',tx_id,tx_environment,now(),purchased_at,case when revoked then o.amount_jpy else 0 end,case when revoked then now() end)
  returning * into p;
  update voice_flea_private.voice_iap_orders set payment_id=p.id,transaction_id=tx_id,
   state=case when revoked then 'revoked' else 'paid' end where id=o.id;
 else
  select * into p from public.payments where id=o.payment_id for update;
  if revoked or o.state='revoked' then
   update public.payments set status='refunded',refunded_amount_jpy=amount_jpy,
    refunded_at=coalesce(refunded_at,now()),apple_verified_at=now(),updated_at=now() where id=p.id returning * into p;
   update voice_flea_private.voice_iap_orders set state='revoked' where id=o.id;
  end if;
 end if;
 select * into c from public.conversations where payment_id=p.id;
 if c.id is null and p.status='paid' then
  insert into public.conversations(listing_id,buyer_id,seller_id,is_inquiry,payment_id,delivery_status)
  values(o.listing_id,o.buyer_id,o.seller_id,false,p.id,'none') returning * into c;
 end if;
 return jsonb_build_object('paymentId',p.id,'conversationId',c.id,'environment',tx_environment,
  'revoked',p.status='refunded','state',p.status);
end $$;
revoke all on function public.apply_verified_apple_voice(uuid,text,text,text,timestamptz,bigint,text,boolean,uuid) from public,anon,authenticated;
grant execute on function public.apply_verified_apple_voice(uuid,text,text,text,timestamptz,bigint,text,boolean,uuid) to service_role;

create or replace function voice_flea_private.guard_conversation_payment()
returns trigger language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 if tg_op='UPDATE' then
  if new.payment_id is distinct from old.payment_id then raise exception 'Payment association cannot change' using errcode='42501';end if;
  return new;
 end if;
 if new.payment_id is null then return new;end if;
 select * into p from public.payments where id=new.payment_id for share;
 if not found or new.is_inquiry or new.job_id is not null or p.listing_id is distinct from new.listing_id
  or p.buyer_id is distinct from new.buyer_id or p.seller_id is distinct from new.seller_id then
  raise exception 'Payment does not identify this trade' using errcode='42501';end if;
 if not coalesce(voice_flea_private.verified_voice_payment(p),false) then
  raise exception 'Verified paid purchase required' using errcode='42501';end if;
 return new;
end $$;

create or replace function voice_flea_private.guard_linked_payment_fulfillment()
returns trigger language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 if auth.uid() is null then return new;end if;
 if row(new.delivery_path,new.delivery_status,new.delivered_at,new.accepted_at)
  is not distinct from row(old.delivery_path,old.delivery_status,old.delivered_at,old.accepted_at) then return new;end if;
 if new.payment_id is null then raise exception 'Verified payment association required before fulfillment' using errcode='42501';end if;
 select * into p from public.payments where id=new.payment_id for share;
 if not found or p.buyer_id is distinct from new.buyer_id or p.seller_id is distinct from new.seller_id
  or not coalesce(voice_flea_private.verified_voice_payment(p),false) then
  raise exception 'Paid purchase required: refunded or unverified trade cannot proceed' using errcode='42501';end if;
 return new;
end $$;

create or replace function voice_flea_private.open_paid_purchase_conversation(purchase_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments; c public.conversations; actor uuid:=auth.uid();
begin
 if actor is null or not voice_flea_private.account_available(actor) then raise exception 'Sign in required' using errcode='42501';end if;
 select * into p from public.payments where id=purchase_id and buyer_id=actor for update;
 if not found or p.listing_id is null or p.buyer_id=p.seller_id then raise exception 'Purchase unavailable' using errcode='42501';end if;
 if not voice_flea_private.account_available(p.seller_id) or exists(
  select 1 from public.user_blocks b where (b.blocker_id=p.buyer_id and b.blocked_user_id=p.seller_id)
   or (b.blocker_id=p.seller_id and b.blocked_user_id=p.buyer_id)) then raise exception 'Trade unavailable' using errcode='42501';end if;
 select * into c from public.conversations where payment_id=p.id;
 if found then return to_jsonb(c);end if;
 if not coalesce(voice_flea_private.verified_voice_payment(p),false) then raise exception 'Verified paid purchase required' using errcode='42501';end if;
 insert into public.conversations(listing_id,buyer_id,seller_id,is_inquiry,payment_id,delivery_status)
 values(p.listing_id,p.buyer_id,p.seller_id,false,p.id,'none') returning * into c;
 return to_jsonb(c);
end $$;
