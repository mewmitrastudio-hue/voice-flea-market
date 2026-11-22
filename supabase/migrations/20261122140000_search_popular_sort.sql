-- Popular sort for browse search + home popular strip (2026-11-22).
-- Adds sort_by='popular' to search_voice_listings_ranked and one new
-- returned column, seller_completed_count. The definition is identical
-- to 20261122120000_search_category_filter.sql except for:
--   (1) matched gains
--         seller_completed_count = the seller's conversations with
--         delivery_status='accepted' (buyer-confirmed completions,
--         inquiries excluded)
--   (2) the paged ORDER BY gains three keys used only when
--       sort_by='popular':
--         popularity score = coalesce(seller_rating_avg,0) * seller_review_count  (desc)
--         seller_completed_count (desc)
--         seller_review_count (desc)
--       followed by the existing created_at desc / id desc, so the
--       order is fully deterministic. Boost plans do NOT influence the
--       popular order (that is what 'recommended' is for).
-- The signature is unchanged (category_filter included), so no drop is
-- needed. Unknown sort_by values on older definitions fall through to
-- created_at order, so the client degrades gracefully until this runs.
--
-- APPLY ORDER: apply AFTER 20261122120000_search_category_filter.sql
-- (this definition builds on it). Until applied, the search sort option
-- "人気順" behaves like newest-first and the home popular strip ranks
-- within the newest 100 listings using the rating fields only.

create or replace function public.search_voice_listings_ranked(search_text text default '',page_offset integer default 0,page_size integer default 24,sort_by text default 'recommended',max_price integer default null,max_days integer default null,hide_own boolean default false,hide_purchased boolean default false,selected_id uuid default null,rotation_epoch bigint default null,category_filter text default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 with matched as materialized (
 select l.id,l.title,l.category,l.description,l.price_jpy,l.delivery_days,l.ai_use,l.sample_path,l.image_path,l.seller_id,l.created_at,
 jsonb_build_object('display_name',p.display_name,'avatar_path',p.avatar_path) as profiles,
 (select b.plan from public.public_active_boosts(array[l.id]) b order by case b.plan when 'platinum' then 3 when 'gold' then 2 when 'silver' then 1 else 0 end desc,b.starts_at desc limit 1) as boost_plan,
 (select round(avg(r.rating)::numeric,1) from public.reviews r where r.target_user_id=l.seller_id and r.rating between 1 and 5) as seller_rating_avg,
 (select count(*) from public.reviews r where r.target_user_id=l.seller_id and r.rating between 1 and 5) as seller_review_count,
 (select count(*) from public.conversations c where c.seller_id=l.seller_id and c.delivery_status='accepted' and not c.is_inquiry) as seller_completed_count
 from public.listings l left join public.profiles p on p.id=l.seller_id
 where l.is_active and (selected_id is null or l.id=selected_id)
 and (selected_id is not null or nullif(btrim(search_text),'') is null or
 strpos(lower(concat_ws(' ',l.title,l.category,l.description,l.ai_use,p.display_name)),lower(btrim(search_text)))>0)
 and (max_price is null or l.price_jpy<=max_price) and (max_days is null or l.delivery_days<=max_days)
 and (not hide_own or (select auth.uid()) is null or l.seller_id<>(select auth.uid()))
 and (not hide_purchased or not public.is_voice_purchased(l.id))
 and (category_filter is null or l.category=category_filter)
 ), ranked as (
 select matched.*,row_number() over(partition by boost_plan order by created_at desc,id desc)-1 as rotation_index,
 count(*) over(partition by boost_plan) as tier_count from matched
 ), paged as (
 select * from ranked order by
 case when sort_by='recommended' then case boost_plan when 'platinum' then 3 when 'gold' then 2 when 'silver' then 1 else 0 end else 0 end desc,
 case when sort_by='recommended' and boost_plan is not null then
 mod(mod(rotation_index-coalesce(rotation_epoch,floor(extract(epoch from now())/600)::bigint),tier_count)+tier_count,tier_count) else 0 end asc,
 case when sort_by='popular' then coalesce(seller_rating_avg,0)*seller_review_count end desc,
 case when sort_by='popular' then seller_completed_count end desc,
 case when sort_by='popular' then seller_review_count end desc,
 case when sort_by='price' then price_jpy end asc,
 case when sort_by='delivery' then delivery_days end asc,
 created_at desc,id desc limit greatest(1,least(coalesce(page_size,24),100)) offset greatest(0,coalesce(page_offset,0))
 ) select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(paged)-'rotation_index'-'tier_count') from paged),'[]'::jsonb),'total',(select count(*) from matched),'rotation_epoch',coalesce(rotation_epoch,floor(extract(epoch from now())/600)::bigint))
$$;
revoke all on function public.search_voice_listings_ranked(text,integer,integer,text,integer,integer,boolean,boolean,uuid,bigint,text) from public;
grant execute on function public.search_voice_listings_ranked(text,integer,integer,text,integer,integer,boolean,boolean,uuid,bigint,text) to anon,authenticated;
