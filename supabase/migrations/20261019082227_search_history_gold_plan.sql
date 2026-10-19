-- Gold has never been sold; refuse changing an existing entitlement catalog.
do $$ begin
 if exists(select 1 from public.listing_boosts where plan='gold') or exists(select 1 from voice_flea_private.boost_orders where plan='gold') then
  raise exception 'Existing gold purchases require a versioned product migration';
 end if;
end $$;
alter table public.listing_boosts drop constraint listing_boosts_amount_jpy_check;
alter table public.listing_boosts drop constraint listing_boosts_duration_days_check;
alter table public.listing_boosts drop constraint listing_boosts_check;
alter table public.listing_boosts add constraint listing_boosts_amount_jpy_check check(amount_jpy in (300,800,1500));
alter table public.listing_boosts add constraint listing_boosts_duration_days_check check(duration_days in (3,12,30));
alter table public.listing_boosts add constraint listing_boosts_check check((plan='silver' and amount_jpy=300 and duration_days=3) or (plan='gold' and amount_jpy=800 and duration_days=12) or (plan='platinum' and amount_jpy=1500 and duration_days=30));
do $$ declare f record; definition text; begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('prepare_boost_order','apply_verified_apple_boost') loop
 definition=pg_get_functiondef(f.oid);
 definition=replace(replace(definition, 'when ''gold'' then 7', 'when ''gold'' then 12'),'when ''gold'' then 500','when ''gold'' then 800');
 execute definition;
 end loop;
end $$;

create index if not exists listings_public_created_idx on public.listings(created_at desc,id desc) where is_active;
create index if not exists conversations_buyer_created_idx on public.conversations(buyer_id,created_at desc,id desc) where not is_inquiry;
create index if not exists conversations_seller_created_idx on public.conversations(seller_id,created_at desc,id desc) where not is_inquiry;
create index if not exists boosts_public_active_idx on public.listing_boosts(listing_id,ends_at) where status='active' and environment='Production';

create or replace function public.is_voice_purchased(listing uuid) returns boolean language plpgsql stable security invoker set search_path='' as $$
begin
 if (select auth.uid()) is null then return false; end if;
 return exists(select 1 from public.payments p where p.buyer_id=(select auth.uid()) and p.listing_id=listing and p.status in ('paid','partially_refunded'));
end $$;
revoke all on function public.is_voice_purchased(uuid) from public;
grant execute on function public.is_voice_purchased(uuid) to anon,authenticated;

-- SECURITY INVOKER retains existing row policies and exposes only public fields.
create or replace function public.search_voice_listings(search_text text default '',page_offset integer default 0,page_size integer default 24,sort_by text default 'recommended',max_price integer default null,max_days integer default null,hide_own boolean default false,hide_purchased boolean default false,selected_id uuid default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 with matched as materialized (
 select l.id,l.title,l.category,l.description,l.price_jpy,l.delivery_days,l.ai_use,l.sample_path,l.seller_id,l.created_at,
 jsonb_build_object('display_name',p.display_name,'avatar_path',p.avatar_path) as profiles,
 (select b.plan from public.public_active_boosts(array[l.id]) b order by b.starts_at desc limit 1) as boost_plan
 from public.listings l left join public.profiles p on p.id=l.seller_id
 where l.is_active and (selected_id is null or l.id=selected_id)
 and (selected_id is not null or nullif(btrim(search_text),'') is null or
 strpos(lower(concat_ws(' ',l.title,l.category,l.description,l.ai_use,p.display_name)),lower(btrim(search_text)))>0)
 and (max_price is null or l.price_jpy<=max_price) and (max_days is null or l.delivery_days<=max_days)
 and (not hide_own or (select auth.uid()) is null or l.seller_id<>(select auth.uid()))
 and (not hide_purchased or not public.is_voice_purchased(l.id))
 ), paged as (
 select * from matched order by
 case when sort_by='recommended' then (boost_plan is not null)::integer else 0 end desc,
 case when sort_by='price' then price_jpy end asc,
 case when sort_by='delivery' then delivery_days end asc,
 created_at desc,id desc limit greatest(1,least(coalesce(page_size,24),100)) offset greatest(0,coalesce(page_offset,0))
 ) select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(paged)) from paged),'[]'::jsonb),'total',(select count(*) from matched))
$$;
revoke all on function public.search_voice_listings(text,integer,integer,text,integer,integer,boolean,boolean,uuid) from public;
grant execute on function public.search_voice_listings(text,integer,integer,text,integer,integer,boolean,boolean,uuid) to anon,authenticated;

create or replace function public.search_my_trades(search_text text default '',trade_role text default 'all',trade_kind text default 'all',trade_state text default 'current',page_offset integer default 0,page_size integer default 10)
returns jsonb language sql stable security invoker set search_path='' as $$
 with owned as (
 select c.id,c.created_at,c.delivery_status,c.listing_id,c.job_id,
 coalesce(l.title,j.title,'取引') as title,coalesce(l.price_jpy,j.budget_jpy) as amount_jpy,p.display_name as partner_name,
 (c.delivery_status='accepted' and exists(select 1 from public.reviews r where r.conversation_id=c.id and r.reviewer_id=(select auth.uid()))) as completed,
 coalesce(v.is_hidden,false) as is_hidden,coalesce(v.is_deleted,false) as is_deleted
 from public.conversations c
 left join public.listings l on l.id=c.listing_id
 left join public.jobs j on j.id=c.job_id
 left join public.profiles p on p.id=case when c.buyer_id=(select auth.uid()) then c.seller_id else c.buyer_id end
 left join public.trade_history_visibility v on v.trade_id=c.id::text and v.user_id=(select auth.uid())
 where (select auth.uid()) is not null and ((c.buyer_id=(select auth.uid())) or (c.seller_id=(select auth.uid()))) and not c.is_inquiry
 and (trade_role='all' or (trade_role='buyer' and c.buyer_id=(select auth.uid())) or (trade_role='seller' and c.seller_id=(select auth.uid())))
 and (trade_kind='all' or (trade_kind='listing' and c.listing_id is not null) or (trade_kind='job' and c.job_id is not null))
 ), matched as materialized (
 select * from owned where not is_deleted and
 ((trade_state='current' and not completed) or (trade_state='completed' and completed and not is_hidden) or (trade_state='hidden' and completed and is_hidden) or (trade_state='all' and not is_hidden))
 and (nullif(btrim(search_text),'') is null or strpos(lower(concat_ws(' ',title,partner_name)),lower(btrim(search_text)))>0)
 ), paged as (
 select * from matched order by created_at desc,id desc limit greatest(1,least(coalesce(page_size,10),50)) offset greatest(0,coalesce(page_offset,0))
 ) select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(paged)) from paged),'[]'::jsonb),'total',(select count(*) from matched))
$$;
revoke all on function public.search_my_trades(text,text,text,text,integer,integer) from public,anon;
grant execute on function public.search_my_trades(text,text,text,text,integer,integer) to authenticated;
-- Parties retain the purchased item's title when its public listing is hidden.
create policy listings_read_trade_parties on public.listings for select to authenticated using (exists(select 1 from public.conversations c where c.listing_id=listings.id and (c.buyer_id=(select auth.uid()) or c.seller_id=(select auth.uid())) and not c.is_inquiry));
create policy jobs_read_trade_parties on public.jobs for select to authenticated using (exists(select 1 from public.conversations c where c.job_id=jobs.id and (c.buyer_id=(select auth.uid()) or c.seller_id=(select auth.uid())) and not c.is_inquiry));
