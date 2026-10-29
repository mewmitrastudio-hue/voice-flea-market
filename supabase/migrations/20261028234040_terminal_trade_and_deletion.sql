-- Closure uses exact, verified receipts. Another accepted purchase of the same
-- listing is not evidence that this payment has been fulfilled.
create function voice_flea_private.apple_settlement_pending_for_user(target uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.payments p where p.seller_id=target and p.payment_channel='ios'
 and p.apple_environment='Production' and p.status='paid' and not coalesce(voice_flea_private.verified_voice_refund(p),false))
$$;
revoke all on function voice_flea_private.apple_settlement_pending_for_user(uuid) from public,anon,authenticated;
create or replace function public.prepare_account_deletion(target uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if target is null then raise exception 'Missing account';end if;
 perform pg_advisory_xact_lock(hashtextextended(target::text,16));
 if not exists(select 1 from auth.users where id=target) then raise exception 'Account not found';end if;
 if exists(select 1 from voice_flea_private.checkout_reservations where (buyer_id=target or seller_id=target) and state='pending') then
 return jsonb_build_object('allowed',false,'message','決済画面で進行中の手続きがあります。支払い・与信の状態を先に確認してください。');end if;
 if exists(select 1 from public.payments p where (p.buyer_id=target or p.seller_id=target) and
 (p.status in ('pending','authorized','partially_refunded') or p.status='refunded' and not coalesce(voice_flea_private.verified_voice_refund(p),false))) then
 return jsonb_build_object('allowed',false,'message','未確定の支払い・与信・返金があります。未完了の取引一覧から対応してください。');end if;
 if exists(select 1 from public.conversations c left join public.payments p on p.id=c.payment_id
 left join voice_flea_private.authorization_cancellations a on a.conversation_id=c.id and a.payment_id=c.payment_id
 where target in (c.buyer_id,c.seller_id) and not c.is_inquiry and c.delivery_status<>'accepted'
 and not (c.payment_id is null and c.job_id is not null and c.delivery_status='none' and c.delivery_path is null and not exists(select 1 from public.applications a where a.job_id=c.job_id and a.applicant_id=c.seller_id and a.status='accepted'))
 and not coalesce(voice_flea_private.verified_voice_refund(p),false)
 and not coalesce(a.state='canceled' and p.status='canceled' and p.stripe_capture_method='manual',false)) then
 return jsonb_build_object('allowed',false,'message','未完了の取引があります。納品・受取またはキャンセルの対応後に削除してください。');end if;
 if exists(select 1 from public.payments p where target in (p.buyer_id,p.seller_id) and p.status='paid'
 and not exists(select 1 from public.conversations c where c.payment_id=p.id and not c.is_inquiry and c.delivery_status='accepted')) then
 return jsonb_build_object('allowed',false,'message','取引との対応が未確認の支払いがあります。再購入せず運営へお問い合わせください。');end if;
 if voice_flea_private.apple_settlement_pending_for_user(target) then
 return jsonb_build_object('allowed',false,'message','Apple売上の精算が未完了です。売上金から状況を確認してください。');end if;
 if exists(select 1 from public.listing_boosts where seller_id=target and status='pending') then
 return jsonb_build_object('allowed',false,'message','未確定のブースト課金があります。先に購入の反映を確認してください。');end if;
 if exists(select 1 from public.applications a join public.jobs j on j.id=a.job_id where (a.applicant_id=target or j.buyer_id=target) and a.status='accepted' and j.status='in_progress') then
 return jsonb_build_object('allowed',false,'message','進行中の依頼があります。先に依頼を完了してください。');end if;
 insert into voice_flea_private.account_deletions(user_id) values(target) on conflict do nothing;
 update public.listings set is_active=false where seller_id=target;
 update public.jobs set status='cancelled' where buyer_id=target and status='open';
 return jsonb_build_object('allowed',true,'files',coalesce((select jsonb_agg(jsonb_build_object('bucket',bucket_id,'name',name)) from storage.objects where owner_id=target::text and bucket_id in ('voice-samples','profile-avatars')),'[]'::jsonb));
end $$;
revoke all on function public.prepare_account_deletion(uuid) from public,anon,authenticated;
grant execute on function public.prepare_account_deletion(uuid) to service_role;
