-- Do not infer links for legacy records. Each newly linked trade has one payment.
alter table public.conversations add column payment_id uuid references public.payments(id);
create unique index conversations_one_per_payment on public.conversations(payment_id) where payment_id is not null;

create function voice_flea_private.guard_conversation_payment()
returns trigger language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 if tg_op='UPDATE' then
  if new.payment_id is distinct from old.payment_id then
   raise exception 'Payment association cannot change' using errcode='42501';end if;
  -- Existing identity/delivery guards still apply. Permit their FK cleanup paths.
  return new;
 end if;
 if new.payment_id is null then return new;end if;
 select * into p from public.payments where id=new.payment_id;
 if not found or new.is_inquiry or new.job_id is not null
  or p.listing_id is distinct from new.listing_id
  or p.buyer_id is distinct from new.buyer_id or p.seller_id is distinct from new.seller_id then
  raise exception 'Payment does not identify this trade' using errcode='42501';end if;
 if tg_op='INSERT' and (p.status<>'paid' or p.stripe_reconciled_at is null
  or p.stripe_livemode is null or p.refunded_amount_jpy is distinct from 0) then
  raise exception 'Verified paid purchase required' using errcode='42501';end if;
 return new;
end $$;
revoke all on function voice_flea_private.guard_conversation_payment() from public,anon,authenticated;
create trigger guard_conversation_payment before insert or update on public.conversations
 for each row execute function voice_flea_private.guard_conversation_payment();

create function voice_flea_private.open_paid_purchase_conversation(purchase_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments; c public.conversations; actor uuid:=auth.uid();
begin
 if actor is null or not voice_flea_private.account_available(actor) then
  raise exception 'Sign in required' using errcode='42501';end if;
 -- Row lock serializes retries and concurrent tabs against the same purchase.
 select * into p from public.payments where id=purchase_id and buyer_id=actor for update;
 if not found or p.listing_id is null or p.buyer_id=p.seller_id then
  raise exception 'Purchase unavailable' using errcode='42501';end if;
 if not voice_flea_private.account_available(p.seller_id) or exists(
  select 1 from public.user_blocks b where (b.blocker_id=p.buyer_id and b.blocked_user_id=p.seller_id)
   or (b.blocker_id=p.seller_id and b.blocked_user_id=p.buyer_id)) then
  raise exception 'Trade unavailable' using errcode='42501';end if;
 select * into c from public.conversations where payment_id=p.id;
 if found then return to_jsonb(c);end if;
 if p.status<>'paid' or p.stripe_reconciled_at is null or p.stripe_livemode is null
  or p.refunded_amount_jpy is distinct from 0 then
  raise exception 'Verified paid purchase required' using errcode='42501';end if;
 insert into public.conversations(listing_id,buyer_id,seller_id,is_inquiry,payment_id,delivery_status)
 values(p.listing_id,p.buyer_id,p.seller_id,false,p.id,'none') returning * into c;
 return to_jsonb(c);
end $$;
revoke all on function voice_flea_private.open_paid_purchase_conversation(uuid) from public,anon;
grant execute on function voice_flea_private.open_paid_purchase_conversation(uuid) to authenticated;
create function public.open_paid_purchase_conversation(purchase_id uuid)
returns jsonb language sql security invoker set search_path='' as $$
 select voice_flea_private.open_paid_purchase_conversation(purchase_id)
$$;
revoke all on function public.open_paid_purchase_conversation(uuid) from public,anon;
grant execute on function public.open_paid_purchase_conversation(uuid) to authenticated;

-- Approved 2026-10-24: Web 85/15; iOS 85/15 after actual Apple commission.
-- This arithmetic is not a payout authorization or proof of Apple proceeds.
create function voice_flea_private.voice_fee_allocation(gross_jpy bigint,channel text,apple_fee_jpy bigint default null)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare basis bigint; fee bigint;
begin
 if gross_jpy is null or gross_jpy<0 or gross_jpy>2147483647 or channel is null or channel not in ('web','ios') then
  raise exception 'Invalid fee inputs' using errcode='22023';end if;
 if channel='web' then
  if apple_fee_jpy is not null then raise exception 'Unexpected Apple fee for Web' using errcode='22023';end if;
  basis=gross_jpy;
 elsif apple_fee_jpy is null then
  return jsonb_build_object('policy','2026-10-24-v1','state','apple_fee_unconfirmed','basis_jpy',null,'platform_fee_jpy',null,'seller_amount_jpy',null);
 else
  if apple_fee_jpy<0 or apple_fee_jpy>gross_jpy then raise exception 'Invalid Apple fee' using errcode='22023';end if;
  basis=gross_jpy-apple_fee_jpy;
 end if;
 fee=round(basis::numeric*15/100)::bigint;
 return jsonb_build_object('policy','2026-10-24-v1','state','allocated','basis_jpy',basis,
  'platform_fee_jpy',fee,'seller_amount_jpy',basis-fee);
end $$;
revoke all on function voice_flea_private.voice_fee_allocation(bigint,text,bigint) from public,anon,authenticated;
grant execute on function voice_flea_private.voice_fee_allocation(bigint,text,bigint) to service_role;
