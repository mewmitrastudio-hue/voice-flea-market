CREATE OR REPLACE FUNCTION public.refund_auto_result(job_id uuid, lease uuid, refund_id text DEFAULT NULL::text, refund_status text DEFAULT NULL::text, error_code text DEFAULT NULL::text, permanent boolean DEFAULT false)
 RETURNS void
 LANGUAGE sql
 SET search_path TO ''
AS $function$select voice_flea_private.refund_auto_result(job_id,lease,refund_id,refund_status,error_code,permanent)$function$;

CREATE OR REPLACE FUNCTION voice_flea_private.refund_auto_result(job_id uuid, lease uuid, refund_id text DEFAULT NULL::text, refund_status text DEFAULT NULL::text, error_code text DEFAULT NULL::text, permanent boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j voice_flea_private.refund_auto_jobs;p public.payments;r voice_flea_private.trade_cancellations;complete boolean;
begin
 select * into j from voice_flea_private.refund_auto_jobs where id=job_id and state='processing' and lease_id=lease for update;
 if not found then raise exception 'Stale refund lease' using errcode='40001';end if;
 if refund_id is not null and (refund_id !~ '^re_[A-Za-z0-9]+$' or (j.provider_refund_id is not null and j.provider_refund_id<>refund_id)) then raise exception 'Refund identity mismatch' using errcode='22023';end if;
 if refund_id is null and error_code is null then raise exception 'Missing refund outcome' using errcode='22023';end if;
 select * into p from public.payments where id=j.payment_id;
 complete=p.status='refunded' and p.refunded_amount_jpy=p.amount_jpy and p.stripe_reconciled_at is not null;
 update voice_flea_private.refund_auto_jobs set provider_refund_id=coalesce(refund_id,provider_refund_id),provider_status=refund_status,error_code=left(refund_auto_result.error_code,80),
 state=case when complete then 'succeeded' when permanent then 'needs_review' else 'waiting' end,
 next_attempt_at=now()+case when coalesce(refund_id,provider_refund_id) is not null then interval '15 minutes' else interval '5 minutes' end,
 completed_at=case when complete then now() else null end,lease_until=null where id=j.id;
 update voice_flea_private.trade_cancellations set state=case when complete then 'succeeded' when permanent then 'needs_review' else 'queued' end where id=j.cancellation_id returning * into r;
 if complete then
  insert into voice_flea_private.app_mail_outbox(dedupe_key,recipient_id,kind,subject,body)
  select 'refund_done:'||j.id::text||':'||u::text,u,'refund_update','【声のフリマ】Web決済の返金処理が完了しました',
   E'双方で承認されたキャンセルに伴うWeb決済の返金処理が、決済サービスで完了しました。\\n\\n対象金額：'||p.amount_jpy::text||E'円\\n取引番号：'||r.conversation_id::text||E'\\n\\nカードの明細等への反映時期は、ご利用のカード会社などにより異なります。アプリ内の取引履歴もご確認ください。\\n\\n声のフリマ運営'
  from unnest(array[p.buyer_id,p.seller_id])u on conflict(dedupe_key) do nothing;
  perform voice_flea_private.dispatch_app_mail();
 end if;
end $function$;
