-- Active production boosts rank by tier before pagination.
-- Within each tier, rotate the newest-first stable queue every ten minutes.
-- The returned epoch pins the order across additional pages.
-- SECURITY INVOKER retains existing row policies and exposes only public fields.
create or replace function public.search_voice_listings_ranked(search_text text default '',page_offset integer default 0,page_size integer default 24,sort_by text default 'recommended',max_price integer default null,max_days integer default null,hide_own boolean default false,hide_purchased boolean default false,selected_id uuid default null,rotation_epoch bigint default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 with matched as materialized (
 select l.id,l.title,l.category,l.description,l.price_jpy,l.delivery_days,l.ai_use,l.sample_path,l.seller_id,l.created_at,
 jsonb_build_object('display_name',p.display_name,'avatar_path',p.avatar_path) as profiles,
 (select b.plan from public.public_active_boosts(array[l.id]) b order by case b.plan when 'platinum' then 3 when 'gold' then 2 when 'silver' then 1 else 0 end desc,b.starts_at desc limit 1) as boost_plan
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


-- Preserve old clients while new clients pin a rotation epoch across pages.
create or replace function public.search_voice_listings(search_text text default '',page_offset integer default 0,page_size integer default 24,sort_by text default 'recommended',max_price integer default null,max_days integer default null,hide_own boolean default false,hide_purchased boolean default false,selected_id uuid default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 select public.search_voice_listings_ranked(search_text,page_offset,page_size,sort_by,max_price,max_days,hide_own,hide_purchased,selected_id,null)
$$;
revoke all on function public.search_voice_listings(text,integer,integer,text,integer,integer,bool,bool,uuid) from public;
grant execute on function public.search_voice_listings(text,integer,integer,text,integer,integer,bool,bool,uuid) to anon,authenticated;
