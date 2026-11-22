-- Seller ratings in browse search (2026-11-22).
-- The "声を探す・購入" grid now shows each seller's rating as "★4.5 (141)"
-- (Coconala-style) on the listing tile. The aggregation mirrors the one the
-- client already computes on the My Page profile: reviews received by the
-- seller (target_user_id = seller), ratings filtered to 1..5, average
-- rounded to 1 decimal, count = number of such reviews. Sellers without
-- reviews get seller_rating_avg = null and seller_review_count = 0, and the
-- tile quietly shows "★ -".
--
-- Definition is identical to 20261122100000_listing_appeal_image.sql except
-- that the matched select gains seller_rating_avg / seller_review_count.
--
-- APPLY ORDER: apply this migration BEFORE (or together with) deploying the
-- client that renders the rating row. The client is backward compatible in
-- the other direction: until this migration runs, RPC rows simply have no
-- rating fields and every tile renders the quiet "★ -" state.

create or replace function public.search_voice_listings_ranked(search_text text default '',page_offset integer default 0,page_size integer default 24,sort_by text default 'recommended',max_price integer default null,max_days integer default null,hide_own boolean default false,hide_purchased boolean default false,selected_id uuid default null,rotation_epoch bigint default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 with matched as materialized (
 select l.id,l.title,l.category,l.description,l.price_jpy,l.delivery_days,l.ai_use,l.sample_path,l.image_path,l.seller_id,l.created_at,
 jsonb_build_object('display_name',p.display_name,'avatar_path',p.avatar_path) as profiles,
 (select b.plan from public.public_active_boosts(array[l.id]) b order by case b.plan when 'platinum' then 3 when 'gold' then 2 when 'silver' then 1 else 0 end desc,b.starts_at desc limit 1) as boost_plan,
 (select round(avg(r.rating)::numeric,1) from public.reviews r where r.target_user_id=l.seller_id and r.rating between 1 and 5) as seller_rating_avg,
 (select count(*) from public.reviews r where r.target_user_id=l.seller_id and r.rating between 1 and 5) as seller_review_count
 from public.listings l left join public.profiles p on p.id=l.seller_id
 where l.is_active and (selected_id is null or l.id=selected_id)
 and (selected_id is not null or nullif(btrim(search_text),'') is null or
 strpos(lower(concat_ws(' ',l.title,l.category,l.description,l.ai_use,p.display_name)),lower(btrim(search_text)))>0)
 and (max_price is null or l.price_jpy<=max_price) and (max_days is null or l.delivery_days<=max_days)
 and (not hide_own or (select auth.uid()) is null or l.seller_id<>(select auth.uid()))
 and (not hide_purchased or not public.is_voice_purchased(l.id))
 ), ranked as (
 select matched.*,row_number() over(partition by boost_plan order by created_at desc,id desc)-1 as rotation_index,
 count(*) over(partition by boost_plan) as tier_count from matched
 ), paged as (
 select * from ranked order by
 case when sort_by='recommended' then case boost_plan when 'platinum' then 3 when 'gold' then 2 when 'silver' then 1 else 0 end else 0 end desc,
 case when sort_by='recommended' and boost_plan is not null then
 mod(mod(rotation_index-coalesce(rotation_epoch,floor(extract(epoch from now())/600)::bigint),tier_count)+tier_count,tier_count) else 0 end asc,
 case when sort_by='price' then price_jpy end asc,
 case when sort_by='delivery' then delivery_days end asc,
 created_at desc,id desc limit greatest(1,least(coalesce(page_size,24),100)) offset greatest(0,coalesce(page_offset,0))
 ) select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(paged)-'rotation_index'-'tier_count') from paged),'[]'::jsonb),'total',(select count(*) from matched),'rotation_epoch',coalesce(rotation_epoch,floor(extract(epoch from now())/600)::bigint))
$$;
revoke all on function public.search_voice_listings_ranked(text,integer,integer,text,integer,integer,boolean,boolean,uuid,bigint) from public;
grant execute on function public.search_voice_listings_ranked(text,integer,integer,text,integer,integer,boolean,boolean,uuid,bigint) to anon,authenticated;
