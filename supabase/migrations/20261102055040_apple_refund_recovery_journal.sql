-- A verified full buyer refund permits recovery of the original seller
-- transfer, but does not prove the financial adjustment or bank reconciliation.
create table voice_flea_private.apple_settlement_recoveries (
 id uuid primary key default gen_random_uuid(),
 operation_id uuid not null unique references voice_flea_private.apple_settlement_operations(id),
 transfer_id text not null check(transfer_id ~ '^tr_[A-Za-z0-9]+$'),
 amount_jpy bigint not null check(amount_jpy>0),
 previously_reversed_jpy bigint not null check(previously_reversed_jpy>=0),
 state text not null default 'dispatching' check(state in ('dispatching','recovered')),
 reversal_id text unique check(reversal_id ~ '^trr_[A-Za-z0-9]+$'),
 claimed_at timestamptz not null default clock_timestamp(),observed_at timestamptz,
 check((state='dispatching' and reversal_id is null) or (state='recovered' and reversal_id is not null))
);
alter table voice_flea_private.apple_settlement_recoveries enable row level security;
revoke all on voice_flea_private.apple_settlement_recoveries from public,anon,authenticated;
grant select on voice_flea_private.apple_settlement_recoveries to service_role;

create function voice_flea_private.claim_apple_recovery(operation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments;o voice_flea_private.apple_settlement_operations;r voice_flea_private.apple_settlement_recoveries;
begin
 select p0.* into p from public.payments p0 join voice_flea_private.apple_settlement_operations s on s.payment_id=p0.id where s.id=operation for update of p0;
 if not found then raise exception 'Operation missing' using errcode='22023';end if;
 select * into o from voice_flea_private.apple_settlement_operations where id=operation for update;
 if exists(select 1 from voice_flea_private.apple_settlement_recoveries where operation_id=o.id) then
 raise exception 'Recovery already claimed; reconcile only' using errcode='55000';end if;
 if p.payment_channel is distinct from 'ios' or p.apple_environment is distinct from 'Production'
 or p.apple_verified_at is null or not coalesce(voice_flea_private.verified_voice_refund(p),false)
 or p.refunded_amount_jpy is distinct from p.amount_jpy
 or o.state not in ('transferred','partially_reversed') or o.transfer_id is null
 or o.reversed_jpy>=o.amount_jpy then raise exception 'Verified full refund and transfer required' using errcode='42501';end if;
 insert into voice_flea_private.apple_settlement_recoveries(operation_id,transfer_id,amount_jpy,previously_reversed_jpy)
 values(o.id,o.transfer_id,o.amount_jpy-o.reversed_jpy,o.reversed_jpy) returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function voice_flea_private.claim_apple_recovery(uuid) from public,anon,authenticated;
grant execute on function voice_flea_private.claim_apple_recovery(uuid) to service_role;
create function public.claim_apple_recovery(operation uuid)
returns jsonb language sql security invoker set search_path='' as $$select voice_flea_private.claim_apple_recovery(operation)$$;
revoke all on function public.claim_apple_recovery(uuid) from public,anon,authenticated;
grant execute on function public.claim_apple_recovery(uuid) to service_role;

create function voice_flea_private.record_apple_recovery(operation uuid,evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o voice_flea_private.apple_settlement_operations;r voice_flea_private.apple_settlement_recoveries;rid text;
begin
 perform 1 from public.payments p join voice_flea_private.apple_settlement_operations s on s.payment_id=p.id where s.id=operation for update of p;
 select * into o from voice_flea_private.apple_settlement_operations where id=operation for update;
 select * into r from voice_flea_private.apple_settlement_recoveries where operation_id=operation for update;
 if not found then raise exception 'Recovery claim required' using errcode='55000';end if;
 rid=evidence->>'id';
 if evidence->>'object' is distinct from 'transfer_reversal' or rid is null or rid !~ '^trr_[A-Za-z0-9]+$'
 or evidence->>'transfer' is distinct from r.transfer_id or evidence->>'currency' is distinct from 'jpy'
 or evidence->'amount' is distinct from to_jsonb(r.amount_jpy)
 or evidence->'metadata'->>'apple_recovery_id' is distinct from r.id::text
 or evidence->'metadata'->>'apple_settlement_id' is distinct from o.id::text
 or (r.reversal_id is not null and r.reversal_id is distinct from rid)
 or o.reversed_jpy<r.previously_reversed_jpy+r.amount_jpy
 then raise exception 'Recovery evidence mismatch' using errcode='22023';end if;
 update voice_flea_private.apple_settlement_recoveries set state='recovered',reversal_id=rid,observed_at=clock_timestamp()
 where id=r.id returning * into r;
 -- Never clear adjustment_required here: report debits and bank evidence
 -- are independent of the buyer refund and Stripe balance recovery.
 return to_jsonb(r);
end $$;
revoke all on function voice_flea_private.record_apple_recovery(uuid,jsonb) from public,anon,authenticated;
grant execute on function voice_flea_private.record_apple_recovery(uuid,jsonb) to service_role;
create function public.record_apple_recovery(operation uuid,evidence jsonb)
returns jsonb language sql security invoker set search_path='' as $$select voice_flea_private.record_apple_recovery(operation,evidence)$$;
revoke all on function public.record_apple_recovery(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_apple_recovery(uuid,jsonb) to service_role;
