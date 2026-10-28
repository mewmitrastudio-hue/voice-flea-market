-- Channel-specific evidence: an Apple receipt is not a Stripe reconciliation.
-- This is a display aggregate, never authority to transfer or pay out funds.
create or replace function public.seller_finance_summary()
returns jsonb language sql stable security invoker set search_path = '' as $$
 with evidence as (
  select p.*,
   (p.payment_channel='web' and p.stripe_livemode is not null
    and p.stripe_reconciled_at is not null and p.refunded_amount_jpy is not null) as web_verified,
   (p.payment_channel='ios' and p.apple_environment in ('Sandbox','Production')
    and p.apple_verified_at is not null and p.refunded_amount_jpy is not null) as apple_verified
  from public.payments p where auth.uid() is not null and p.seller_id=auth.uid()
   and p.status in ('paid','refunded','partially_refunded')
 )
 select jsonb_build_object(
  'count',count(*) filter(where web_verified and stripe_livemode is true
   and status='paid' and refunded_amount_jpy=0 and seller_amount_jpy is not null),
  'payout',coalesce(sum(seller_amount_jpy) filter(where web_verified and stripe_livemode is true
   and status='paid' and refunded_amount_jpy=0 and seller_amount_jpy is not null),0),
  'unverified',count(*) filter(where not coalesce(web_verified or apple_verified,false)),
  'test',count(*) filter(where (payment_channel='web' and stripe_livemode is false)
   or (payment_channel='ios' and apple_environment='Sandbox')),
  'adjusting',count(*) filter(where status in ('refunded','partially_refunded')),
  'apple_settlement_pending',count(*) filter(where apple_verified and apple_environment='Production'
   and status='paid' and refunded_amount_jpy=0)
 ) from evidence;
$$;
revoke all on function public.seller_finance_summary() from public,anon;
grant execute on function public.seller_finance_summary() to authenticated;
