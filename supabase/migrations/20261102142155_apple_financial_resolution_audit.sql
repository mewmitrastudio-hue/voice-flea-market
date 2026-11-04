-- Manual evidence approval, never a money-movement authorization.
create table voice_flea_private.apple_financial_reviews(
 id uuid primary key,kind text not null check(kind in ('adjustment','bank')),
 payment_id uuid not null references public.payments(id),created_by uuid not null,
 input jsonb not null,summary jsonb not null,preview_hash text not null,
 state text not null default 'preview' check(state in ('preview','approved','invalidated')),
 created_at timestamptz not null default clock_timestamp(),approved_at timestamptz,
 approved_by uuid,invalidated_at timestamptz,invalidation_reason text
);
create table voice_flea_private.apple_financial_adjustments(
 review_id uuid primary key references voice_flea_private.apple_financial_reviews(id),
 payment_id uuid not null references public.payments(id),report_id uuid not null references voice_flea_private.apple_financial_reports(id),report_line integer not null,
 customer_refund_jpy bigint not null check(customer_refund_jpy>0),apple_net_debit numeric(20,6) not null check(apple_net_debit>=0),
 state text not null default 'policy_review_required' check(state='policy_review_required'),
 unique(report_id,report_line)
);
create table voice_flea_private.apple_bank_receipts(
 id uuid primary key default gen_random_uuid(),destination text not null,payout_id text not null,
 bank_account_id text not null,statement_sha256 text not null,bank_reference text not null,received_date date not null,
 received_amount_jpy bigint not null check(received_amount_jpy>0),actor uuid not null,approved_at timestamptz not null default clock_timestamp(),
 state text not null default 'operator_approved' check(state in ('operator_approved','invalidated')),
 unique(destination,payout_id)
);
create table voice_flea_private.apple_failed_payouts(
 event_id text primary key,destination text not null,payout_id text not null,observed_at timestamptz not null default clock_timestamp()
);
create index apple_failed_payout_identity on voice_flea_private.apple_failed_payouts(destination,payout_id);
alter table voice_flea_private.apple_failed_payouts enable row level security;
revoke all on voice_flea_private.apple_failed_payouts from public,anon,authenticated;
grant select on voice_flea_private.apple_failed_payouts to service_role;
create table voice_flea_private.apple_terminal_settlements(
 payment_id uuid primary key references public.payments(id),review_id uuid not null unique references voice_flea_private.apple_financial_reviews(id),
 bank_receipt_id uuid not null references voice_flea_private.apple_bank_receipts(id),amount_jpy bigint not null check(amount_jpy>0),
 state text not null check(state in ('settled','needs_review')),settled_at timestamptz not null default clock_timestamp(),invalidated_at timestamptz
);
create table voice_flea_private.apple_resolution_events(
 id uuid primary key default gen_random_uuid(),review_id uuid references voice_flea_private.apple_financial_reviews(id),
 actor uuid,event text not null,evidence jsonb not null default '{}'::jsonb,created_at timestamptz not null default clock_timestamp()
);
create table voice_flea_private.apple_resolution_observations(
 id uuid primary key default gen_random_uuid(),review_id uuid not null references voice_flea_private.apple_financial_reviews(id),
 phase text not null check(phase in ('preview','approval')),snapshot jsonb not null,sha256 text not null,
 observed_by uuid not null,recorded_at timestamptz not null default clock_timestamp(),constraint apple_resolution_observation_identity unique(review_id,phase,sha256)
);
alter table voice_flea_private.apple_resolution_observations enable row level security;
revoke all on voice_flea_private.apple_resolution_observations from public,anon,authenticated;
grant select on voice_flea_private.apple_resolution_observations to service_role;
alter table voice_flea_private.apple_financial_reviews enable row level security;
alter table voice_flea_private.apple_financial_adjustments enable row level security;
alter table voice_flea_private.apple_bank_receipts enable row level security;
alter table voice_flea_private.apple_terminal_settlements enable row level security;
alter table voice_flea_private.apple_resolution_events enable row level security;
revoke all on voice_flea_private.apple_financial_reviews,voice_flea_private.apple_financial_adjustments,voice_flea_private.apple_bank_receipts,voice_flea_private.apple_terminal_settlements,voice_flea_private.apple_resolution_events from public,anon,authenticated;
grant select on voice_flea_private.apple_financial_reviews,voice_flea_private.apple_financial_adjustments,voice_flea_private.apple_bank_receipts,voice_flea_private.apple_terminal_settlements,voice_flea_private.apple_resolution_events to service_role;
alter table voice_flea_private.apple_proceeds_allocations drop constraint apple_proceeds_allocations_state_check;
alter table voice_flea_private.apple_proceeds_allocations add constraint apple_proceeds_allocations_state_check check(state in ('allocated_unpaid','adjustment_required','bank_reconciled'));

