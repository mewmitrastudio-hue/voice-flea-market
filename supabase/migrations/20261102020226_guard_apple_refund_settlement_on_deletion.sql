-- A buyer refund is not proof that a seller liability/recovery has been settled.
-- Keep the existing paid-Apple guard, and retain every unresolved allocation
-- even after the payment becomes fully refunded. No liability is erased here.
create or replace function voice_flea_private.apple_settlement_pending_for_user(target uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from voice_flea_private.apple_proceeds_allocations a
  where a.seller_id=target and a.state in ('allocated_unpaid','adjustment_required')
 ) or exists(
  select 1 from public.payments p where p.seller_id=target and p.payment_channel='ios'
  and p.apple_environment='Production' and p.status='paid'
  and not coalesce(voice_flea_private.verified_voice_refund(p),false)
 )
$$;
revoke all on function voice_flea_private.apple_settlement_pending_for_user(uuid) from public,anon,authenticated;
