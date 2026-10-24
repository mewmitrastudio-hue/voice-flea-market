-- Unknown legacy values deliberately remain NULL until Stripe is reconciled.
alter table public.payments
  add column stripe_livemode boolean,
  add column stripe_charge_id text,
  add column refunded_amount_jpy integer,
  add column stripe_reconciled_at timestamptz,
  add constraint payments_refunded_amount_check check
    (refunded_amount_jpy between 0 and amount_jpy);

create index payments_receipts_cursor_idx on public.payments(created_at desc,id desc)
  where status in ('paid','refunded','partially_refunded');

-- Called only by the signature-verified webhook after a fresh Stripe GET.
-- INVOKER keeps the service-only write privilege explicit; no RLS bypass API.
create function public.record_stripe_payment_snapshot(snapshot jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  p public.payments;
  amount integer := (snapshot->>'amount_jpy')::integer;
  refunded integer := (snapshot->>'refunded_amount_jpy')::integer;
  live boolean := (snapshot->>'stripe_livemode')::boolean;
  observed timestamptz := (snapshot->>'stripe_reconciled_at')::timestamptz;
  pi text := snapshot->>'stripe_payment_intent_id';
  session_id text := snapshot->>'stripe_checkout_session_id';
  charge_id text := snapshot->>'stripe_charge_id';
begin
  if amount is null or amount<50 or refunded is null or refunded<0 or refunded>amount
    or live is null or observed is null or observed>clock_timestamp()+interval '1 minute'
    or pi is null or pi !~ '^pi_[A-Za-z0-9]+$'
    or charge_id is null or charge_id !~ '^ch_[A-Za-z0-9]+$' then
    raise exception 'Invalid Stripe snapshot' using errcode='22023';
  end if;
  if session_id is not null then
    if session_id !~ '^cs_[A-Za-z0-9_]+$' or snapshot->>'buyer_id' is null
      or snapshot->>'seller_id' is null or snapshot->>'listing_id' is null
      or snapshot->>'paid_at' is null then
      raise exception 'Incomplete purchase snapshot' using errcode='22023';
    end if;
    insert into public.payments(listing_id,buyer_id,seller_id,amount_jpy,
      platform_fee_jpy,seller_amount_jpy,status,stripe_checkout_session_id,
      stripe_payment_intent_id,paid_at)
    values((snapshot->>'listing_id')::uuid,(snapshot->>'buyer_id')::uuid,
      (snapshot->>'seller_id')::uuid,amount,round(amount*0.15),amount-round(amount*0.15),
      'paid',session_id,pi,(snapshot->>'paid_at')::timestamptz)
    on conflict(stripe_payment_intent_id) do nothing;
  end if;
  select * into p from public.payments where stripe_payment_intent_id=pi for update;
  if not found then raise exception 'Purchase snapshot required first' using errcode='P0002';end if;
  if p.amount_jpy<>amount or (p.stripe_livemode is not null and p.stripe_livemode<>live)
    or (p.stripe_charge_id is not null and p.stripe_charge_id<>charge_id)
    or (session_id is not null and (p.stripe_checkout_session_id is distinct from session_id
      or p.buyer_id is distinct from (snapshot->>'buyer_id')::uuid
      or p.seller_id is distinct from (snapshot->>'seller_id')::uuid
      or p.listing_id is distinct from (snapshot->>'listing_id')::uuid)) then
    raise exception 'Stripe snapshot identity mismatch' using errcode='22023';
  end if;
  -- A slow earlier API request cannot overwrite a later reconciliation.
  if p.stripe_reconciled_at is not null and p.stripe_reconciled_at>=observed then return;end if;
  update public.payments set
    stripe_livemode=live,stripe_charge_id=charge_id,refunded_amount_jpy=refunded,
    stripe_reconciled_at=observed,
    status=case when refunded=amount then 'refunded' when refunded>0 then 'partially_refunded' else 'paid' end,
    refunded_at=case when refunded>0 then coalesce(p.refunded_at,observed) else null end,
    updated_at=clock_timestamp()
  where id=p.id;
end $$;
revoke all on function public.record_stripe_payment_snapshot(jsonb) from public,anon,authenticated;
grant execute on function public.record_stripe_payment_snapshot(jsonb) to service_role;

create function voice_flea_private.admin_payment_receipts(
  before_created timestamptz default null,before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare summary jsonb; receipts jsonb; more boolean;
begin
  if auth.uid() is null or not voice_flea_private.is_moderator() then
    raise exception 'Operator access required' using errcode='42501';
  end if;
  if (before_created is null)<>(before_id is null) then
    raise exception 'Incomplete cursor' using errcode='22023';end if;
  select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) into summary from (
    select case when stripe_livemode then 'Production' when not stripe_livemode then 'Test' else 'Unknown' end environment,
      count(*) receipt_count,
      count(*) filter(where refunded_amount_jpy is null or stripe_reconciled_at is null) unreconciled_count,
      coalesce(sum(amount_jpy) filter(where refunded_amount_jpy is not null and stripe_reconciled_at is not null),0) verified_gross_jpy,
      coalesce(sum(refunded_amount_jpy) filter(where stripe_reconciled_at is not null),0) verified_refunds_jpy,
      coalesce(sum(amount_jpy-refunded_amount_jpy) filter(where stripe_reconciled_at is not null),0) verified_retained_jpy
    from public.payments where status in ('paid','refunded','partially_refunded')
    group by 1
  )s;
  with page as (
    select p.id,p.listing_id,l.title listing_title,p.buyer_id,p.seller_id,
      p.amount_jpy,p.refunded_amount_jpy,p.platform_fee_jpy,p.status,p.paid_at,p.created_at,
      p.stripe_payment_intent_id,p.stripe_checkout_session_id,p.stripe_charge_id,p.stripe_reconciled_at,
      case when p.stripe_livemode then 'Production' when not p.stripe_livemode then 'Test' else 'Unknown' end environment
    from public.payments p left join public.listings l on l.id=p.listing_id
    where p.status in ('paid','refunded','partially_refunded')
      and (before_created is null or (p.created_at,p.id)<(before_created,before_id))
    order by p.created_at desc,p.id desc limit 11
  ), visible as (select * from page order by created_at desc,id desc limit 10)
  select (select coalesce(jsonb_agg(to_jsonb(v) order by v.created_at desc,v.id desc),'[]'::jsonb) from visible v),
    (select count(*)>10 from page) into receipts,more;
  return jsonb_build_object('summary',summary,'rows',receipts,'has_more',more);
end $$;
revoke all on function voice_flea_private.admin_payment_receipts(timestamptz,uuid) from public,anon;
grant execute on function voice_flea_private.admin_payment_receipts(timestamptz,uuid) to authenticated;
create function public.admin_payment_receipts(before_created timestamptz default null,before_id uuid default null)
returns jsonb language sql stable security invoker set search_path = ''
as $$select voice_flea_private.admin_payment_receipts(before_created,before_id)$$;
revoke all on function public.admin_payment_receipts(timestamptz,uuid) from public,anon;
grant execute on function public.admin_payment_receipts(timestamptz,uuid) to authenticated;
