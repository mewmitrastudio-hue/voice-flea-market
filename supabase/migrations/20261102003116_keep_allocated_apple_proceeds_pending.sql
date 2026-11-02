-- Allocation determines the liability; it does not prove a transfer or bank payout.
-- Keep Production Apple seller trades pending until a verified settlement lifecycle exists.
-- CREATE OR REPLACE preserves the existing participant-scoped grants.
-- A participant-scoped checklist. Counts cover all matching trades, not only the
-- current page. Inquiry chats and completed cancellations/refunds are excluded.
create or replace function voice_flea_private.pending_trade_summary(before_created timestamptz default null,before_id uuid default null,before_kind text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid();result jsonb;
begin
 if actor is null or not voice_flea_private.account_available(actor) then raise exception 'Sign in required' using errcode='42501';end if;
 if (before_created is null)<>(before_id is null) or (before_id is null)<>(before_kind is null) or before_kind is not null and before_kind not in ('trade','payment') then raise exception 'Incomplete cursor' using errcode='22023';end if;
 with classified as (
 select 'trade'::text kind,c.id item_id,c.id conversation_id,p.id payment_id,case when actor=c.buyer_id then 'buyer' else 'seller' end party,coalesce(l.title,j.title,'音声の取引') title,c.created_at,
 (p.stripe_livemode=false or p.apple_environment='Sandbox') is true is_test,
 case
  when ac.state in ('queued') or tc.state in ('queued','needs_review') then 'cancellation_pending'
  when ac.state='requested' and not case when actor=c.buyer_id then ac.buyer_approved else ac.seller_approved end then 'cancellation_response'
  when ac.state='requested' then 'cancellation_wait'
  when tc.state='requested' and not case when actor=c.buyer_id then tc.buyer_approved else tc.seller_approved end then 'cancellation_response'
  when tc.state='requested' then 'cancellation_wait'
  when p.status in ('partially_refunded','refunded') then 'payment_check'
  when p.stripe_capture_method='manual' and p.status in ('authorized','canceled') and p.authorization_expires_at<=now()
   then case when actor=c.buyer_id then 'reauthorization' else 'payment_wait' end
  when p.id is null or not coalesce(voice_flea_private.verified_voice_payment(p) or voice_flea_private.active_voice_authorization(p),false)
   then case when actor=c.buyer_id then 'payment_check' else 'payment_wait' end
  when c.delivery_status='accepted' and actor=c.seller_id and p.payment_channel='ios' and p.apple_environment='Production' then 'settlement_wait'
  when c.delivery_status='accepted' then null
  when c.delivery_status='submitted' then case when actor=c.buyer_id then 'receipt_required' else 'receipt_wait' end
  when c.delivery_status='none' then case when actor=c.seller_id then 'delivery_required' else 'delivery_wait' end
  else 'trade_check'
 end action
 from public.conversations c
 left join public.payments p on p.id=c.payment_id
 left join public.listings l on l.id=c.listing_id
 left join public.jobs j on j.id=c.job_id
 left join voice_flea_private.authorization_cancellations ac on ac.conversation_id=c.id
 left join voice_flea_private.trade_cancellations tc on tc.conversation_id=c.id
 where actor in (c.buyer_id,c.seller_id) and not c.is_inquiry
 and not (c.payment_id is null and c.job_id is not null and c.delivery_status='none' and c.delivery_path is null and not exists(select 1 from public.applications a where a.job_id=c.job_id and a.applicant_id=c.seller_id and a.status='accepted'))
 and not coalesce(voice_flea_private.verified_voice_refund(p),false) and ac.state is distinct from 'canceled' and tc.state is distinct from 'succeeded'
 union all
 select 'payment'::text,p.id,null::uuid,p.id,case when actor=p.buyer_id then 'buyer' else 'seller' end,
 coalesce(l.title,j.title,'音声の支払い'),p.created_at,
 (p.stripe_livemode=false or p.apple_environment='Sandbox') is true,
 'payment_check'::text
 from public.payments p left join public.listings l on l.id=p.listing_id left join public.jobs j on j.id=p.job_id
 where actor in (p.buyer_id,p.seller_id)
 and (p.status in ('pending','authorized','paid','partially_refunded') or p.status='refunded' and not coalesce(voice_flea_private.verified_voice_refund(p),false))
 and not exists(select 1 from public.conversations c where c.payment_id=p.id and not c.is_inquiry)
 ), pending as (
 select *,action in ('receipt_required','delivery_required','reauthorization','payment_check','cancellation_response','trade_check') needs_action
 from classified where action is not null
 ), page as (
 select * from pending where before_created is null or (created_at,item_id,kind)<(before_created,before_id,before_kind)
 order by created_at desc,item_id desc,kind desc limit 11
 ), visible as (select * from page order by created_at desc,item_id desc,kind desc limit 10)
 select jsonb_build_object('total',(select count(*) from pending),'needsAction',(select count(*) from pending where needs_action),
 'waiting',(select count(*) from pending where not needs_action),'rows',(select coalesce(jsonb_agg(to_jsonb(v) order by v.created_at desc,v.item_id desc,v.kind desc),'[]'::jsonb) from visible v),
 'hasMore',(select count(*)>10 from page)) into result;
 return result;
end $$;

create or replace function voice_flea_private.allocate_apple_proceeds(report uuid,line_number integer,purchases uuid[],evidence_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r voice_flea_private.apple_financial_reports;row_data jsonb;b voice_flea_private.apple_proceeds_batches;
 ids uuid[];n integer;i integer:=0;unit_net numeric;total_net numeric;base bigint;extra bigint;
 p public.payments;o voice_flea_private.voice_iap_orders;net bigint;fee bigint;
begin
 if auth.uid() is null or not voice_flea_private.account_available(auth.uid()) or not voice_flea_private.is_moderator() then
 raise exception 'Operator required' using errcode='42501';end if;
 if purchases is null or cardinality(purchases) not between 1 and 1000 or array_position(purchases,null) is not null
 or coalesce(length(trim(evidence_note)),0) not between 10 and 2000 then raise exception 'Explicit payment selection and reconciliation note required' using errcode='22023';end if;
 select array_agg(distinct x order by x) into ids from unnest(purchases) x;
 if cardinality(ids)<>cardinality(purchases) then raise exception 'Duplicate payment' using errcode='22023';end if;
 select * into r from voice_flea_private.apple_financial_reports where id=report for update;
 if not found then raise exception 'Report not found' using errcode='22023';end if;
 select * into b from voice_flea_private.apple_proceeds_batches where report_id=report and report_line=line_number;
 if found then
 if b.payment_ids is distinct from ids then raise exception 'Report row already allocated' using errcode='23505';end if;
 return jsonb_build_object('id',b.id,'allocated_jpy',b.allocated_jpy,'fractional_remainder',b.fractional_remainder,'state',case when exists(select 1 from voice_flea_private.apple_proceeds_allocations where batch_id=b.id and state='adjustment_required') then 'adjustment_required' else 'allocated_unpaid' end);end if;
 select value into row_data from jsonb_array_elements(r.snapshot->'rows') where (value->>'line')::integer=line_number;
 if row_data is null or row_data->>'kind' is distinct from 'S' or row_data->>'currency' is distinct from 'JPY'
 or row_data->>'customerCurrency' is distinct from 'JPY' or row_data->>'country' is distinct from 'JP'
 or coalesce(row_data->>'sku','') !~ '^com\.ayuhide\.koenofurima\.voice\.jpy[1-9][0-9]{0,7}$'
 then raise exception 'A Japanese yen voice sale row is required' using errcode='22023';end if;
 n=(row_data->>'quantity')::integer;unit_net=(row_data->>'unitProceeds')::numeric;total_net=(row_data->>'proceeds')::numeric;
 if n<>cardinality(ids) or n<1 or unit_net<0 or total_net<>unit_net*n
 or (row_data->>'customerPrice')::numeric<unit_net then raise exception 'Report units or proceeds mismatch' using errcode='22023';end if;
 -- Retain sub-yen amounts as a documented carry; allocate only whole yen.
 base=floor(unit_net)::bigint;extra=floor(total_net)::bigint-base*n;
 -- Lock payments in stable ID order, serializing allocation against refunds.
 perform 1 from public.payments where id=any(ids) order by id for update;
 if (select count(*) from public.payments where id=any(ids))<>n then raise exception 'Payment missing' using errcode='22023';end if;
 for p in select * from public.payments where id=any(ids) order by id loop
 select * into o from voice_flea_private.voice_iap_orders where payment_id=p.id;
 if not found or o.state<>'paid' or o.environment<>'Production' or o.product_id is distinct from row_data->>'sku'
 or o.transaction_id is distinct from p.apple_transaction_id or o.buyer_id<>p.buyer_id or o.seller_id<>p.seller_id
 or o.amount_jpy<>p.amount_jpy or p.amount_jpy<>(row_data->>'customerPrice')::numeric
 or p.payment_channel<>'ios' or p.apple_environment is distinct from 'Production' or p.apple_verified_at is null
 or p.status<>'paid' or p.refunded_amount_jpy is distinct from 0
 or p.seller_amount_jpy is not null or p.platform_fee_jpy is not null
 or not exists(select 1 from public.conversations c where c.payment_id=p.id and not c.is_inquiry and c.delivery_status='accepted')
 or exists(select 1 from voice_flea_private.apple_proceeds_allocations where payment_id=p.id)
 then raise exception 'Completed verified unallocated Apple sale required' using errcode='42501';end if;
 end loop;
 insert into voice_flea_private.apple_proceeds_batches(report_id,report_line,payment_ids,source_proceeds,allocated_jpy,fractional_remainder,allocated_by)
 values(report,line_number,ids,total_net,floor(total_net)::bigint,total_net-floor(total_net),auth.uid()) returning * into b;
 insert into voice_flea_private.apple_proceeds_notes(batch_id,actor,note) values(b.id,auth.uid(),trim(evidence_note));
 for p in select * from public.payments where id=any(ids) order by id loop
 i=i+1;net=base+case when i<=extra then 1 else 0 end;fee=round(net::numeric*15/100)::bigint;
 insert into voice_flea_private.apple_proceeds_allocations(payment_id,batch_id,seller_id,net_jpy,platform_fee_jpy,seller_amount_jpy)
 values(p.id,b.id,p.seller_id,net,fee,net-fee);
 -- Apple net proceeds belong only to the allocation ledger; preserve payment evidence.
 end loop;
 return jsonb_build_object('id',b.id,'allocated_jpy',b.allocated_jpy,'fractional_remainder',b.fractional_remainder,'state','allocated_unpaid');
end $$;
