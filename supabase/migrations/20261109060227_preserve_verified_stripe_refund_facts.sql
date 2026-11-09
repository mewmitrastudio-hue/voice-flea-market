-- Historical verified evidence is append-only, not a guarantee that a bank cannot later return a refund.
-- Later failure/contradiction requires review and customer remedy; never silently restore paid eligibility.
alter table public.payments add column stripe_refund_fact_review_required boolean not null default false;
alter table voice_flea_private.stripe_refund_operations add column historical_refund_review boolean not null default false;
create table voice_flea_private.stripe_verified_refund_facts(
 operation_id uuid primary key references voice_flea_private.stripe_refund_operations(id),
 payment_id uuid not null unique references public.payments(id),refund_id text not null,
 platform_id text not null,livemode boolean not null,amount_jpy integer not null check(amount_jpy>0),
 expected jsonb not null,evidence jsonb not null,confirmed_at timestamptz not null default clock_timestamp()
);
create table voice_flea_private.stripe_refund_fact_conflicts(
 id bigint generated always as identity primary key,payment_id uuid not null references public.payments(id),
 operation_id uuid not null references voice_flea_private.stripe_refund_operations(id),
 evidence jsonb not null,observed_at timestamptz not null default clock_timestamp()
);
alter table voice_flea_private.stripe_verified_refund_facts enable row level security;
alter table voice_flea_private.stripe_refund_fact_conflicts enable row level security;
revoke all on voice_flea_private.stripe_verified_refund_facts,voice_flea_private.stripe_refund_fact_conflicts from public,anon,authenticated,service_role;
create function voice_flea_private.capture_verified_refund_fact() returns trigger language plpgsql security definer set search_path='' as $$
declare e jsonb;s jsonb;p public.payments;
begin
 if not new.buyer_refund_verified or exists(select 1 from voice_flea_private.stripe_verified_refund_facts where operation_id=new.id) then return new;end if;
 select evidence into e from voice_flea_private.stripe_refund_observations where operation_id=new.id order by id desc limit 1;s=e->'observation';
 select * into p from public.payments where id=new.payment_id;
 if p.status is distinct from 'refunded' or p.refunded_amount_jpy is distinct from p.amount_jpy
 or new.expected is distinct from voice_flea_private.stripe_refund_binding(p)
 or e->>'refund_id' is distinct from new.refund_id or e->>'refund_status' is distinct from 'succeeded'
 or (e->>'refund_amount_jpy')::integer is distinct from p.amount_jpy
 or e->>'refund_currency' is distinct from 'jpy' or e->>'refund_charge_id' is distinct from p.stripe_charge_id or e->>'refund_payment_intent_id' is distinct from p.stripe_payment_intent_id
 or s->>'currency' is distinct from 'jpy' or s->>'stripe_charge_id' is distinct from p.stripe_charge_id or s->>'stripe_payment_intent_id' is distinct from p.stripe_payment_intent_id
 or (s->>'stripe_livemode')::boolean is distinct from new.livemode or (s->>'amount_jpy')::integer is distinct from p.amount_jpy
 or (s->>'refunded_amount_jpy')::integer is distinct from p.amount_jpy or s->'refunded' is distinct from 'true'::jsonb
 then raise exception 'Exact verified refund proof required';end if;
 insert into voice_flea_private.stripe_verified_refund_facts(operation_id,payment_id,refund_id,platform_id,livemode,amount_jpy,expected,evidence)
 values(new.id,p.id,new.refund_id,new.platform_id,new.livemode,p.amount_jpy,new.expected,e);
 return new;
end $$;
create trigger capture_verified_refund_fact after insert or update on voice_flea_private.stripe_refund_operations for each row execute function voice_flea_private.capture_verified_refund_fact();

create function voice_flea_private.guard_verified_refund_fact() returns trigger language plpgsql security definer set search_path='' as $$
declare f voice_flea_private.stripe_verified_refund_facts;
begin
 select * into f from voice_flea_private.stripe_verified_refund_facts where payment_id=old.id;
 if f.operation_id is null then if tg_op='DELETE' then return old;end if;return new;end if;
 if tg_op='DELETE' then raise exception 'Verified refund history must be retained';end if;
 if f.expected is distinct from voice_flea_private.stripe_refund_binding(new) then raise exception 'Verified refund identity cannot change';end if;
 new.stripe_refund_fact_review_required=old.stripe_refund_fact_review_required or new.stripe_refund_fact_review_required;
 if new.refunded_amount_jpy is distinct from f.amount_jpy or new.status is distinct from 'refunded' then
 insert into voice_flea_private.stripe_refund_fact_conflicts(payment_id,operation_id,evidence)
 values(old.id,f.operation_id,jsonb_build_object('kind','payment_snapshot_regression','attempted_status',new.status,'attempted_refunded_amount_jpy',new.refunded_amount_jpy,'stripe_reconciled_at',new.stripe_reconciled_at,'historical_confirmed_amount_jpy',f.amount_jpy));
 new.refunded_amount_jpy=f.amount_jpy;new.status='refunded';new.refunded_at=coalesce(old.refunded_at,f.confirmed_at);new.stripe_refund_fact_review_required=true;
 update voice_flea_private.stripe_refund_operations set state='needs_review',historical_refund_review=true,buyer_refund_verified=false,error_code='historical_refund_evidence_conflict' where id=f.operation_id;
 end if;
 return new;
