-- Exact source supplied by read-only inventory, 2026-11-09. No secret values.
CREATE OR REPLACE FUNCTION voice_flea_private.refund_auto_claim(provided_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j voice_flea_private.refund_auto_jobs;p public.payments;r voice_flea_private.trade_cancellations;result jsonb:='[]';
begin
 if not exists(select 1 from voice_flea_private.refund_auto_config c join vault.decrypted_secrets v on v.id=c.worker_secret_id where c.enabled and v.decrypted_secret=provided_token) then raise exception 'Refund worker access required' using errcode='42501';end if;
 for j in select * from voice_flea_private.refund_auto_jobs where (state in ('queued','waiting') and next_attempt_at<=now()) or (state='processing' and lease_until<now()) order by created_at,id limit 2 for update skip locked loop
  select * into p from public.payments where id=j.payment_id;
  select * into r from voice_flea_private.trade_cancellations where id=j.cancellation_id;
  if not r.buyer_approved or not r.seller_approved or not exists(select 1 from public.conversations where id=r.conversation_id and payment_id=p.id and delivery_status='none' and delivery_path is null)
   or p.stripe_livemode is null or p.stripe_reconciled_at is null or p.stripe_charge_id is null
   or p.status not in ('paid','refunded') or (p.status='paid' and p.refunded_amount_jpy is distinct from 0)
   or (j.provider_refund_id is null and (j.attempts>=5 or j.first_attempt_at<now()-interval '12 hours'))
   or (j.provider_refund_id is not null and j.first_attempt_at<now()-interval '7 days') then
   update voice_flea_private.refund_auto_jobs set state='needs_review',error_code='eligibility_or_retry_window_changed' where id=j.id;
   update voice_flea_private.trade_cancellations set state='needs_review' where id=r.id;continue;
  end if;
  update voice_flea_private.refund_auto_jobs set state='processing',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()),lease_id=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=j.id returning * into j;
  result=result||jsonb_build_array(jsonb_build_object('id',j.id,'lease_id',j.lease_id,'provider_refund_id',j.provider_refund_id,'payment_id',p.id,'payment_intent_id',p.stripe_payment_intent_id,'charge_id',p.stripe_charge_id,'amount_jpy',p.amount_jpy,'livemode',p.stripe_livemode));
 end loop;return result;
end $function$;
CREATE OR REPLACE FUNCTION public.refund_auto_claim(provided_token text) returns jsonb language sql set search_path='' as $$select voice_flea_private.refund_auto_claim(provided_token)$$;
