-- A participant-scoped checklist. Counts cover all matching trades, not only the
-- current page. Inquiry chats and completed cancellations/refunds are excluded.
create function voice_flea_private.pending_trade_summary(before_created timestamptz default null,before_id uuid default null,before_kind text default null)
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
  when c.delivery_status='accepted' and actor=c.seller_id and p.payment_channel='ios' and p.apple_environment='Production' and p.seller_amount_jpy is null then 'settlement_wait'
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
revoke all on function voice_flea_private.pending_trade_summary(timestamptz,uuid,text) from public,anon;
grant execute on function voice_flea_private.pending_trade_summary(timestamptz,uuid,text) to authenticated;
create function public.pending_trade_summary(before_created timestamptz default null,before_id uuid default null,before_kind text default null)
returns jsonb language sql stable security invoker set search_path='' as $$select voice_flea_private.pending_trade_summary(before_created,before_id,before_kind)$$;
revoke all on function public.pending_trade_summary(timestamptz,uuid,text) from public,anon;
grant execute on function public.pending_trade_summary(timestamptz,uuid,text) to authenticated;
