-- Local candidate only. Does not enable any product or change financial settlement.
-- Old pending orders with NULL environment remain recoverable by Apple-signed
-- receipts. New quotes use a separate RPC and bind environment before purchase.
-- Keep any legacy global uniqueness constraints; add explicit scoped guards.
-- Existing conflicting rows must be investigated, never silently rewritten.
create unique index if not exists boost_orders_environment_transaction_unique
 on voice_flea_private.boost_orders(environment,transaction_id) where transaction_id is not null;
create unique index if not exists listing_boosts_environment_transaction_unique
 on public.listing_boosts(environment,apple_transaction_id) where apple_transaction_id is not null;

CREATE OR REPLACE FUNCTION public.prepare_boost_order_in_environment(owner_id uuid, listing uuid, tier text, tx_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare order_id uuid; product text; days integer; price integer; begin
 if tx_environment is null or tx_environment not in ('Sandbox','Production') then raise exception 'Invalid environment'; end if;
 if owner_id is null or listing is null or tier is null or tier not in ('silver','gold','platinum') then raise exception 'Invalid plan'; end if;
 perform pg_advisory_xact_lock(hashtextextended(listing::text,72));
 if not voice_flea_private.account_available(owner_id) then raise exception 'Account unavailable'; end if;
 if not exists(select 1 from public.listings where id=listing and seller_id=owner_id and is_active) then raise exception 'Listing unavailable'; end if;
 if exists(select 1 from public.listing_boosts where listing_id=listing and status='active' and environment=tx_environment and ends_at>now()) then raise exception 'Boost already active'; end if;
 product='com.ayuhide.koenofurima.boost.'||tier;
 days=case tier when 'silver' then 3 when 'gold' then 12 else 30 end;
 price=case tier when 'silver' then 300 when 'gold' then 800 else 1500 end;
 -- Reuse the latest pending order for this plan. Retries never create new entitlements.
 select id into order_id from voice_flea_private.boost_orders where seller_id=owner_id and listing_id=listing and plan=tier and state='pending' and environment=tx_environment order by created_at desc limit 1;
 if order_id is null then insert into voice_flea_private.boost_orders(seller_id,listing_id,plan,product_id,environment) values(owner_id,listing,tier,product,tx_environment) returning id into order_id; end if;
 return jsonb_build_object('orderId',order_id,'productId',product,'durationDays',days,'referencePriceJpy',price,'environment',tx_environment);
end $function$
;
CREATE OR REPLACE FUNCTION public.apply_verified_apple_boost(order_id uuid, tx_id text, sku text, tx_environment text, purchased_at timestamp with time zone, revoked boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o voice_flea_private.boost_orders; boost_id uuid; days integer; price integer; start_time timestamptz; end_time timestamptz; begin
 select * into o from voice_flea_private.boost_orders where id=order_id for update;
 if not found or sku is distinct from o.product_id or tx_environment is null or tx_environment not in ('Production','Sandbox') or (o.environment is not null and o.environment<>tx_environment) or tx_id is null or tx_id!~'^[0-9]{1,40}$' or revoked is null or purchased_at is null then raise exception 'Transaction mismatch'; end if;
 if o.transaction_id is not null and o.transaction_id<>tx_id then raise exception 'Order already consumed'; end if;
 if purchased_at<o.created_at-interval '10 minutes' or purchased_at>now()+interval '5 minutes' then raise exception 'Purchase time mismatch'; end if;
 if exists(select 1 from voice_flea_private.boost_orders where transaction_id=tx_id and environment=tx_environment and id<>order_id) then raise exception 'Transaction already assigned'; end if;
 if revoked then
  update voice_flea_private.boost_orders set state='revoked',transaction_id=tx_id,environment=tx_environment where id=order_id;
  update public.listing_boosts set status='cancelled',ends_at=least(ends_at,now()) where apple_transaction_id=tx_id and environment=tx_environment;
  return jsonb_build_object('revoked',true);
 end if;
 if o.state='revoked' then return jsonb_build_object('revoked',true); end if;
 select id,starts_at,ends_at into boost_id,start_time,end_time from public.listing_boosts where apple_transaction_id=tx_id and environment=tx_environment;
 if boost_id is not null then return jsonb_build_object('boostId',boost_id,'startsAt',start_time,'endsAt',end_time,'alreadyApplied',true,'environment',tx_environment); end if;
 perform pg_advisory_xact_lock(hashtextextended(o.listing_id::text,72));
 -- A verified paid transaction is retained even when the listing is no longer public.
 days=case o.plan when 'silver' then 3 when 'gold' then 12 else 30 end;
 price=case o.plan when 'silver' then 300 when 'gold' then 800 else 1500 end;
 select greatest(now(),coalesce(max(ends_at),now())) into start_time from public.listing_boosts where listing_id=o.listing_id and status='active' and environment=tx_environment;
 end_time=start_time+make_interval(days=>days);
 insert into public.listing_boosts(listing_id,seller_id,plan,amount_jpy,duration_days,status,starts_at,ends_at,apple_transaction_id,payment_source,environment)
 values(o.listing_id,o.seller_id,o.plan,price,days,'active',start_time,end_time,tx_id,'apple',tx_environment) returning id into boost_id;
 update voice_flea_private.boost_orders set state='applied',transaction_id=tx_id,environment=tx_environment,applied_at=now() where id=order_id;
 return jsonb_build_object('boostId',boost_id,'startsAt',start_time,'endsAt',end_time,'environment',tx_environment);
end $function$
;
revoke all on function public.prepare_boost_order_in_environment(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.prepare_boost_order_in_environment(uuid,uuid,text,text) to service_role;

create function public.apply_owned_priced_apple_boost(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,revoked boolean,price_milliunits bigint,currency text,actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid;
begin
 select seller_id into owner from voice_flea_private.boost_orders where id=order_id for update;
 if actor is null or owner is distinct from actor then raise exception 'Order owner mismatch'; end if;
 return public.apply_priced_apple_boost(order_id,tx_id,sku,tx_environment,purchased_at,revoked,price_milliunits,currency);
end $$;
revoke all on function public.apply_owned_priced_apple_boost(uuid,text,text,text,timestamptz,boolean,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.apply_owned_priced_apple_boost(uuid,text,text,text,timestamptz,boolean,bigint,text,uuid) to service_role;

-- Reassert the underlying signature-only grant path is service-only, including
-- when rehearsing this migration on a newly initialized local database.
revoke all on function public.apply_verified_apple_boost(uuid,text,text,text,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.apply_verified_apple_boost(uuid,text,text,text,timestamptz,boolean) to service_role;
