-- Durable conservative review, not a transfer reversal or settlement ledger.
-- Won/reinstated events deliberately do not release the hold without a separately reviewed policy.
alter table public.payments add column stripe_dispute_review_required boolean not null default false;
create table voice_flea_private.stripe_dispute_events (
 platform_id text not null,livemode boolean not null,event_id text not null,event_type text not null,
 dispute_id text not null,payment_id uuid not null references public.payments(id),
 event_created bigint not null,observed_at timestamptz not null,evidence jsonb not null,
 primary key(platform_id,livemode,event_id)
);
create table voice_flea_private.stripe_dispute_reviews (
 platform_id text not null,livemode boolean not null,dispute_id text not null,
 payment_id uuid not null references public.payments(id),status text not null,
 amount_jpy bigint not null check(amount_jpy>0),evidence_due_by timestamptz,
 observed_at timestamptz not null,transfer_id text,
 known_transfer_ids jsonb not null default '[]'::jsonb,observed_transfer_ids jsonb not null default '[]'::jsonb,transfer_evidence_conflict boolean not null default false,
 primary key(platform_id,livemode,dispute_id)
);
create index stripe_dispute_reviews_payment_idx on voice_flea_private.stripe_dispute_reviews(payment_id);
create index payments_stripe_dispute_buyer_idx on public.payments(buyer_id) where stripe_dispute_review_required;
create index payments_stripe_dispute_seller_idx on public.payments(seller_id) where stripe_dispute_review_required;
alter table voice_flea_private.stripe_dispute_events enable row level security;
alter table voice_flea_private.stripe_dispute_reviews enable row level security;
revoke all on voice_flea_private.stripe_dispute_events,voice_flea_private.stripe_dispute_reviews from public,anon,authenticated;
-- Writes only through the bound transaction below; raw journals never go to clients.
create function voice_flea_private.record_stripe_dispute_observation(snapshot jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare p public.payments; prior voice_flea_private.stripe_dispute_events; r voice_flea_private.stripe_dispute_reviews;
 observed timestamptz:=(snapshot->>'observed_at')::timestamptz; actor uuid;
 known_transfers jsonb; observed_transfers jsonb; transfer_conflict boolean;
begin
 if snapshot->>'event_id' is null or snapshot->>'event_id' !~ '^evt_[A-Za-z0-9]+$'
 or snapshot->>'event_type' is null or snapshot->>'event_type' not in ('charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated')
 or snapshot->>'platform_id' is null or snapshot->>'platform_id' !~ '^acct_[A-Za-z0-9]+$'
 or snapshot->>'dispute_id' is null or snapshot->>'dispute_id' !~ '^dp_[A-Za-z0-9]+$'
 or snapshot->>'charge_id' is null or snapshot->>'charge_id' !~ '^ch_[A-Za-z0-9]+$'
 or snapshot->>'payment_intent_id' is null or snapshot->>'payment_intent_id' !~ '^pi_[A-Za-z0-9]+$'
 or jsonb_typeof(snapshot->'livemode') is distinct from 'boolean'
 or snapshot->>'currency' is distinct from 'jpy' or coalesce((snapshot->>'amount_jpy')::bigint,0)<=0
 or coalesce((snapshot->>'event_created')::bigint,0)<=0 or coalesce(length(snapshot->>'status'),0) not between 1 and 80
 or observed is null or observed>clock_timestamp()+interval '1 minute'
 or (snapshot->>'transfer_id' is not null and snapshot->>'transfer_id' !~ '^tr_[A-Za-z0-9]+$')
 then raise exception 'Invalid dispute snapshot' using errcode='22023';end if;
 -- Resolve the immutable provider identity before metadata; metadata alone cannot select a purchase.
 select * into p from public.payments where stripe_payment_intent_id=snapshot->>'payment_intent_id';
 if not found then raise exception 'Purchase persistence pending' using errcode='P0002';end if;
 -- Same per-account locks as deletion, deterministic order for shared participants.
 for actor in select x from unnest(array[p.buyer_id,p.seller_id]) x order by x loop
 perform pg_advisory_xact_lock(hashtextextended(actor::text,16));end loop;
 select * into p from public.payments where id=p.id for update;
 if p.payment_channel is distinct from 'web' or p.stripe_charge_id is distinct from snapshot->>'charge_id'
 or p.stripe_livemode is distinct from (snapshot->>'livemode')::boolean
 or p.amount_jpy is distinct from (snapshot->>'charge_amount_jpy')::integer
 or p.buyer_id is distinct from (snapshot->>'buyer_id')::uuid or p.seller_id is distinct from (snapshot->>'seller_id')::uuid
 or p.listing_id is distinct from (snapshot->>'listing_id')::uuid or p.job_id is distinct from (snapshot->>'job_id')::uuid
 or p.stripe_destination is distinct from snapshot->>'destination'
 or p.stripe_reconciled_at is null
 then raise exception 'Dispute purchase identity mismatch' using errcode='42501';end if;
 if exists(select 1 from voice_flea_private.stripe_dispute_reviews d where d.payment_id=p.id and (d.platform_id<>snapshot->>'platform_id' or d.livemode<>(snapshot->>'livemode')::boolean)) then raise exception 'Dispute platform binding changed' using errcode='42501';end if;
 select * into prior from voice_flea_private.stripe_dispute_events e where e.platform_id=snapshot->>'platform_id'
 and e.livemode=(snapshot->>'livemode')::boolean and e.event_id=snapshot->>'event_id';
 if found then
 if prior.payment_id<>p.id or prior.dispute_id<>snapshot->>'dispute_id' or prior.event_type<>snapshot->>'event_type'
 or prior.event_created<>(snapshot->>'event_created')::bigint then raise exception 'Dispute replay identity mismatch' using errcode='42501';end if;
 end if;
 select * into r from voice_flea_private.stripe_dispute_reviews d where d.platform_id=snapshot->>'platform_id'
 and d.livemode=(snapshot->>'livemode')::boolean and d.dispute_id=snapshot->>'dispute_id';
 if found and r.payment_id<>p.id then raise exception 'Dispute binding changed' using errcode='42501';end if;
 -- Preserve local receipt provenance separately from the fresh charge observation.
 -- The payment lock also serializes acceptance, so its transfer reference cannot change mid-record.
 select coalesce(jsonb_agg(t.transfer_id order by t.transfer_id),'[]'::jsonb) into known_transfers from (
 select a.transfer_id from voice_flea_private.delivery_acceptances a where a.payment_id=p.id and a.transfer_id is not null
 union select jsonb_array_elements_text(coalesce(r.known_transfer_ids,'[]'::jsonb))) t;
 select jsonb_agg(t.value order by t.value) into observed_transfers from (
 select value from jsonb_array_elements(coalesce(r.observed_transfer_ids,'[]'::jsonb))
 union select coalesce(snapshot->'transfer_id','null'::jsonb)) t;
 transfer_conflict := (jsonb_array_length(known_transfers)>0 and
   (jsonb_array_length(known_transfers)<>1 or known_transfers->>0 is distinct from snapshot->>'transfer_id'))
   or (r.transfer_id is not null and r.transfer_id is distinct from snapshot->>'transfer_id');
 insert into voice_flea_private.stripe_dispute_events values(snapshot->>'platform_id',(snapshot->>'livemode')::boolean,
 snapshot->>'event_id',snapshot->>'event_type',snapshot->>'dispute_id',p.id,(snapshot->>'event_created')::bigint,observed,snapshot || jsonb_build_object('known_transfer_ids',known_transfers,'transfer_evidence_conflict',transfer_conflict))
 on conflict(platform_id,livemode,event_id) do nothing;
 insert into voice_flea_private.stripe_dispute_reviews as current values(snapshot->>'platform_id',(snapshot->>'livemode')::boolean,
 snapshot->>'dispute_id',p.id,snapshot->>'status',(snapshot->>'amount_jpy')::bigint,(snapshot->>'evidence_due_by')::timestamptz,observed,snapshot->>'transfer_id',known_transfers,observed_transfers,transfer_conflict)
 on conflict(platform_id,livemode,dispute_id) do update set
 status=case when current.observed_at<excluded.observed_at then excluded.status else current.status end,
 amount_jpy=case when current.observed_at<excluded.observed_at then excluded.amount_jpy else current.amount_jpy end,
 evidence_due_by=case when current.observed_at<excluded.observed_at then excluded.evidence_due_by else current.evidence_due_by end,
 transfer_id=case when current.observed_at<excluded.observed_at then excluded.transfer_id else current.transfer_id end,
 observed_at=greatest(current.observed_at,excluded.observed_at),known_transfer_ids=excluded.known_transfer_ids,
 observed_transfer_ids=excluded.observed_transfer_ids,
 transfer_evidence_conflict=current.transfer_evidence_conflict or excluded.transfer_evidence_conflict;
 update public.payments set stripe_dispute_review_required=true where id=p.id;
 -- Do not rewrite gross/refund/fee/seller amounts or accepted delivery history.
end $$;
revoke all on function voice_flea_private.record_stripe_dispute_observation(jsonb) from public,anon,authenticated;
grant execute on function voice_flea_private.record_stripe_dispute_observation(jsonb) to service_role;
create function public.record_stripe_dispute_observation(snapshot jsonb) returns void language sql security invoker set search_path=''
as $$select voice_flea_private.record_stripe_dispute_observation(snapshot)$$;
revoke all on function public.record_stripe_dispute_observation(jsonb) from public,anon,authenticated;
grant execute on function public.record_stripe_dispute_observation(jsonb) to service_role;

-- No hold release API. Preserve the financial record even if an unrelated snapshot or cleanup runs.
create function voice_flea_private.guard_stripe_dispute_record() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.stripe_dispute_review_required and (tg_op='DELETE' or new.stripe_dispute_review_required is not true
 or row(new.buyer_id,new.seller_id,new.stripe_payment_intent_id,new.stripe_charge_id,new.stripe_livemode,new.stripe_destination,new.payment_channel)
 is distinct from row(old.buyer_id,old.seller_id,old.stripe_payment_intent_id,old.stripe_charge_id,old.stripe_livemode,old.stripe_destination,old.payment_channel)) then
 raise exception 'Stripe dispute review required' using errcode='55000';end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $$;
revoke all on function voice_flea_private.guard_stripe_dispute_record() from public,anon,authenticated;
create trigger guard_stripe_dispute_record before update or delete on public.payments for each row execute function voice_flea_private.guard_stripe_dispute_record();

-- Only financial advancement is stopped. Existing content access/accepted history is untouched.
alter function public.prepare_delivery_acceptance(uuid,uuid) set schema voice_flea_private;
alter function voice_flea_private.prepare_delivery_acceptance(uuid,uuid) rename to stripe_previous_prepare_delivery_acceptance;
revoke all on function voice_flea_private.stripe_previous_prepare_delivery_acceptance(uuid,uuid) from public,anon,authenticated,service_role;
create function public.prepare_delivery_acceptance(actor uuid,trade_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 -- Conversation before payment follows existing acceptance lock order.
 perform 1 from public.conversations where id=trade_id and buyer_id=actor for update;
 select p0.* into p from public.payments p0 join public.conversations c on c.payment_id=p0.id where c.id=trade_id and c.buyer_id=actor for update of p0;
 if p.stripe_dispute_review_required then raise exception 'Stripe dispute review required' using errcode='55000';end if;
 return voice_flea_private.stripe_previous_prepare_delivery_acceptance(actor,trade_id);
end $$;
revoke all on function public.prepare_delivery_acceptance(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_delivery_acceptance(uuid,uuid) to service_role;
alter function public.finalize_delivery_acceptance(uuid,uuid,text) set schema voice_flea_private;
alter function voice_flea_private.finalize_delivery_acceptance(uuid,uuid,text) rename to stripe_previous_finalize_delivery_acceptance;
revoke all on function voice_flea_private.stripe_previous_finalize_delivery_acceptance(uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.finalize_delivery_acceptance(actor uuid,trade_id uuid,transfer text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 -- Conversation before payment follows existing acceptance lock order.
 perform 1 from public.conversations where id=trade_id and buyer_id=actor for update;
 select p0.* into p from public.payments p0 join public.conversations c on c.payment_id=p0.id where c.id=trade_id and c.buyer_id=actor for update of p0;
 if p.stripe_dispute_review_required then raise exception 'Stripe dispute review required' using errcode='55000';end if;
 return voice_flea_private.stripe_previous_finalize_delivery_acceptance(actor,trade_id,transfer);
end $$;
revoke all on function public.finalize_delivery_acceptance(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.finalize_delivery_acceptance(uuid,uuid,text) to service_role;
alter function public.prepare_account_deletion(uuid) set schema voice_flea_private;
alter function voice_flea_private.prepare_account_deletion(uuid) rename to stripe_previous_prepare_account_deletion;
revoke all on function voice_flea_private.stripe_previous_prepare_account_deletion(uuid) from public,anon,authenticated,service_role;
create function public.prepare_account_deletion(target uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(target::text,16));
 if exists(select 1 from public.payments where target in (buyer_id,seller_id) and stripe_dispute_review_required) then
 raise exception 'Stripe dispute review required' using errcode='55000';end if;
 return voice_flea_private.stripe_previous_prepare_account_deletion(target);
end $$;
revoke all on function public.prepare_account_deletion(uuid) from public,anon,authenticated;
grant execute on function public.prepare_account_deletion(uuid) to service_role;
alter function public.finish_account_deletion(uuid) set schema voice_flea_private;
alter function voice_flea_private.finish_account_deletion(uuid) rename to stripe_previous_finish_account_deletion;
revoke all on function voice_flea_private.stripe_previous_finish_account_deletion(uuid) from public,anon,authenticated,service_role;
create function public.finish_account_deletion(target uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(target::text,16));
 if exists(select 1 from public.payments where target in (buyer_id,seller_id) and stripe_dispute_review_required) then
 raise exception 'Stripe dispute review required' using errcode='55000';end if;
 perform voice_flea_private.stripe_previous_finish_account_deletion(target);
end $$;
revoke all on function public.finish_account_deletion(uuid) from public,anon,authenticated;
grant execute on function public.finish_account_deletion(uuid) to service_role;
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
  'stripe_dispute_review',count(*) filter(where stripe_dispute_review_required),
  'count',count(*) filter(where web_verified and stripe_livemode is true
   and status='paid' and refunded_amount_jpy=0 and seller_amount_jpy is not null and not stripe_dispute_review_required),
  'payout',coalesce(sum(seller_amount_jpy) filter(where web_verified and stripe_livemode is true
   and status='paid' and refunded_amount_jpy=0 and seller_amount_jpy is not null and not stripe_dispute_review_required),0),
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

-- One owner-scoped list for buyers/sellers; moderator queue adds only necessary provider evidence.
create function voice_flea_private.stripe_dispute_review_status(operator_view boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb;total bigint;
begin
 if auth.uid() is null or not voice_flea_private.account_available(auth.uid()) then raise exception 'Sign in required' using errcode='42501';end if;
 if operator_view and not voice_flea_private.is_moderator() then raise exception 'Operator required' using errcode='42501';end if;
 select count(*) into total from voice_flea_private.stripe_dispute_reviews r join public.payments p on p.id=r.payment_id
 where operator_view or auth.uid() in (p.buyer_id,p.seller_id);
 select coalesce(jsonb_agg(x.row order by x.observed_at desc),'[]'::jsonb) into rows from (
 select r.observed_at,jsonb_build_object('paymentId',p.id,'reviewRequired',true,
 'role',case when operator_view then 'operator' when p.buyer_id=auth.uid() then 'buyer' else 'seller' end,
 'environment',case when r.livemode then 'Production' else 'Test' end)
 ||case when operator_view then jsonb_build_object('disputeId',r.dispute_id,'status',r.status,'disputedAmountJpy',r.amount_jpy,
 'evidenceDueBy',r.evidence_due_by,'transferId',r.transfer_id,'platformId',r.platform_id,
 'knownTransferIds',r.known_transfer_ids,'observedTransferIds',r.observed_transfer_ids,'transferEvidenceConflict',r.transfer_evidence_conflict,
 'recoveryState','unverified','feesJpy',null,'observedAt',r.observed_at) else '{}'::jsonb end as row
 from voice_flea_private.stripe_dispute_reviews r join public.payments p on p.id=r.payment_id
 where operator_view or auth.uid() in (p.buyer_id,p.seller_id)
 order by r.observed_at desc,r.dispute_id limit 100) x;
 return jsonb_build_object('reviewRequired',total>0,'count',total,'rows',rows,'hasMore',total>100);
end $$;
revoke all on function voice_flea_private.stripe_dispute_review_status(boolean) from public,anon;
grant execute on function voice_flea_private.stripe_dispute_review_status(boolean) to authenticated;
create function public.stripe_dispute_review_status(operator_view boolean default false) returns jsonb language sql stable security invoker set search_path=''
as $$select voice_flea_private.stripe_dispute_review_status(operator_view)$$;
revoke all on function public.stripe_dispute_review_status(boolean) from public,anon;
grant execute on function public.stripe_dispute_review_status(boolean) to authenticated;

create or replace function voice_flea_private.admin_payment_receipts(
  before_created timestamptz default null,before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare summary jsonb; receipts jsonb; more boolean;
begin
  if auth.uid() is null or not voice_flea_private.is_moderator() then
    raise exception 'Operator access required' using errcode='42501';
  end if;
  if (before_created is null)<>(before_id is null) then
    raise exception 'Incomplete cursor' using errcode='22023';end if;
  select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) into summary from (
    select case when stripe_livemode then 'Production' when not stripe_livemode then 'Test' else 'Unknown' end environment,
      count(*) receipt_count,
      count(*) filter(where stripe_dispute_review_required) dispute_review_count,
      count(*) filter(where refunded_amount_jpy is null or stripe_reconciled_at is null) unreconciled_count,
      coalesce(sum(amount_jpy) filter(where refunded_amount_jpy is not null and stripe_reconciled_at is not null),0) verified_gross_jpy,
      coalesce(sum(refunded_amount_jpy) filter(where stripe_reconciled_at is not null),0) verified_refunds_jpy,
      coalesce(sum(amount_jpy-refunded_amount_jpy) filter(where stripe_reconciled_at is not null and not stripe_dispute_review_required),0) verified_retained_jpy
    from public.payments where status in ('paid','refunded','partially_refunded')
    group by 1
  )s;
  with page as (
    select p.id,p.listing_id,l.title listing_title,p.buyer_id,p.seller_id,
      p.stripe_dispute_review_required,p.amount_jpy,p.refunded_amount_jpy,p.platform_fee_jpy,p.status,p.paid_at,p.created_at,
      p.stripe_payment_intent_id,p.stripe_checkout_session_id,p.stripe_charge_id,p.stripe_reconciled_at,
      case when p.stripe_livemode then 'Production' when not p.stripe_livemode then 'Test' else 'Unknown' end environment
    from public.payments p left join public.listings l on l.id=p.listing_id
    where p.status in ('paid','refunded','partially_refunded')
      and (before_created is null or (p.created_at,p.id)<(before_created,before_id))
    order by p.created_at desc,p.id desc limit 11
  ), visible as (select * from page order by created_at desc,id desc limit 10)
  select (select coalesce(jsonb_agg(to_jsonb(v) order by v.created_at desc,v.id desc),'[]'::jsonb) from visible v),
    (select count(*)>10 from page) into receipts,more;
  return jsonb_build_object('summary',summary,'rows',receipts,'has_more',more);
end $$;
