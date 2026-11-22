-- Listing appeal images (2026-11-22).
-- Each listing may carry ONE appeal image (seller photo / AI-generated image),
-- shown large in the "声を探す・購入" browse grid and at the top of the listing
-- detail overlay, Coconala-style. Listings without an image fall back to the
-- seller's profile avatar, then to a default design (client-side).
--
-- APPLY ORDER: apply this migration BEFORE (or together with) deploying the
-- client that ships the appeal-image UI. The browse RPC and the client are
-- backward compatible in the other direction: until this migration runs, RPC
-- rows simply have no image_path and every listing renders the fallback.
--
-- Storage: a NEW public bucket `listing-images` is created instead of reusing
-- `profile-avatars` / `voice-samples`, so image size/MIME limits stay
-- independent from avatars and audio samples. Object paths follow the avatar
-- convention: `<seller auth uid>/<uuid>.<ext>`. The policies below mirror the
-- public-read + owner-folder-write setup used by the existing public buckets;
-- verify at apply time that no same-named policies already exist.

alter table public.listings
  add column if not exists image_path text;

-- Recreate the ranked browse search so rows expose image_path.
-- Definition is identical to 20261021001606_boost_tier_priority.sql except
-- that the matched select gains `l.image_path`.
create or replace function public.search_voice_listings_ranked(search_text text default '',page_offset integer default 0,page_size integer default 24,sort_by text default 'recommended',max_price integer default null,max_days integer default null,hide_own boolean default false,hide_purchased boolean default false,selected_id uuid default null,rotation_epoch bigint default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 with matched as materialized (
 select l.id,l.title,l.category,l.description,l.price_jpy,l.delivery_days,l.ai_use,l.sample_path,l.image_path,l.seller_id,l.created_at,
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

-- Public bucket for appeal images (JPEG/PNG/WebP, 5MB), mirroring the
-- existing public buckets. Public read; writes limited to the owner's folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-images', 'listing-images', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy "listing-images public read"
  on storage.objects for select to public
  using (bucket_id = 'listing-images');

create policy "listing-images owner insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'listing-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "listing-images owner update"
  on storage.objects for update to authenticated
  using (bucket_id = 'listing-images' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'listing-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "listing-images owner delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'listing-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
