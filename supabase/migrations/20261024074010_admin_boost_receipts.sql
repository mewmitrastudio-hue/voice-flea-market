-- Financial receipts stay behind the existing operator allowlist.
-- Public RPC is invoker-only; private implementation checks the caller again.
create or replace function voice_flea_private.admin_boost_receipts(
  before_created timestamptz default null, before_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare summary jsonb; recent jsonb; has_more boolean;
begin
  if auth.uid() is null or voice_flea_private.is_moderator() is not true then
    raise exception 'Operator access required' using errcode = '42501';
  end if;
  if (before_created is null) <> (before_id is null) then
    raise exception 'Incomplete cursor' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.environment), '[]'::jsonb) into summary
  from (
    select b.environment, count(*) as confirmed_count,
      count(*) filter (where b.status='cancelled') as cancelled_count,
      count(*) filter (where b.status='active' and b.starts_at<=now() and b.ends_at>now()) as effective_count,
      coalesce(sum(b.amount_jpy) filter (where b.status='active'),0) as valid_reference_amount_jpy
    from public.listing_boosts b
    where b.payment_source='apple' and b.apple_transaction_id is not null
      and b.environment in ('Production','Sandbox') and b.status in ('active','cancelled')
    group by b.environment
  ) s;
  with page as (
    select b.id,b.listing_id,b.seller_id,b.plan,b.amount_jpy as reference_amount_jpy,
      b.duration_days,b.status,b.environment,b.created_at,b.starts_at,b.ends_at,
      b.apple_transaction_id,l.title as listing_title
    from public.listing_boosts b left join public.listings l on l.id=b.listing_id
    where b.payment_source='apple' and b.apple_transaction_id is not null
      and b.environment in ('Production','Sandbox') and b.status in ('active','cancelled')
      and (before_created is null or (b.created_at,b.id)<(before_created,before_id))
    order by b.created_at desc,b.id desc limit 11
  ), visible as (select * from page order by created_at desc,id desc limit 10)
  select coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc,v.id desc) from visible v),'[]'::jsonb),
    (select count(*)>10 from page) into recent,has_more;
  return jsonb_build_object('summary',summary,'rows',recent,'has_more',has_more);
end;
$$;
revoke all on function voice_flea_private.admin_boost_receipts(timestamptz,uuid) from public,anon;
grant execute on function voice_flea_private.admin_boost_receipts(timestamptz,uuid) to authenticated;

create or replace function public.admin_boost_receipts(
  before_created timestamptz default null, before_id uuid default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select voice_flea_private.admin_boost_receipts(before_created,before_id);
$$;
revoke all on function public.admin_boost_receipts(timestamptz,uuid) from public,anon;
grant execute on function public.admin_boost_receipts(timestamptz,uuid) to authenticated;
