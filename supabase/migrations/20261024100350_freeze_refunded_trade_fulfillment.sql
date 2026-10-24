-- A refunded/partially-refunded linked payment must not continue fulfillment.
-- Existing history stays readable. No money movement or legacy inference.
create function voice_flea_private.guard_linked_payment_fulfillment()
returns trigger language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 if auth.uid() is null or new.payment_id is null then return new;end if;
 if row(new.delivery_path,new.delivery_status,new.delivered_at,new.accepted_at)
  is not distinct from row(old.delivery_path,old.delivery_status,old.delivered_at,old.accepted_at)
 then return new;end if;
 -- Serialize with reconciliation so a completed refund cannot be overlooked.
 select * into p from public.payments where id=new.payment_id for share;
 if not found or p.status<>'paid' or p.refunded_amount_jpy is distinct from 0
  or p.stripe_reconciled_at is null or p.stripe_livemode is null then
  raise exception 'Paid purchase required: refunded or unverified trade cannot proceed' using errcode='42501';
 end if;
 return new;
end $$;
revoke all on function voice_flea_private.guard_linked_payment_fulfillment() from public,anon,authenticated;
create trigger guard_linked_payment_fulfillment before update on public.conversations
 for each row execute function voice_flea_private.guard_linked_payment_fulfillment();
