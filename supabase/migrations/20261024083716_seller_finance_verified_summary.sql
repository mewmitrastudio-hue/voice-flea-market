-- Match the existing Checkout minimum. Existing rows were checked before rollout.
alter table public.listings add constraint listings_checkout_minimum_price check(price_jpy>=50);

-- An owner-scoped invoker aggregate respects the existing account and payment RLS.
create function public.seller_finance_summary()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'count',count(*) filter(where p.status='paid' and p.stripe_livemode is true
      and p.stripe_reconciled_at is not null and p.refunded_amount_jpy=0),
    'payout',coalesce(sum(p.seller_amount_jpy) filter(where p.status='paid' and p.stripe_livemode is true
      and p.stripe_reconciled_at is not null and p.refunded_amount_jpy=0),0),
    'unverified',count(*) filter(where p.stripe_livemode is null or p.stripe_reconciled_at is null or p.refunded_amount_jpy is null),
    'test',count(*) filter(where p.stripe_livemode is false),
    'adjusting',count(*) filter(where p.status in ('refunded','partially_refunded'))
  ) from public.payments p where auth.uid() is not null and p.seller_id=auth.uid()
    and p.status in ('paid','refunded','partially_refunded');
$$;
revoke all on function public.seller_finance_summary() from public,anon;
grant execute on function public.seller_finance_summary() to authenticated;
