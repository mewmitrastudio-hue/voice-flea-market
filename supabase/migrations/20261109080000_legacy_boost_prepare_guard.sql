-- Local rolling-deployment compatibility for the read-only inventoried old
-- service-only 3arg Boost preparation RPC. No environment is invented.
-- Deliberately require the observed legacy definition; deployment against a
-- different/missing historical overload requires a new read-only review.
do $$
declare f oid;
begin
 f=to_regprocedure('public.prepare_boost_order(uuid,uuid,text)');
 if f is null then raise exception 'Inventoried legacy Boost RPC required';end if;
 if (select md5(prosrc) from pg_proc where oid=f)<>'508e6c20ea31af17b35f33d2a00ef0e0' then raise exception 'Legacy Boost RPC definition changed; review before migration';end if;
 if has_function_privilege('anon',f,'EXECUTE') or has_function_privilege('authenticated',f,'EXECUTE')
  or not has_function_privilege('service_role',f,'EXECUTE') then raise exception 'Legacy Boost RPC privileges differ from inventory';end if;
 if to_regprocedure('voice_flea_private.legacy_refund_subject_pending(uuid,text,uuid)') is null
  or to_regclass('voice_flea_private.native_fulfillment_intents') is null then raise exception 'Reviewed native/legacy receipt guards required';end if;
end $$;
-- Exact current function definition retrieved read-only from tyulybijubckitybgubc on 2026-11-09.
CREATE OR REPLACE FUNCTION public.prepare_boost_order(owner_id uuid, listing uuid, tier text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare order_id uuid; product text; days integer; price integer; begin
 if tier not in ('silver','gold','platinum') then raise exception 'Invalid plan'; end if;
 -- Match current environment-aware admission locks and purpose guards.
 -- Any existing v3 intent (including previously fulfilled) remains reserved:
 -- a new same-purpose intent lifecycle is not introduced by this patch.
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,16));
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,913));
 if voice_flea_private.legacy_refund_subject_pending(owner_id,'boost',listing) then raise exception 'APPLE_REFUND_REVIEW_HELD';end if;
 if exists(select 1 from voice_flea_private.native_fulfillment_intents i where i.owner_id=prepare_boost_order.owner_id and i.kind='boost' and i.subject_id=listing) then raise exception 'Use the existing fulfillment intent';end if;
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

revoke all on function public.prepare_boost_order(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_boost_order(uuid,uuid,text) to service_role;
