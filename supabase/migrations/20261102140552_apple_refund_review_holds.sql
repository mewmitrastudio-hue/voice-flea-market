-- Unresolved Apple refund evidence freezes fulfillment and settlement without
-- inventing refunded amounts, liability splits, or a final settlement state.
create table voice_flea_private.apple_refund_review_holds (
 order_id uuid primary key references voice_flea_private.voice_iap_orders(id),
 transaction_id text not null check(transaction_id ~ '^[0-9]{1,40}$'),
 environment text not null check(environment in ('Sandbox','Production')),
 evidence jsonb not null,
 first_observed_at timestamptz not null default clock_timestamp(),
 last_observed_at timestamptz not null default clock_timestamp(),
 unique(environment,transaction_id)
);
alter table voice_flea_private.apple_refund_review_holds enable row level security;
revoke all on voice_flea_private.apple_refund_review_holds from public,anon,authenticated;
grant select on voice_flea_private.apple_refund_review_holds to service_role;
create function voice_flea_private.record_apple_refund_review(order_id uuid,tx_id text,tx_environment text,sku text,price_milliunits bigint,currency text,evidence jsonb,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o voice_flea_private.voice_iap_orders;h voice_flea_private.apple_refund_review_holds;
begin
 select * into o from voice_flea_private.voice_iap_orders where id=$1 for update;
 if not found or (actor is not null and actor<>o.buyer_id) or o.environment is distinct from tx_environment
 or o.product_id is distinct from sku or price_milliunits is distinct from o.amount_jpy::bigint*1000
 or currency is distinct from 'JPY' or tx_id is null or tx_id !~ '^[0-9]{1,40}$'
 or (o.transaction_id is not null and o.transaction_id<>tx_id)
 or evidence->'refundEvidenceVersion' is distinct from '1'::jsonb
 or jsonb_typeof(evidence->'revocationDate') is distinct from 'number'
 or (evidence->>'revocationDate')::numeric<=0
 then raise exception 'Refund review evidence mismatch' using errcode='42501';end if;
 -- Match the same lock used by fulfillment and financial dispatch before hold insertion.
 if o.payment_id is not null then perform 1 from public.payments where id=o.payment_id for update;end if;
 select * into h from voice_flea_private.apple_refund_review_holds where apple_refund_review_holds.order_id=o.id;
 if found and (h.transaction_id<>tx_id or h.environment<>tx_environment) then raise exception 'Refund review identity mismatch' using errcode='42501';end if;
 insert into voice_flea_private.apple_refund_review_holds(order_id,transaction_id,environment,evidence)
 values(o.id,tx_id,tx_environment,evidence)
 on conflict on constraint apple_refund_review_holds_pkey do update set last_observed_at=clock_timestamp();
 -- The first evidence is retained. No payment status, refund amount or money changes.
 return jsonb_build_object('reviewRequired',true,'orderId',o.id,'paymentId',o.payment_id);
end $$;
revoke all on function voice_flea_private.record_apple_refund_review(uuid,text,text,text,bigint,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function voice_flea_private.record_apple_refund_review(uuid,text,text,text,bigint,text,jsonb,uuid) to service_role;
create function public.record_apple_refund_review(order_id uuid,tx_id text,tx_environment text,sku text,price_milliunits bigint,currency text,evidence jsonb,actor uuid default null)
returns jsonb language sql security invoker set search_path='' as $$select voice_flea_private.record_apple_refund_review(order_id,tx_id,tx_environment,sku,price_milliunits,currency,evidence,actor)$$;
revoke all on function public.record_apple_refund_review(uuid,text,text,text,bigint,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.record_apple_refund_review(uuid,text,text,text,bigint,text,jsonb,uuid) to service_role;

create function voice_flea_private.apple_refund_review_pending(p public.payments)
returns boolean language sql stable security invoker set search_path='' as $$
 select p.payment_channel='ios' and exists(select 1 from voice_flea_private.apple_refund_review_holds h join voice_flea_private.voice_iap_orders o on o.id=h.order_id where (h.transaction_id=p.apple_transaction_id and h.environment=p.apple_environment) or o.payment_id=p.id)
$$;
revoke all on function voice_flea_private.apple_refund_review_pending(public.payments) from public,anon,authenticated;
create or replace function voice_flea_private.verified_voice_payment(p public.payments)
returns boolean language sql stable security invoker set search_path='' as $$
 select p.status='paid' and p.refunded_amount_jpy=0 and (
 p.payment_channel='web' and p.stripe_reconciled_at is not null and p.stripe_livemode is not null
 or p.payment_channel='ios' and p.apple_verified_at is not null and p.apple_transaction_id is not null
 and p.apple_environment in ('Sandbox','Production') and not voice_flea_private.apple_refund_review_pending(p))
$$;
create or replace function voice_flea_private.verified_voice_refund(p public.payments)
returns boolean language sql stable security invoker set search_path='' as $$
 select p.status='refunded' and p.refunded_amount_jpy=p.amount_jpy and (
 p.payment_channel='web' and p.stripe_reconciled_at is not null and p.stripe_livemode is not null
 or p.payment_channel='ios' and p.apple_verified_at is not null and p.apple_transaction_id is not null
 and p.apple_environment in ('Sandbox','Production') and not voice_flea_private.apple_refund_review_pending(p))
$$;
-- Even paths which inspect payment columns directly must not allocate or dispatch a held purchase.
create function voice_flea_private.guard_apple_financial_review()
returns trigger language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 select * into p from public.payments where id=new.payment_id for share;
 if voice_flea_private.apple_refund_review_pending(p) then raise exception 'Apple refund review required' using errcode='55000';end if;
 return new;
end $$;
revoke all on function voice_flea_private.guard_apple_financial_review() from public,anon,authenticated;
create trigger guard_apple_allocation_review before insert on voice_flea_private.apple_proceeds_allocations for each row execute function voice_flea_private.guard_apple_financial_review();
create trigger guard_apple_dispatch_review before insert or update of state on voice_flea_private.apple_settlement_operations for each row when (new.state in ('prepared','dispatching')) execute function voice_flea_private.guard_apple_financial_review();

create or replace function voice_flea_private.apple_settlement_pending_for_user(target uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from voice_flea_private.apple_refund_review_holds h join voice_flea_private.voice_iap_orders o on o.id=h.order_id where target in (o.buyer_id,o.seller_id))
 or exists(select 1 from voice_flea_private.apple_proceeds_allocations a where a.seller_id=target and a.state in ('allocated_unpaid','adjustment_required'))
 or exists(select 1 from public.payments p where p.seller_id=target and p.payment_channel='ios' and p.apple_environment='Production' and p.status='paid' and not coalesce(voice_flea_private.verified_voice_refund(p),false))
$$;
revoke all on function voice_flea_private.apple_settlement_pending_for_user(uuid) from public,anon,authenticated;

-- Read-only, participant-scoped disclosure; no client release/clear endpoint.
create function voice_flea_private.apple_refund_review_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not voice_flea_private.account_available(auth.uid()) then raise exception 'Sign in required' using errcode='42501';end if;
 return jsonb_build_object('reviewRequired',exists(select 1 from voice_flea_private.apple_refund_review_holds h join voice_flea_private.voice_iap_orders o on o.id=h.order_id where auth.uid() in (o.buyer_id,o.seller_id)),
 'count',(select count(*) from voice_flea_private.apple_refund_review_holds h join voice_flea_private.voice_iap_orders o on o.id=h.order_id where auth.uid() in (o.buyer_id,o.seller_id)));
end $$;
revoke all on function voice_flea_private.apple_refund_review_status() from public,anon;
grant execute on function voice_flea_private.apple_refund_review_status() to authenticated;
create function public.apple_refund_review_status() returns jsonb language sql stable security invoker set search_path='' as $$select voice_flea_private.apple_refund_review_status()$$;
revoke all on function public.apple_refund_review_status() from public,anon;
grant execute on function public.apple_refund_review_status() to authenticated;