create function voice_flea_private.resolution_operator(actor uuid) returns boolean language sql stable security definer set search_path='' as $$
 select actor is not null and voice_flea_private.account_available(actor) and exists(select 1 from voice_flea_private.moderators where user_id=actor)
$$;
revoke all on function voice_flea_private.resolution_operator(uuid) from public,anon,authenticated;

create function public.apple_financial_resolution_context(actor uuid,purchase uuid,report uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 if not voice_flea_private.resolution_operator(actor) then raise exception 'Operator required' using errcode='42501';end if;
 select * into p from public.payments where id=purchase;
 if not found then raise exception 'Purchase not found' using errcode='22023';end if;
 return jsonb_build_object('payment',to_jsonb(p),'operation',(select to_jsonb(o) from voice_flea_private.apple_settlement_operations o where payment_id=p.id),
 'allocation',(select to_jsonb(a) from voice_flea_private.apple_proceeds_allocations a where payment_id=p.id),
 'refundReviewRequired',voice_flea_private.apple_refund_review_pending(p),
 'report',(select jsonb_build_object('id',r.id,'snapshot',r.snapshot) from voice_flea_private.apple_financial_reports r where id=report));
end $$;
revoke all on function public.apple_financial_resolution_context(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.apple_financial_resolution_context(uuid,uuid,uuid) to service_role;

create function voice_flea_private.store_resolution_observation(review voice_flea_private.apple_financial_reviews,phase text,actor uuid,observation jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
 if review.kind<>'bank' then return;end if;
 if observation is null or octet_length(observation::text)>6000000
 or observation->'transfer'->'data'->>'id' is distinct from review.summary->>'transferId'
 or observation->'transfer'->'data'->'metadata'->>'payment_id' is distinct from review.payment_id::text
 or observation->'payout'->'data'->>'id' is distinct from review.summary->>'payoutId'
 or observation->'payout'->'context'->>'accountId' is distinct from review.summary->>'destination'
 or observation->'payout'->'context'->>'source' is distinct from 'stripe_server_api'
 then raise exception 'Server observation required' using errcode='42501';end if;
 insert into voice_flea_private.apple_resolution_observations(review_id,phase,snapshot,sha256,observed_by)
 values(review.id,phase,observation,encode(sha256(convert_to(observation::text,'UTF8')),'hex'),actor) on conflict on constraint apple_resolution_observation_identity do nothing;
end $$;
revoke all on function voice_flea_private.store_resolution_observation(voice_flea_private.apple_financial_reviews,text,uuid,jsonb) from public,anon,authenticated;

create function public.store_apple_financial_review(actor uuid,operation uuid,kind text,purchase uuid,input jsonb,summary jsonb,observation jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r voice_flea_private.apple_financial_reviews;fingerprint text;
begin
 if not voice_flea_private.resolution_operator(actor) then raise exception 'Operator required' using errcode='42501';end if;
 if kind not in ('adjustment','bank') or summary->>'kind' is distinct from kind or summary->>'paymentId' is distinct from purchase::text or octet_length(summary::text)>16000 or octet_length(input::text)>8000 then raise exception 'Invalid preview' using errcode='22023';end if;
 fingerprint=encode(sha256(convert_to(summary::text,'UTF8')),'hex');
 perform 1 from public.payments where id=purchase for update;
 if not found then raise exception 'Purchase not found' using errcode='22023';end if;
 insert into voice_flea_private.apple_financial_reviews(id,kind,payment_id,created_by,input,summary,preview_hash)
 values(operation,kind,purchase,actor,input,summary,fingerprint) on conflict(id) do nothing;
 select * into r from voice_flea_private.apple_financial_reviews where id=operation for update;
 if r.created_by<>actor or r.kind<>kind or r.payment_id<>purchase or r.input is distinct from input or r.summary is distinct from summary then raise exception 'Operation identity changed' using errcode='23505';end if;
 perform voice_flea_private.store_resolution_observation(r,'preview',actor,observation);
 return to_jsonb(r);
end $$;
revoke all on function public.store_apple_financial_review(uuid,uuid,text,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.store_apple_financial_review(uuid,uuid,text,uuid,jsonb,jsonb,jsonb) to service_role;
create function public.get_apple_financial_review(actor uuid,operation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not voice_flea_private.resolution_operator(actor) then raise exception 'Operator required' using errcode='42501';end if;
 return (select to_jsonb(r)||jsonb_build_object('terminal',(select to_jsonb(t) from voice_flea_private.apple_terminal_settlements t where t.payment_id=r.payment_id)) from voice_flea_private.apple_financial_reviews r where id=operation);
end $$;
revoke all on function public.get_apple_financial_review(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_apple_financial_review(uuid,uuid) to service_role;

create function public.approve_apple_financial_review(actor uuid,operation uuid,preview_hash text,fresh_summary jsonb,observation jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r voice_flea_private.apple_financial_reviews;p public.payments;o voice_flea_private.apple_settlement_operations;
 a voice_flea_private.apple_proceeds_allocations;row_data jsonb;bank voice_flea_private.apple_bank_receipts;ord voice_flea_private.voice_iap_orders;eligible boolean;
begin
 if not voice_flea_private.resolution_operator(actor) then raise exception 'Operator required' using errcode='42501';end if;
 select * into r from voice_flea_private.apple_financial_reviews where id=operation;
 -- Match failure webhook lock order: payout identity first, then payment/review.
 if r.kind='bank' then perform pg_advisory_xact_lock(hashtextextended((r.summary->>'destination')||':'||(r.summary->>'payoutId'),97));end if;
 select p0.* into p from public.payments p0 join voice_flea_private.apple_financial_reviews v on v.payment_id=p0.id where v.id=operation for update of p0;
 select * into r from voice_flea_private.apple_financial_reviews where id=operation for update;
 if not found or r.created_by<>actor or r.preview_hash is distinct from preview_hash or r.summary is distinct from fresh_summary then raise exception 'Preview changed' using errcode='42501';end if;
 if r.state='approved' then return to_jsonb(r);end if;
 if r.state<>'preview' then raise exception 'Review invalidated' using errcode='55000';end if;
 if r.kind='bank' and exists(select 1 from voice_flea_private.apple_failed_payouts f where f.destination=r.summary->>'destination' and f.payout_id=r.summary->>'payoutId') then
  update voice_flea_private.apple_financial_reviews set state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='payout_failure_precedes_approval' where id=r.id returning * into r;
  insert into voice_flea_private.apple_resolution_events(review_id,actor,event) values(r.id,actor,'payout_failure_precedes_approval');
  return to_jsonb(r);
 end if;

 perform voice_flea_private.store_resolution_observation(r,'approval',actor,observation);
 if p.payment_channel<>'ios' or p.apple_environment<>'Production' or p.apple_verified_at is null then raise exception 'Production evidence required' using errcode='42501';end if;
 if r.kind='adjustment' then
  select value into row_data from voice_flea_private.apple_financial_reports f,jsonb_array_elements(f.snapshot->'rows') where f.id=(r.input->>'reportId')::uuid and (value->>'line')::integer=(r.input->>'lineNumber')::integer;
  if row_data is null or row_data->>'kind'<>'R' or (row_data->>'quantity')::integer<>-1 or row_data->>'currency'<>'JPY' or row_data->>'customerCurrency'<>'JPY' or row_data->>'country'<>'JP'
   or row_data->>'sku'<>'com.ayuhide.koenofurima.voice.jpy'||p.amount_jpy::text
   or -(row_data->>'customerPrice')::numeric<>(r.summary->>'customerRefundJpy')::bigint or (r.summary->>'customerRefundJpy')::bigint not between 1 and p.amount_jpy
   or (row_data->>'unitProceeds')::numeric<>(r.summary->>'appleNetDebit')::numeric or (row_data->>'proceeds')::numeric<>-(row_data->>'unitProceeds')::numeric then raise exception 'Report evidence mismatch' using errcode='42501';end if;
  select * into ord from voice_flea_private.voice_iap_orders where payment_id=p.id;
  if not found or ord.transaction_id<>p.apple_transaction_id then raise exception 'Purchase identity mismatch' using errcode='42501';end if;
  insert into voice_flea_private.apple_financial_adjustments(review_id,payment_id,report_id,report_line,customer_refund_jpy,apple_net_debit)
  values(r.id,p.id,(r.input->>'reportId')::uuid,(r.input->>'lineNumber')::integer,(r.summary->>'customerRefundJpy')::bigint,(r.summary->>'appleNetDebit')::numeric);
  insert into voice_flea_private.apple_refund_review_holds(order_id,transaction_id,environment,evidence)
  values(ord.id,p.apple_transaction_id,p.apple_environment,jsonb_build_object('source','approved_report_return','reviewId',r.id)) on conflict(order_id) do nothing;
  update voice_flea_private.apple_proceeds_allocations set state='adjustment_required' where payment_id=p.id;
 else
  select * into o from voice_flea_private.apple_settlement_operations where payment_id=p.id for update;
  select * into a from voice_flea_private.apple_proceeds_allocations where payment_id=p.id for update;
  if o.id is null or a.payment_id is null or r.summary->>'transferId' is distinct from o.transfer_id or r.summary->>'destination' is distinct from o.destination
   or (r.summary->>'sellerAmountJpy')::bigint is distinct from a.seller_amount_jpy or o.amount_jpy<>a.seller_amount_jpy
   or (r.summary->>'receivedAmountJpy')::bigint is distinct from (r.summary->>'payoutAmountJpy')::bigint
   or (r.summary->>'payoutAmountJpy')::bigint<=0 or r.summary->>'bankStatementSha256' !~ '^[0-9a-f]{64}$' then raise exception 'Bank evidence mismatch' using errcode='42501';end if;
  insert into voice_flea_private.apple_bank_receipts(destination,payout_id,bank_account_id,statement_sha256,bank_reference,received_date,received_amount_jpy,actor)
  values(o.destination,r.summary->>'payoutId',r.summary->>'bankAccountId',r.summary->>'bankStatementSha256',r.summary->>'bankReference',(r.summary->>'receivedDate')::date,(r.summary->>'receivedAmountJpy')::bigint,actor) on conflict(destination,payout_id) do nothing;
  select * into bank from voice_flea_private.apple_bank_receipts where destination=o.destination and payout_id=r.summary->>'payoutId' for update;
  if bank.state<>'operator_approved' or bank.statement_sha256<>r.summary->>'bankStatementSha256' or bank.bank_reference<>r.summary->>'bankReference' or bank.received_amount_jpy<>(r.summary->>'receivedAmountJpy')::bigint or bank.bank_account_id<>r.summary->>'bankAccountId' or bank.received_date<>(r.summary->>'receivedDate')::date then raise exception 'Bank receipt already recorded differently' using errcode='23505';end if;
  eligible=coalesce(voice_flea_private.verified_voice_payment(p),false) and p.refunded_amount_jpy=0 and a.state='allocated_unpaid' and o.state='transferred' and o.reversed_jpy=0
   and r.summary->'batchAllPositiveNoFees'='true'::jsonb and r.summary->'batchMatchesPayout'='true'::jsonb
   and (r.summary->>'batchNetTotalJpy')::bigint=(r.summary->>'payoutAmountJpy')::bigint and (r.summary->>'payoutAmountJpy')::bigint>=a.seller_amount_jpy
   and (r.summary->>'creditFeeJpy')::bigint=0 and (r.summary->>'creditNetJpy')::bigint=a.seller_amount_jpy and r.summary->'eligibleForSettlement'='true'::jsonb
   and not exists(select 1 from voice_flea_private.apple_financial_adjustments where payment_id=p.id);
  if eligible then
   insert into voice_flea_private.apple_terminal_settlements(payment_id,review_id,bank_receipt_id,amount_jpy,state) values(p.id,r.id,bank.id,a.seller_amount_jpy,'settled');
   update voice_flea_private.apple_proceeds_allocations set state='bank_reconciled' where payment_id=p.id;
  end if;
 end if;
 update voice_flea_private.apple_financial_reviews set state='approved',approved_at=clock_timestamp(),approved_by=actor where id=r.id returning * into r;
 insert into voice_flea_private.apple_resolution_events(review_id,actor,event,evidence) values(r.id,actor,'approved',jsonb_build_object('summaryHash',r.preview_hash));
 return to_jsonb(r);
end $$;
revoke all on function public.approve_apple_financial_review(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.approve_apple_financial_review(uuid,uuid,text,jsonb,jsonb) to service_role;

-- Late evidence reopens obligations. It never erases an earlier approval.
create function voice_flea_private.invalidate_apple_terminal(purchase uuid,reason text)
returns void language plpgsql security definer set search_path='' as $$
declare t voice_flea_private.apple_terminal_settlements;
begin
 update voice_flea_private.apple_terminal_settlements set state='needs_review',invalidated_at=clock_timestamp() where payment_id=purchase and state='settled' returning * into t;
 if found then
  update voice_flea_private.apple_financial_reviews set state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason=reason where id=t.review_id;
  update voice_flea_private.apple_proceeds_allocations set state='adjustment_required' where payment_id=purchase;
  insert into voice_flea_private.apple_resolution_events(review_id,event,evidence) values(t.review_id,'invalidated',jsonb_build_object('reason',reason));
 end if;
end $$;
revoke all on function voice_flea_private.invalidate_apple_terminal(uuid,text) from public,anon,authenticated;
create function voice_flea_private.guard_terminal_late_evidence() returns trigger language plpgsql security definer set search_path='' as $$
declare purchase uuid;
begin
 if tg_table_name='payments' then
  if new.status='paid' and new.refunded_amount_jpy=0 then return new;end if;purchase=new.id;
 elsif tg_table_name='apple_settlement_operations' then
  if new.state='transferred' and new.reversed_jpy=0 then return new;end if;purchase=new.payment_id;
 else select payment_id into purchase from voice_flea_private.voice_iap_orders where id=new.order_id;
 end if;
 perform voice_flea_private.invalidate_apple_terminal(purchase,'late_'||tg_table_name);
 return new;
end $$;
revoke all on function voice_flea_private.guard_terminal_late_evidence() from public,anon,authenticated;
create trigger apple_terminal_payment_change after update of status,refunded_amount_jpy on public.payments for each row execute function voice_flea_private.guard_terminal_late_evidence();
create trigger apple_terminal_transfer_change after update of state,reversed_jpy on voice_flea_private.apple_settlement_operations for each row execute function voice_flea_private.guard_terminal_late_evidence();
create trigger apple_terminal_hold after insert on voice_flea_private.apple_refund_review_holds for each row execute function voice_flea_private.guard_terminal_late_evidence();
create function public.invalidate_apple_bank_payout(destination text,payout text,event_id text)
returns integer language plpgsql security definer set search_path='' as $$
declare t record;n integer:=0;
begin
 if destination !~ '^acct_[A-Za-z0-9]+$' or payout !~ '^po_[A-Za-z0-9]+$' or event_id !~ '^evt_[A-Za-z0-9]+$' then raise exception 'Invalid payout event' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(destination||':'||payout,97));
 insert into voice_flea_private.apple_failed_payouts(event_id,destination,payout_id) values(event_id,destination,payout) on conflict on constraint apple_failed_payouts_pkey do nothing;
 if not exists(select 1 from voice_flea_private.apple_failed_payouts f where f.event_id=$3 and f.destination=$1 and f.payout_id=$2) then raise exception 'Payout event identity changed' using errcode='42501';end if;

 for t in select s.payment_id from voice_flea_private.apple_terminal_settlements s join voice_flea_private.apple_bank_receipts b on b.id=s.bank_receipt_id where b.destination=$1 and b.payout_id=$2 order by s.payment_id loop
  perform 1 from public.payments where id=t.payment_id for update;
  perform voice_flea_private.invalidate_apple_terminal(t.payment_id,'payout_failed:'||event_id);n=n+1;
 end loop;
 update voice_flea_private.apple_bank_receipts set state='invalidated' where apple_bank_receipts.destination=$1 and payout_id=$2;
 return n;
end $$;
revoke all on function public.invalidate_apple_bank_payout(text,text,text) from public,anon,authenticated;
grant execute on function public.invalidate_apple_bank_payout(text,text,text) to service_role;

create or replace function voice_flea_private.apple_settlement_pending_for_user(target uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from voice_flea_private.apple_refund_review_holds h join voice_flea_private.voice_iap_orders o on o.id=h.order_id where target in (o.buyer_id,o.seller_id))
 or exists(select 1 from voice_flea_private.apple_proceeds_allocations a where a.seller_id=target and a.state in ('allocated_unpaid','adjustment_required'))
 or exists(select 1 from public.payments p where p.seller_id=target and p.payment_channel='ios' and p.apple_environment='Production' and p.status='paid' and not coalesce(voice_flea_private.verified_voice_refund(p),false)
 and not exists(select 1 from voice_flea_private.apple_terminal_settlements s where s.payment_id=p.id and s.state='settled'))
$$;
revoke all on function voice_flea_private.apple_settlement_pending_for_user(uuid) from public,anon,authenticated;

-- A prepared deletion is not a financial completion certificate. This trigger
-- runs in the same transaction as profile anonymization, so failure rolls it back.
create function voice_flea_private.guard_financial_deletion_completion()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.completed_at is not null and old.completed_at is null then
  perform 1 from voice_flea_private.voice_iap_orders where new.user_id in (buyer_id,seller_id) order by id for update;
  perform 1 from public.payments where new.user_id in (buyer_id,seller_id) order by id for update;
  if voice_flea_private.apple_settlement_pending_for_user(new.user_id) then raise exception 'Apple financial review required before deletion' using errcode='55000';end if;
 end if;
 return new;
end $$;
revoke all on function voice_flea_private.guard_financial_deletion_completion() from public,anon,authenticated;
create trigger financial_deletion_completion before update of completed_at on voice_flea_private.account_deletions for each row execute function voice_flea_private.guard_financial_deletion_completion();
create function public.invalidate_apple_financial_preview(actor uuid,operation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r voice_flea_private.apple_financial_reviews;
begin
 if not voice_flea_private.resolution_operator(actor) then raise exception 'Operator required' using errcode='42501';end if;
 select * into r from voice_flea_private.apple_financial_reviews where id=operation for update;
 if not found or r.created_by<>actor then raise exception 'Preview not found' using errcode='42501';end if;
 if r.state='preview' then
  update voice_flea_private.apple_financial_reviews set state='invalidated',invalidated_at=clock_timestamp(),invalidation_reason='fresh_evidence_changed' where id=operation returning * into r;
  insert into voice_flea_private.apple_resolution_events(review_id,actor,event) values(operation,actor,'preview_invalidated');
 end if;return to_jsonb(r);
end $$;
revoke all on function public.invalidate_apple_financial_preview(uuid,uuid) from public,anon,authenticated;
grant execute on function public.invalidate_apple_financial_preview(uuid,uuid) to service_role;
create function voice_flea_private.guard_terminal_adjustment() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='adjustment_required' then perform voice_flea_private.invalidate_apple_terminal(new.payment_id,'late_allocation_adjustment');end if;
 return new;
end $$;
revoke all on function voice_flea_private.guard_terminal_adjustment() from public,anon,authenticated;
create trigger apple_terminal_allocation_change after update of state on voice_flea_private.apple_proceeds_allocations for each row when (new.state='adjustment_required' and old.state is distinct from new.state) execute function voice_flea_private.guard_terminal_adjustment();
