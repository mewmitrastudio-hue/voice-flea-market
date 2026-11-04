-- Apple allocations remain liabilities until bank reconciliation is implemented.
-- No migration here creates transfers, changes amounts or releases deletion guards.
create table voice_flea_private.apple_settlement_operations (
 id uuid primary key default gen_random_uuid(),
 payment_id uuid not null unique references voice_flea_private.apple_proceeds_allocations(payment_id),
 seller_id uuid not null, destination text not null check(destination ~ '^acct_[A-Za-z0-9]+$'),
 platform_id text not null check(platform_id ~ '^acct_[A-Za-z0-9]+$' and platform_id<>destination),
 amount_jpy bigint not null check(amount_jpy>0), currency text not null default 'jpy' check(currency='jpy'),
 livemode boolean not null default true check(livemode),
 state text not null default 'prepared' check(state in ('prepared','dispatching','transferred','partially_reversed','reversed')),
 transfer_id text unique check(transfer_id ~ '^tr_[A-Za-z0-9]+$'),
 reversed_jpy bigint not null default 0 check(reversed_jpy>=0 and reversed_jpy<=amount_jpy),
 created_by uuid not null,created_at timestamptz not null default clock_timestamp(),
 dispatched_at timestamptz,observed_at timestamptz,
 check((state in ('prepared','dispatching') and transfer_id is null and reversed_jpy=0) or
       (state='transferred' and transfer_id is not null and reversed_jpy=0) or
       (state='partially_reversed' and transfer_id is not null and reversed_jpy>0 and reversed_jpy<amount_jpy) or
       (state='reversed' and transfer_id is not null and reversed_jpy=amount_jpy))
);
alter table voice_flea_private.apple_settlement_operations enable row level security;
revoke all on voice_flea_private.apple_settlement_operations from public,anon,authenticated;
grant select on voice_flea_private.apple_settlement_operations to service_role;

