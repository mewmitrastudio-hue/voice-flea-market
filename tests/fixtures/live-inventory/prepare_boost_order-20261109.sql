-- Exact current function definition retrieved read-only from tyulybijubckitybgubc on 2026-11-09.
CREATE OR REPLACE FUNCTION public.prepare_boost_order(owner_id uuid, listing uuid, tier text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare order_id uuid; product text; days integer; price integer; begin
 if tier not in ('silver','gold','platinum') then raise exception 'Invalid plan'; end if;
 perform pg_advisory_xact_lock(hashtextextended(listing::text,72));
 if not voice_flea_private.account_available(owner_id) then raise exception 'Account unavailable'; end if;
 if not exists(select 1 from public.listings where id=listing and seller_id=owner_id and is_active) then raise exception 'Listing unavailable'; end if;
 if exists(select 1 from public.listing_boosts where listing_id=listing and status='active' and ends_at>now()) then raise exception 'Boost already active'; end if;
 product='com.ayuhide.koenofurima.boost.'||tier;
 days=case tier when 'silver' then 3 when 'gold' then 12 else 30 end;
 price=case tier when 'silver' then 300 when 'gold' then 800 else 1500 end;
 -- Reuse the latest pending order for this plan. Retries never create new entitlements.
 select id into order_id from voice_flea_private.boost_orders where seller_id=owner_id and listing_id=listing and plan=tier and state='pending' order by created_at desc limit 1;
 if order_id is null then insert into voice_flea_private.boost_orders(seller_id,listing_id,plan,product_id) values(owner_id,listing,tier,product) returning id into order_id; end if;
 return jsonb_build_object('orderId',order_id,'productId',product,'durationDays',days,'referencePriceJpy',price);
end $function$
;