end $$;
create trigger guard_verified_refund_fact before update or delete on public.payments for each row execute function voice_flea_private.guard_verified_refund_fact();

create function voice_flea_private.guard_refund_fact_operation() returns trigger language plpgsql security definer set search_path='' as $$
declare f voice_flea_private.stripe_verified_refund_facts;
begin
 select * into f from voice_flea_private.stripe_verified_refund_facts where operation_id=old.id;
 if f.operation_id is null then return new;end if;
 if row(new.payment_id,new.platform_id,new.livemode,new.expected,new.parameters,new.idempotency_key,new.refund_id)
 is distinct from row(old.payment_id,old.platform_id,old.livemode,old.expected,old.parameters,old.idempotency_key,old.refund_id) then raise exception 'Verified refund identity cannot change';end if;
 -- Preserve latest provider status, including legitimate failed/requires_action. Historical proof is a separate record.
 if old.historical_refund_review or new.historical_refund_review or not new.buyer_refund_verified or new.refund_status is distinct from 'succeeded'
 or exists(select 1 from public.payments where id=new.payment_id and stripe_refund_fact_review_required) then
 new.historical_refund_review=true;new.buyer_refund_verified=false;new.state='needs_review';new.error_code='historical_refund_evidence_conflict';
 -- Avoid recursively updating the same payment while its BEFORE trigger is handling a snapshot regression.
 if pg_trigger_depth()=1 then update public.payments set stripe_refund_fact_review_required=true where id=new.payment_id and not stripe_refund_fact_review_required;end if;
 end if;
 return new;
end $$;
create trigger guard_refund_fact_operation before update on voice_flea_private.stripe_refund_operations for each row execute function voice_flea_private.guard_refund_fact_operation();
create function voice_flea_private.immutable_verified_refund_fact() returns trigger language plpgsql set search_path='' as $$begin raise exception 'Historical refund evidence is append-only';end $$;
create trigger immutable_verified_refund_fact before update or delete on voice_flea_private.stripe_verified_refund_facts for each row execute function voice_flea_private.immutable_verified_refund_fact();
revoke all on function voice_flea_private.capture_verified_refund_fact(),voice_flea_private.guard_verified_refund_fact(),voice_flea_private.guard_refund_fact_operation(),voice_flea_private.immutable_verified_refund_fact() from public,anon,authenticated,service_role;

-- Keep the original function OID and all existing Apple-specific conditions. Do not make a schema-moving wrapper.
do $$declare definition text;begin
 definition=pg_get_functiondef('voice_flea_private.verified_voice_refund(public.payments)'::regprocedure);
 if position('p.status=''refunded'' and p.refunded_amount_jpy=p.amount_jpy' in definition)=0 then raise exception 'Verified refund predicate requires explicit integration review';end if;
 execute replace(definition,'p.status=''refunded'' and p.refunded_amount_jpy=p.amount_jpy','p.status=''refunded'' and p.refunded_amount_jpy=p.amount_jpy and not p.stripe_refund_fact_review_required');
end $$;

-- Refund webhooks can record a later bank failure even if aggregate charge.refunded has not changed yet.
create function public.get_stripe_refund_operation(refund_id text,intent_id text,live boolean) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(o)||jsonb_build_object('payment',to_jsonb(p)) from voice_flea_private.stripe_refund_operations o join public.payments p on p.id=o.payment_id
 where o.refund_id=$1 and p.stripe_payment_intent_id=$2 and o.livemode=$3 and p.stripe_livemode=$3 and p.payment_channel='web'
$$;
revoke all on function public.get_stripe_refund_operation(text,text,boolean) from public,anon,authenticated;
grant execute on function public.get_stripe_refund_operation(text,text,boolean) to service_role;
-- Preserve the receipt RPC OID and expose the review marker beside the historical amount.
do $$declare definition text;begin
 if to_regprocedure('voice_flea_private.admin_payment_receipts(timestamptz,uuid)') is not null then
 definition=pg_get_functiondef('voice_flea_private.admin_payment_receipts(timestamptz,uuid)'::regprocedure);
 if position('p.stripe_dispute_review_required,p.amount_jpy' in definition)=0 then raise exception 'Admin receipt projection requires explicit integration review';end if;
 execute replace(definition,'p.stripe_dispute_review_required,p.amount_jpy','p.stripe_refund_fact_review_required,p.stripe_dispute_review_required,p.amount_jpy');
 end if;
end $$;
