-- Signed-event/current-read disagreement is evidence, never a new success proof.
alter table voice_flea_private.stripe_refund_operations add column provider_evidence_review boolean not null default false;
create or replace function public.record_stripe_refund_outcome(operation_id uuid,evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o voice_flea_private.stripe_refund_operations;p public.payments;s jsonb:=evidence->'observation';rid text:=evidence->>'refund_id';rs text:=evidence->>'refund_status';verified boolean:=false;code text:=evidence->>'error_code';obs timestamptz;ev jsonb:=evidence->'verified_event';conflict boolean:=coalesce((evidence->>'event_current_conflict')::boolean,false);
begin
 select p0.* into p from public.payments p0 join voice_flea_private.stripe_refund_operations x on x.payment_id=p0.id where x.id=operation_id for update of p0;
 select * into o from voice_flea_private.stripe_refund_operations where id=operation_id for update;
 if o.id is null or o.expected is distinct from voice_flea_private.stripe_refund_binding(p) then raise exception 'Refund operation identity changed';end if;
 if rid is not null and (rid !~ '^re_[A-Za-z0-9]+$' or (o.refund_id is not null and o.refund_id<>rid) or (evidence->>'refund_amount_jpy')::integer is distinct from p.amount_jpy
 or rs is null or rs not in ('succeeded','pending','requires_action','failed','canceled')) then raise exception 'Refund outcome identity mismatch';end if;
 if ev is not null and ev<>'null'::jsonb then
 if ev->>'refund_id' is distinct from rid or ev->>'refund_charge_id' is distinct from p.stripe_charge_id
 or ev->>'refund_payment_intent_id' is distinct from p.stripe_payment_intent_id or ev->>'refund_currency' is distinct from 'jpy'
 or (ev->>'refund_amount_jpy')::integer is distinct from p.amount_jpy or (ev->>'livemode')::boolean is distinct from o.livemode
 or ev->>'refund_status' is null or ev->>'refund_status' not in ('succeeded','pending','requires_action','failed','canceled')
 then raise exception 'Refund event identity mismatch';end if;
 conflict=conflict or ev->>'refund_status' is distinct from rs
 or ev->>'failure_balance_transaction' is distinct from evidence->>'failure_balance_transaction'
 or ev->>'failure_reason' is distinct from evidence->>'failure_reason';
 end if;
 conflict=conflict or o.provider_evidence_review;
 if conflict then code='refund_event_current_conflict';end if;
 if s is not null and s<>'null'::jsonb then
 if s->>'stripe_payment_intent_id' is distinct from p.stripe_payment_intent_id or s->>'stripe_charge_id' is distinct from p.stripe_charge_id
 or (s->>'stripe_livemode')::boolean is distinct from p.stripe_livemode or (s->>'amount_jpy')::integer is distinct from p.amount_jpy
 then raise exception 'Refund observation identity mismatch';end if;
 obs=(s->>'stripe_reconciled_at')::timestamptz;
 -- Financial fact is recorded even under a review hold. No status is forged back to paid.
 if not conflict then perform public.record_stripe_payment_snapshot(s);end if;
 select * into p from public.payments where id=o.payment_id;
 end if;
 insert into voice_flea_private.stripe_refund_observations(operation_id,evidence) values(o.id,evidence);
 -- A delayed/older observation is retained but cannot overwrite newer provider facts.
 if o.observed_at is not null and obs is not null and obs<o.observed_at and not conflict then return to_jsonb(o);end if;
 rid=coalesce(rid,o.refund_id);rs=coalesce(rs,o.refund_status);
 verified=not conflict and rid is not null and rs='succeeded' and (s->>'refunded_amount_jpy')::integer=p.amount_jpy and p.status='refunded' and p.refunded_amount_jpy=p.amount_jpy;
 if rs='succeeded' and not coalesce(verified,false) and code is null then code='refund_reconciliation_pending';end if;
 if p.stripe_dispute_review_required or s->'disputed'='true'::jsonb then code='stripe_dispute_review_required';end if;
 if o.parameter_conflict or code='provider_parameter_conflict' then code='provider_parameter_conflict';end if;
 update voice_flea_private.stripe_refund_operations set refund_id=rid,refund_status=rs,
 provider_evidence_review=conflict,
 buyer_refund_verified=case when conflict then false when obs is not null then coalesce(verified,false) else buyer_refund_verified end,
 state=case when code is null and verified then 'succeeded' when code is null and rs='pending' then 'pending' else 'needs_review' end,
 error_code=coalesce(code,case when rs in ('requires_action','failed','canceled') then 'refund_requires_review' end),
 parameter_conflict=parameter_conflict or coalesce(code='provider_parameter_conflict',false),observed_at=coalesce(obs,observed_at)
 where id=o.id returning * into o;
 return to_jsonb(o);
end $$;

