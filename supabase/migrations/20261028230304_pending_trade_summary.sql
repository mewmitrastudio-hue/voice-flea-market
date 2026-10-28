-- A participant-scoped checklist. Counts cover all matching trades, not only the
-- current page. Inquiry chats and completed cancellations/refunds are excluded.
create function voice_flea_private.pending_trade_summary(before_created timestamptz default null,before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid();result jsonb;
begin
 if actor is null or not voice_flea_private.account_available(actor) then raise exception 'Sign in required' using errcode='42501';end if;
 if (before_created is null)<>(before_id is null) then raise exception 'Incomplete cursor' using errcode='22023';end if;
 with classified as (
 select c.id conversation_id,coalesce(l.title,j.title,'音声の取引') title,c.created_at,
 (p.stripe_livemode=false or p.apple_environment='Sandbox') is true is_test,
 case
  when ac.state in ('queued') or tc.state in ('queued','needs_review') then 'cancellation_pending'
  when ac.state='requested' and not case when actor=c.buyer_id then ac.buyer_approved else ac.seller_approved end then 'cancellation_response'
  when ac.state='requested' then 'cancellation_wait'
  when tc.state='requested' and not case when actor=c.buyer_id then tc.buyer_approved else tc.seller_approved end then 'cancellation_response'
  when tc.state='requested' then 'cancellation_wait'
  when p.status='partially_refunded' then 'payment_check'
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
 and p.status is distinct from 'refunded' and ac.state is distinct from 'canceled' and tc.state is distinct from 'succeeded'
 ), pending as (
 select *,action in ('receipt_required','delivery_required','reauthorization','payment_check','cancellation_response','trade_check') needs_action
 from classified where action is not null
 ), page as (
 select * from pending where before_created is null or (created_at,conversation_id)<(before_created,before_id)
 order by created_at desc,conversation_id desc limit 11
 ), visible as (select * from page order by created_at desc,conversation_id desc limit 10)
 select jsonb_build_object('total',(select count(*) from pending),'needsAction',(select count(*) from pending where needs_action),
 'waiting',(select count(*) from pending where not needs_action),'rows',(select coalesce(jsonb_agg(to_jsonb(v) order by v.created_at desc,v.conversation_id desc),'[]'::jsonb) from visible v),
 'hasMore',(select count(*)>10 from page)) into result;
 return result;
end $$;
revoke all on function voice_flea_private.pending_trade_summary(timestamptz,uuid) from public,anon;
grant execute on function voice_flea_private.pending_trade_summary(timestamptz,uuid) to authenticated;
create function public.pending_trade_summary(before_created timestamptz default null,before_id uuid default null)
returns jsonb language sql stable security invoker set search_path='' as $$select voice_flea_private.pending_trade_summary(before_created,before_id)$$;
revoke all on function public.pending_trade_summary(timestamptz,uuid) from public,anon;
grant execute on function public.pending_trade_summary(timestamptz,uuid) to authenticated;