create function voice_flea_private.prepare_apple_settlement(purchase uuid,platform text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments;a voice_flea_private.apple_proceeds_allocations;o voice_flea_private.apple_settlement_operations;dest text;
begin
 if auth.uid() is null or not voice_flea_private.account_available(auth.uid()) or not voice_flea_private.is_moderator() then raise exception 'Operator required' using errcode='42501';end if;
 select * into p from public.payments where id=purchase for update;
 if not found then raise exception 'Payment missing' using errcode='22023';end if;
 select * into o from voice_flea_private.apple_settlement_operations where payment_id=purchase;
 if found then
 if o.platform_id is distinct from platform then raise exception 'Platform mismatch' using errcode='22023';end if;
 return to_jsonb(o);end if;
 select * into a from voice_flea_private.apple_proceeds_allocations where payment_id=purchase for update;
 if not found or a.state<>'allocated_unpaid' or a.seller_id is distinct from p.seller_id or a.seller_amount_jpy<=0
 or p.payment_channel is distinct from 'ios' or p.apple_environment is distinct from 'Production'
 or p.apple_verified_at is null or p.status is distinct from 'paid' or p.refunded_amount_jpy is distinct from 0
 or not exists(select 1 from public.conversations c where c.payment_id=p.id and not c.is_inquiry and c.delivery_status='accepted')
 or not voice_flea_private.account_available(p.seller_id)
 then raise exception 'Eligible Apple allocation required' using errcode='42501';end if;
 select stripe_account_id into dest from public.profiles where id=p.seller_id;
 if dest is null or dest !~ '^acct_[A-Za-z0-9]+$' or platform is null or platform !~ '^acct_[A-Za-z0-9]+$' or dest=platform then raise exception 'Recipient required' using errcode='22023';end if;
 insert into voice_flea_private.apple_settlement_operations(payment_id,seller_id,destination,platform_id,amount_jpy,created_by)
 values(p.id,p.seller_id,dest,platform,a.seller_amount_jpy,auth.uid()) returning * into o;
 return to_jsonb(o);
end $$;
revoke all on function voice_flea_private.prepare_apple_settlement(uuid,text) from public,anon;
grant execute on function voice_flea_private.prepare_apple_settlement(uuid,text) to authenticated;
create function public.prepare_apple_settlement(purchase uuid,platform text)
returns jsonb language sql security invoker set search_path='' as $$select voice_flea_private.prepare_apple_settlement(purchase,platform)$$;
revoke all on function public.prepare_apple_settlement(uuid,text) from public,anon;
grant execute on function public.prepare_apple_settlement(uuid,text) to authenticated;

-- One dispatch only, even if Stripe's idempotency key has expired. All later
-- calls reconcile the same transfer ID; they cannot authorize a new transfer.
create function voice_flea_private.claim_apple_settlement(operation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments;a voice_flea_private.apple_proceeds_allocations;o voice_flea_private.apple_settlement_operations;
begin
 select p0.* into p from public.payments p0 join voice_flea_private.apple_settlement_operations s on s.payment_id=p0.id where s.id=operation for update of p0;
 if not found then raise exception 'Operation missing' using errcode='22023';end if;
 select * into a from voice_flea_private.apple_proceeds_allocations where payment_id=p.id for update;
 select * into o from voice_flea_private.apple_settlement_operations where id=operation for update;
 if o.state<>'prepared' then raise exception 'Reconciliation required; dispatch already claimed' using errcode='55000';end if;
 if a.state is distinct from 'allocated_unpaid' or a.seller_id is distinct from o.seller_id or a.seller_amount_jpy is distinct from o.amount_jpy
 or p.seller_id is distinct from o.seller_id or p.status is distinct from 'paid' or p.refunded_amount_jpy is distinct from 0
 or p.payment_channel is distinct from 'ios' or p.apple_environment is distinct from 'Production' or p.apple_verified_at is null
 or not voice_flea_private.account_available(o.seller_id)
 or not exists(select 1 from public.conversations c where c.payment_id=p.id and not c.is_inquiry and c.delivery_status='accepted')
 or not exists(select 1 from public.profiles where id=o.seller_id and stripe_account_id=o.destination)
 then raise exception 'Settlement frozen or recipient changed' using errcode='42501';end if;
 update voice_flea_private.apple_settlement_operations set state='dispatching',dispatched_at=clock_timestamp() where id=operation returning * into o;
 return to_jsonb(o);
end $$;
revoke all on function voice_flea_private.claim_apple_settlement(uuid) from public,anon,authenticated;
grant execute on function voice_flea_private.claim_apple_settlement(uuid) to service_role;
create function public.claim_apple_settlement(operation uuid)
returns jsonb language sql security invoker set search_path='' as $$select voice_flea_private.claim_apple_settlement(operation)$$;
revoke all on function public.claim_apple_settlement(uuid) from public,anon,authenticated;
grant execute on function public.claim_apple_settlement(uuid) to service_role;

-- Accept only freshly retrieved server-side Stripe evidence. Never clear the
-- allocation's adjustment flag, mark bank-paid, or change the Apple payment.
create function voice_flea_private.record_apple_settlement(operation uuid,evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o voice_flea_private.apple_settlement_operations;reversed bigint;tid text;dest text;
begin
 perform 1 from public.payments p join voice_flea_private.apple_settlement_operations s on s.payment_id=p.id where s.id=operation for update of p;
 select * into o from voice_flea_private.apple_settlement_operations where id=operation for update;
 if not found or o.state='prepared' then raise exception 'Dispatch required' using errcode='55000';end if;
 tid=evidence->>'id';dest=case when jsonb_typeof(evidence->'destination')='object' then evidence->'destination'->>'id' else evidence->>'destination' end;
 if evidence->>'object' is distinct from 'transfer' or tid is null or tid !~ '^tr_[A-Za-z0-9]+$'
 or evidence->'livemode' is distinct from 'true'::jsonb or evidence->>'currency' is distinct from 'jpy'
 or evidence->'amount' is distinct from to_jsonb(o.amount_jpy) or dest is distinct from o.destination
 or evidence->'source_transaction' is distinct from 'null'::jsonb
 or evidence->'metadata'->>'apple_settlement_id' is distinct from o.id::text
 or evidence->'metadata'->>'payment_id' is distinct from o.payment_id::text
 or evidence->>'transfer_group' is distinct from 'apple_settlement_'||o.id::text
 or (o.transfer_id is not null and o.transfer_id is distinct from tid)
 or jsonb_typeof(evidence->'amount_reversed') is distinct from 'number'
 or (evidence->>'amount_reversed') !~ '^[0-9]+$'
 then raise exception 'Transfer evidence mismatch' using errcode='22023';end if;
 reversed=(evidence->>'amount_reversed')::bigint;
 if reversed<o.reversed_jpy or reversed>o.amount_jpy or evidence->'reversed' is distinct from to_jsonb(reversed=o.amount_jpy)
 then raise exception 'Reversal evidence mismatch' using errcode='22023';end if;
 update voice_flea_private.apple_settlement_operations set transfer_id=tid,reversed_jpy=reversed,
 state=case when reversed=amount_jpy then 'reversed' when reversed>0 then 'partially_reversed' else 'transferred' end,
 observed_at=clock_timestamp() where id=operation returning * into o;
 if reversed>0 then update voice_flea_private.apple_proceeds_allocations set state='adjustment_required' where payment_id=o.payment_id;end if;
 return to_jsonb(o);
end $$;
revoke all on function voice_flea_private.record_apple_settlement(uuid,jsonb) from public,anon,authenticated;
grant execute on function voice_flea_private.record_apple_settlement(uuid,jsonb) to service_role;
create function public.record_apple_settlement(operation uuid,evidence jsonb)
returns jsonb language sql security invoker set search_path='' as $$select voice_flea_private.record_apple_settlement(operation,evidence)$$;
revoke all on function public.record_apple_settlement(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_apple_settlement(uuid,jsonb) to service_role;

create function voice_flea_private.get_apple_settlement(operation uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(s) from voice_flea_private.apple_settlement_operations s where s.id=operation
$$;
revoke all on function voice_flea_private.get_apple_settlement(uuid) from public,anon,authenticated;
grant execute on function voice_flea_private.get_apple_settlement(uuid) to service_role;
create function public.get_apple_settlement(operation uuid)
returns jsonb language sql stable security invoker set search_path='' as $$select voice_flea_private.get_apple_settlement(operation)$$;
revoke all on function public.get_apple_settlement(uuid) from public,anon,authenticated;
grant execute on function public.get_apple_settlement(uuid) to service_role;
