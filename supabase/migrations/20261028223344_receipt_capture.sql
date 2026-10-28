-- New authorizations remain separate from captured money. No historical inference.
alter table public.payments alter column listing_id drop not null;
alter table public.payments add column job_id uuid references public.jobs(id);
alter table public.payments add column job_application_id uuid references public.applications(id);
alter table public.payments add constraint payments_purchase_target check(
 listing_id is not null and job_id is null and job_application_id is null or listing_id is null and job_id is not null and job_application_id is not null);
alter table public.payments add column stripe_capture_method text not null default 'automatic' check(stripe_capture_method in ('automatic','manual'));
alter table public.payments add column authorization_expires_at timestamptz;
alter table public.payments add column stripe_destination text;
alter table public.payments drop constraint payments_status_check;
alter table public.payments add constraint payments_status_check check(status in ('pending','authorized','paid','failed','refunded','partially_refunded','canceled'));
create function voice_flea_private.verified_voice_refund(p public.payments)
returns boolean language sql stable security invoker set search_path='' as $$
 select p.status='refunded' and p.refunded_amount_jpy=p.amount_jpy and (
 p.payment_channel='web' and p.stripe_reconciled_at is not null and p.stripe_livemode is not null
 or p.payment_channel='ios' and p.apple_verified_at is not null and p.apple_transaction_id is not null and p.apple_environment in ('Sandbox','Production'))
$$;
revoke all on function voice_flea_private.verified_voice_refund(public.payments) from public,anon,authenticated;
create function voice_flea_private.active_voice_authorization(p public.payments)
returns boolean language sql stable security invoker set search_path='' as $$
 select p.payment_channel='web' and p.status='authorized' and p.stripe_capture_method='manual'
 and p.authorization_expires_at>now() and p.stripe_reconciled_at is not null and p.stripe_livemode is not null and p.refunded_amount_jpy=0
$$;
revoke all on function voice_flea_private.active_voice_authorization(public.payments) from public,anon,authenticated;
-- One server-owned quote per buyer/listing, shared by tabs and request retries.
create table voice_flea_private.voice_checkout_intents(
 id uuid primary key default gen_random_uuid(),reservation_id uuid not null unique references voice_flea_private.checkout_reservations(id),
 buyer_id uuid not null references auth.users(id),seller_id uuid not null references auth.users(id),listing_id uuid references public.listings(id),job_id uuid references public.jobs(id),job_application_id uuid references public.applications(id),
 amount_jpy integer not null check(amount_jpy between 50 and 99999999),title text not null,stripe_destination text not null,renewal_conversation_id uuid references public.conversations(id),
 state text not null default 'prepared' check(state in ('prepared','finished')),created_at timestamptz not null default now());
create unique index one_job_checkout_per_application on voice_flea_private.voice_checkout_intents(job_application_id) where state='prepared' and job_application_id is not null;
create unique index one_voice_checkout_per_listing on voice_flea_private.voice_checkout_intents(buyer_id,listing_id) where state='prepared';
alter table voice_flea_private.voice_checkout_intents enable row level security;
revoke all on voice_flea_private.voice_checkout_intents from public,anon,authenticated;
grant select,insert,update on voice_flea_private.voice_checkout_intents to service_role;
create function public.prepare_voice_checkout(actor uuid,listing uuid,destination text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.listings;q voice_flea_private.voice_checkout_intents;r uuid;uid uuid;
begin
 if actor is null or not voice_flea_private.account_available(actor) then raise exception 'Sign in required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||listing::text,84));
 select * into l from public.listings where id=listing and is_active for share;
 if not found or l.seller_id=actor or not voice_flea_private.account_available(l.seller_id)
  or l.price_jpy not between 50 and 99999999 or exists(select 1 from public.user_blocks where (blocker_id=actor and blocked_user_id=l.seller_id) or (blocker_id=l.seller_id and blocked_user_id=actor))
  or destination is null or destination !~ '^acct_[A-Za-z0-9]+$' or not exists(select 1 from public.profiles where id=l.seller_id and stripe_account_id=destination)
 then raise exception 'Listing unavailable' using errcode='42501';end if;
 if exists(select 1 from public.payments where buyer_id=actor and listing_id=listing and (status='paid' and not exists(select 1 from public.conversations c where c.payment_id=payments.id and c.delivery_status='accepted') or status='authorized'))
 then raise exception 'Existing purchase or authorization requires attention' using errcode='42501';end if;
 select * into q from voice_flea_private.voice_checkout_intents where buyer_id=actor and listing_id=listing and state='prepared';
 if q.id is not null then
 if q.seller_id<>l.seller_id or q.stripe_destination<>destination then raise exception 'Checkout destination changed' using errcode='42501';end if;
 return to_jsonb(q);end if;
 r=public.reserve_checkout_attempt(actor,l.seller_id,gen_random_uuid());
 insert into voice_flea_private.voice_checkout_intents(reservation_id,buyer_id,seller_id,listing_id,amount_jpy,title,stripe_destination)
 values(r,actor,l.seller_id,l.id,l.price_jpy,coalesce(l.title,'声のフリマ商品'),destination) returning * into q;
 return to_jsonb(q);
end $$;
revoke all on function public.prepare_voice_checkout(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_voice_checkout(uuid,uuid,text) to service_role;
create or replace function public.finish_checkout_reservation(reservation uuid,session text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 update voice_flea_private.checkout_reservations set state='finished' where (reservation is not null and id=reservation) or (session is not null and session_id=session);
 update voice_flea_private.voice_checkout_intents q set state='finished' from voice_flea_private.checkout_reservations r where q.reservation_id=r.id and r.state='finished';
end $$;
create function public.record_stripe_authorization(snapshot jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare p public.payments; observed timestamptz:=(snapshot->>'stripe_reconciled_at')::timestamptz;
 amount integer:=(snapshot->>'amount_jpy')::integer;expires timestamptz:=(snapshot->>'authorization_expires_at')::timestamptz;
 pi text:=snapshot->>'stripe_payment_intent_id';sess text:=snapshot->>'stripe_checkout_session_id';dest text:=snapshot->>'stripe_destination';q voice_flea_private.voice_checkout_intents;c public.conversations;prior public.payments;live boolean:=(snapshot->>'stripe_livemode')::boolean;
begin
 if amount is null or amount<50 or observed is null or observed>clock_timestamp()+interval '1 minute' or expires is null or live is null
 or pi is null or pi !~ '^pi_[A-Za-z0-9]+$' or sess is null or sess !~ '^cs_[A-Za-z0-9_]+$' or dest is null or dest !~ '^acct_[A-Za-z0-9]+$'
 or snapshot->>'stripe_charge_id' is null or snapshot->>'stripe_charge_id' !~ '^ch_[A-Za-z0-9]+$'
 or snapshot->>'buyer_id' is null or snapshot->>'seller_id' is null or ((snapshot->>'listing_id' is null)=(snapshot->>'job_id' is null)) or (snapshot->>'job_id' is not null and snapshot->>'job_application_id' is null)
 or snapshot->>'buyer_id'=snapshot->>'seller_id' then raise exception 'Invalid authorization snapshot' using errcode='22023';end if;
 if not exists(select 1 from voice_flea_private.voice_checkout_intents verified_quote join voice_flea_private.checkout_reservations r on r.id=verified_quote.reservation_id
 where verified_quote.reservation_id=(snapshot->>'reservation_id')::uuid and verified_quote.buyer_id=(snapshot->>'buyer_id')::uuid and verified_quote.seller_id=(snapshot->>'seller_id')::uuid
 and verified_quote.listing_id is not distinct from (snapshot->>'listing_id')::uuid and verified_quote.job_id is not distinct from (snapshot->>'job_id')::uuid and verified_quote.job_application_id is not distinct from (snapshot->>'job_application_id')::uuid and verified_quote.amount_jpy=amount and verified_quote.stripe_destination=dest and r.session_id=sess)
 then raise exception 'Checkout quote mismatch' using errcode='22023';end if;
 insert into public.payments(listing_id,job_id,job_application_id,buyer_id,seller_id,amount_jpy,platform_fee_jpy,seller_amount_jpy,status,
 stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,stripe_livemode,stripe_reconciled_at,refunded_amount_jpy,
 stripe_capture_method,stripe_destination,authorization_expires_at)
 values((snapshot->>'listing_id')::uuid,(snapshot->>'job_id')::uuid,(snapshot->>'job_application_id')::uuid,(snapshot->>'buyer_id')::uuid,(snapshot->>'seller_id')::uuid,amount,round(amount*0.15),amount-round(amount*0.15),
 case when coalesce((snapshot->>'canceled')::boolean,false) or expires<=observed then 'canceled' else 'authorized' end,sess,pi,snapshot->>'stripe_charge_id',live,observed,0,'manual',dest,expires)
 on conflict(stripe_payment_intent_id) do nothing;
 select * into p from public.payments where stripe_payment_intent_id=pi for update;
 if p.stripe_capture_method<>'manual' or p.amount_jpy<>amount or p.buyer_id<>(snapshot->>'buyer_id')::uuid or p.seller_id<>(snapshot->>'seller_id')::uuid
 or p.listing_id is distinct from (snapshot->>'listing_id')::uuid or p.job_id is distinct from (snapshot->>'job_id')::uuid or p.job_application_id is distinct from (snapshot->>'job_application_id')::uuid or p.stripe_livemode is distinct from live or p.stripe_destination is distinct from dest
 or p.stripe_checkout_session_id is distinct from sess or p.stripe_charge_id is distinct from snapshot->>'stripe_charge_id'
 then raise exception 'Authorization identity mismatch' using errcode='22023';end if;
 if p.status='authorized' and coalesce((snapshot->>'canceled')::boolean,false) and p.stripe_reconciled_at<=observed then update public.payments set status='canceled',stripe_reconciled_at=observed,updated_at=clock_timestamp() where id=p.id returning * into p;end if;
 if p.status='authorized' and expires>observed then
 select * into q from voice_flea_private.voice_checkout_intents where reservation_id=(snapshot->>'reservation_id')::uuid;
 if q.renewal_conversation_id is not null then
 select * into c from public.conversations where id=q.renewal_conversation_id for update;
 if exists(select 1 from voice_flea_private.authorization_cancellations where conversation_id=q.renewal_conversation_id and state in ('queued','canceled')) then raise exception 'Cancellation in progress' using errcode='42501';end if;
 if c.id is null or c.buyer_id<>p.buyer_id or c.seller_id<>p.seller_id or c.listing_id is distinct from p.listing_id or c.job_id is distinct from p.job_id or c.delivery_status='accepted' then raise exception 'Renewal trade mismatch' using errcode='42501';end if;
 if c.payment_id is distinct from p.id then
 select * into prior from public.payments where id=c.payment_id for update;
 if prior.status<>'canceled' or prior.stripe_capture_method<>'manual' or prior.amount_jpy<>p.amount_jpy or prior.stripe_destination is distinct from p.stripe_destination then raise exception 'Original authorization must be canceled' using errcode='42501';end if;
 update voice_flea_private.delivery_acceptances set payment_id=p.id where conversation_id=c.id and state='processing';
 update voice_flea_private.authorization_cancellations set payment_id=p.id,buyer_approved=false,seller_approved=false where conversation_id=c.id and state='requested';
 update public.conversations set payment_id=p.id where id=c.id;
 end if;
 else
 if p.job_id is not null then perform voice_flea_private.ensure_job_purchase_conversation(p.id);else
 insert into public.conversations(listing_id,buyer_id,seller_id,is_inquiry,payment_id,delivery_status)
 select p.listing_id,p.buyer_id,p.seller_id,false,p.id,'none' where not exists(select 1 from public.conversations where payment_id=p.id);
 end if;end if;end if;
end $$;
revoke all on function public.record_stripe_authorization(jsonb) from public,anon,authenticated;
grant execute on function public.record_stripe_authorization(jsonb) to service_role;
create or replace function voice_flea_private.guard_linked_payment_fulfillment()
returns trigger language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 if auth.uid() is null then return new;end if;
 if row(new.delivery_path,new.delivery_status,new.delivered_at,new.accepted_at) is not distinct from row(old.delivery_path,old.delivery_status,old.delivered_at,old.accepted_at) then return new;end if;
 if new.payment_id is null then raise exception 'Verified payment association required before fulfillment' using errcode='42501';end if;
 select * into p from public.payments where id=new.payment_id for share;
 if not found or p.buyer_id is distinct from new.buyer_id or p.seller_id is distinct from new.seller_id
 or not coalesce(voice_flea_private.verified_voice_payment(p) or (new.delivery_status='submitted' and voice_flea_private.active_voice_authorization(p)),false)
 then raise exception 'Verified payment required or authorization expired' using errcode='42501';end if;
 return new;
end $$;
create table voice_flea_private.delivery_acceptances(
 conversation_id uuid primary key references public.conversations(id),payment_id uuid not null unique references public.payments(id),
 buyer_id uuid not null references auth.users(id),delivery_path text not null,state text not null default 'processing' check(state in ('processing','accepted')),
 transfer_id text,created_at timestamptz not null default now(),accepted_at timestamptz);
alter table voice_flea_private.delivery_acceptances enable row level security;
revoke all on voice_flea_private.delivery_acceptances from public,anon,authenticated;
grant select,insert,update on voice_flea_private.delivery_acceptances to service_role;
create function public.prepare_delivery_acceptance(actor uuid,trade_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.conversations;p public.payments;a voice_flea_private.delivery_acceptances;
begin
 if actor is null or not voice_flea_private.account_available(actor) then raise exception 'Sign in required' using errcode='42501';end if;
 select * into c from public.conversations where id=trade_id and buyer_id=actor for update;
 if not found or c.is_inquiry or c.payment_id is null or c.delivery_path is null or c.delivery_status not in ('submitted','accepted') then raise exception 'Delivered purchase required' using errcode='42501';end if;
 select * into p from public.payments where id=c.payment_id for update;
 if not found or p.buyer_id<>actor or p.seller_id<>c.seller_id or p.listing_id is distinct from c.listing_id or p.job_id is distinct from c.job_id
 or not coalesce(voice_flea_private.verified_voice_payment(p) or (p.payment_channel='web' and p.status='authorized' and p.stripe_capture_method='manual' and p.stripe_reconciled_at is not null and p.stripe_livemode is not null and p.refunded_amount_jpy=0),false) then raise exception 'Verified payment required or authorization expired' using errcode='42501';end if;
 if exists(select 1 from voice_flea_private.trade_cancellations where conversation_id=c.id and state in ('queued','succeeded','needs_review')) or exists(select 1 from voice_flea_private.authorization_cancellations where conversation_id=c.id and state in ('queued','canceled')) then raise exception 'Cancellation in progress' using errcode='42501';end if;
 select * into a from voice_flea_private.delivery_acceptances where conversation_id=c.id;
 if a.conversation_id is null then
 if c.delivery_status='accepted' then raise exception 'Legacy receipt requires review' using errcode='42501';end if;
 insert into voice_flea_private.delivery_acceptances(conversation_id,payment_id,buyer_id,delivery_path) values(c.id,p.id,actor,c.delivery_path) returning * into a;
 elsif a.payment_id<>p.id or a.buyer_id<>actor or a.delivery_path<>c.delivery_path then raise exception 'Receipt identity mismatch' using errcode='42501';end if;
 return jsonb_build_object('payment',to_jsonb(p),'conversation',to_jsonb(c),'alreadyAccepted',a.state='accepted');
end $$;
revoke all on function public.prepare_delivery_acceptance(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_delivery_acceptance(uuid,uuid) to service_role;
create function public.finalize_delivery_acceptance(actor uuid,trade_id uuid,transfer text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.conversations;p public.payments;a voice_flea_private.delivery_acceptances;
begin
 select * into c from public.conversations where id=trade_id and buyer_id=actor for update;
 if not found or c.payment_id is null or c.delivery_status not in ('submitted','accepted') then raise exception 'Receipt unavailable' using errcode='42501';end if;
 select * into p from public.payments where id=c.payment_id for update;
 select * into a from voice_flea_private.delivery_acceptances where conversation_id=c.id for update;
 if a.conversation_id is null or a.payment_id<>p.id or a.buyer_id<>actor or a.delivery_path is distinct from c.delivery_path
 or not coalesce(voice_flea_private.verified_voice_payment(p),false) then raise exception 'Verified captured payment required' using errcode='42501';end if;
 if p.payment_channel='web' and (p.stripe_reconciled_at<clock_timestamp()-interval '1 minute' or p.stripe_capture_method='manual' and (transfer is null or transfer !~ '^tr_[A-Za-z0-9]+$')) then raise exception 'Fresh capture and transfer evidence required' using errcode='42501';end if;
 if exists(select 1 from voice_flea_private.trade_cancellations where conversation_id=c.id and state in ('queued','succeeded','needs_review')) or exists(select 1 from voice_flea_private.authorization_cancellations where conversation_id=c.id and state in ('queued','canceled')) then raise exception 'Cancellation in progress' using errcode='42501';end if;
 if a.state='accepted' then return to_jsonb(c);end if;
 update voice_flea_private.delivery_acceptances set state='accepted',accepted_at=clock_timestamp(),transfer_id=transfer where conversation_id=c.id;
 update public.payments set paid_at=coalesce(paid_at,stripe_reconciled_at) where id=p.id and stripe_capture_method='manual';
 insert into public.messages(conversation_id,sender_id,body) values(c.id,actor,'✅ 購入者が納品を受け取りました。支払いを照合しました。');
 update public.conversations set delivery_status='accepted',accepted_at=clock_timestamp() where id=c.id returning * into c;
 if c.job_id is not null then update public.jobs set status='closed' where id=c.job_id;end if;
 return to_jsonb(c);
end $$;
revoke all on function public.finalize_delivery_acceptance(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.finalize_delivery_acceptance(uuid,uuid,text) to service_role;
create function voice_flea_private.guard_receipt_acceptance()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is not null and row(new.delivery_path,new.delivery_status,new.delivered_at,new.accepted_at) is distinct from row(old.delivery_path,old.delivery_status,old.delivered_at,old.accepted_at)
 and (new.delivery_status='accepted' or exists(select 1 from voice_flea_private.delivery_acceptances where conversation_id=old.id) or exists(select 1 from voice_flea_private.authorization_cancellations where conversation_id=old.id and state in ('queued','canceled'))) then raise exception 'Server receipt confirmation required' using errcode='42501';end if;
 return new;
end $$;
revoke all on function voice_flea_private.guard_receipt_acceptance() from public,anon,authenticated;
create trigger guard_receipt_acceptance before update on public.conversations for each row execute function voice_flea_private.guard_receipt_acceptance();

create or replace function voice_flea_private.guard_conversation_payment()
returns trigger language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 if tg_op='UPDATE' then
  if new.payment_id is distinct from old.payment_id then
 if auth.uid() is not null or not exists(
 select 1 from public.payments oldp,public.payments fresh,voice_flea_private.voice_checkout_intents q,voice_flea_private.checkout_reservations r
 where oldp.id=old.payment_id and oldp.status='canceled' and oldp.stripe_capture_method='manual'
 and fresh.id=new.payment_id and voice_flea_private.active_voice_authorization(fresh)
 and fresh.buyer_id=old.buyer_id and fresh.seller_id=old.seller_id and fresh.listing_id is not distinct from old.listing_id and fresh.job_id is not distinct from old.job_id
 and fresh.amount_jpy=oldp.amount_jpy and fresh.stripe_destination=oldp.stripe_destination
 and q.renewal_conversation_id=old.id and q.reservation_id=r.id and r.session_id=fresh.stripe_checkout_session_id)
 then raise exception 'Payment association cannot change' using errcode='42501';end if;
 end if;
  return new;
 end if;
 if new.payment_id is null then return new;end if;
 select * into p from public.payments where id=new.payment_id for share;
 if not found or new.is_inquiry or p.job_id is distinct from new.job_id or p.listing_id is distinct from new.listing_id
  or p.buyer_id is distinct from new.buyer_id or p.seller_id is distinct from new.seller_id then
  raise exception 'Payment does not identify this trade' using errcode='42501';end if;
 if not coalesce(voice_flea_private.verified_voice_payment(p) or voice_flea_private.active_voice_authorization(p),false) then
  raise exception 'Verified paid purchase required' using errcode='42501';end if;
 return new;
end $$;


-- Both parties agree before an undelivered authorization is released. This is
-- not a refund: money has not been captured. Client roles cannot move money.
create table voice_flea_private.authorization_cancellations(
 conversation_id uuid primary key references public.conversations(id),payment_id uuid not null unique references public.payments(id),
 buyer_approved boolean not null default false,seller_approved boolean not null default false,
 state text not null default 'requested' check(state in ('requested','queued','canceled')),created_at timestamptz not null default now());
alter table voice_flea_private.authorization_cancellations enable row level security;
revoke all on voice_flea_private.authorization_cancellations from public,anon,authenticated;
grant select,insert,update on voice_flea_private.authorization_cancellations to service_role;
create function public.prepare_authorization_cancellation(actor uuid,trade_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.conversations;p public.payments;r voice_flea_private.authorization_cancellations;
begin
 if actor is null or not voice_flea_private.account_available(actor) then raise exception 'Sign in required' using errcode='42501';end if;
 select * into c from public.conversations where id=trade_id and actor in (buyer_id,seller_id) for update;
 if not found or c.is_inquiry or c.payment_id is null or c.delivery_status<>'none' or c.delivery_path is not null then raise exception 'Undelivered trade required' using errcode='42501';end if;
 if exists(select 1 from voice_flea_private.voice_checkout_intents where renewal_conversation_id=c.id and state='prepared') then raise exception 'Reauthorization in progress' using errcode='42501';end if;
 select * into p from public.payments where id=c.payment_id for update;
 if p.payment_channel<>'web' or p.stripe_capture_method<>'manual' or p.status not in ('authorized','canceled')
 or p.buyer_id is distinct from c.buyer_id or p.seller_id is distinct from c.seller_id or p.refunded_amount_jpy is distinct from 0
 then raise exception 'Authorization required' using errcode='42501';end if;
 insert into voice_flea_private.authorization_cancellations(conversation_id,payment_id,buyer_approved,seller_approved)
 values(c.id,p.id,actor=c.buyer_id,actor=c.seller_id)
 on conflict(conversation_id) do update set
 buyer_approved=authorization_cancellations.buyer_approved or excluded.buyer_approved,
 seller_approved=authorization_cancellations.seller_approved or excluded.seller_approved returning * into r;
 if r.payment_id<>p.id then raise exception 'Cancellation identity mismatch' using errcode='42501';end if;
 if r.buyer_approved and r.seller_approved and r.state='requested' then
 update voice_flea_private.authorization_cancellations set state='queued' where conversation_id=c.id returning * into r;
 end if;
 return jsonb_build_object('state',r.state,'ready',r.buyer_approved and r.seller_approved,'payment',to_jsonb(p));
end $$;
revoke all on function public.prepare_authorization_cancellation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_authorization_cancellation(uuid,uuid) to service_role;
create function public.finish_authorization_cancellation(actor uuid,trade_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare c public.conversations;p public.payments;r voice_flea_private.authorization_cancellations;
begin
 select * into c from public.conversations where id=trade_id and actor in (buyer_id,seller_id) for update;
 if not found or c.delivery_status<>'none' or c.delivery_path is not null then raise exception 'Undelivered trade required' using errcode='42501';end if;
 select * into p from public.payments where id=c.payment_id for update;
 select * into r from voice_flea_private.authorization_cancellations where conversation_id=c.id for update;
 if r.conversation_id is null or r.payment_id is distinct from p.id or not r.buyer_approved or not r.seller_approved
 or p.stripe_capture_method<>'manual' or p.status not in ('authorized','canceled') then raise exception 'Agreed authorization cancellation required' using errcode='42501';end if;
 update public.payments set status='canceled',stripe_reconciled_at=clock_timestamp(),updated_at=clock_timestamp() where id=p.id;
 if c.job_id is not null then update public.jobs set status='cancelled' where id=c.job_id;end if;
 if r.state<>'canceled' then
 update voice_flea_private.authorization_cancellations set state='canceled' where conversation_id=c.id;
 insert into public.messages(conversation_id,sender_id,body) values(c.id,actor,'✅ 双方の同意により取引をキャンセルしました。代金の与信を解除しました。カード会社による表示の更新には時間がかかる場合があります。');
 end if;
end $$;
revoke all on function public.finish_authorization_cancellation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.finish_authorization_cancellation(uuid,uuid) to service_role;
create function voice_flea_private.authorization_cancellation_status(trade_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.conversations;p public.payments;r voice_flea_private.authorization_cancellations;
begin
 select * into c from public.conversations where id=trade_id and auth.uid() in (buyer_id,seller_id);
 if not found then raise exception 'Trade unavailable' using errcode='42501';end if;
 select * into p from public.payments where id=c.payment_id;
 select * into r from voice_flea_private.authorization_cancellations where conversation_id=c.id;
 return jsonb_build_object('manual',p.stripe_capture_method='manual','paymentState',p.status,'amountJpy',p.amount_jpy,'authorizationExpired',p.stripe_capture_method='manual' and p.status in ('authorized','canceled') and p.authorization_expires_at<=now() and c.delivery_status<>'accepted' and coalesce(r.state,'none') not in ('queued','canceled'),'canRenew',auth.uid()=c.buyer_id and p.stripe_capture_method='manual' and p.status in ('authorized','canceled') and p.authorization_expires_at<=now() and c.delivery_status<>'accepted' and coalesce(r.state,'none') not in ('queued','canceled'),'state',coalesce(r.state,'none'),'buyerApproved',coalesce(r.buyer_approved,false),'sellerApproved',coalesce(r.seller_approved,false),
 'canApprove',p.status in ('authorized','canceled') and p.stripe_capture_method='manual' and c.delivery_status='none' and c.delivery_path is null and coalesce(r.state,'requested')<>'canceled' and not exists(select 1 from voice_flea_private.voice_checkout_intents where renewal_conversation_id=c.id and state='prepared'));
end $$;
revoke all on function voice_flea_private.authorization_cancellation_status(uuid) from public,anon;
grant execute on function voice_flea_private.authorization_cancellation_status(uuid) to authenticated;
create function public.authorization_cancellation_status(trade_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$select voice_flea_private.authorization_cancellation_status(trade_id)$$;
revoke all on function public.authorization_cancellation_status(uuid) from public,anon;
grant execute on function public.authorization_cancellation_status(uuid) to authenticated;
revoke all on function public.finish_checkout_reservation(uuid,text) from public,anon,authenticated;
grant execute on function public.finish_checkout_reservation(uuid,text) to service_role;

-- Reauthorization preserves the original conversation and delivery. Old payment
-- attempts remain as canceled records; a fresh authorization gets a new payment.
create function public.inspect_delivery_renewal(actor uuid,trade_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.conversations;p public.payments;
begin
 if actor is null or not voice_flea_private.account_available(actor) then raise exception 'Sign in required' using errcode='42501';end if;
 select * into c from public.conversations where id=trade_id and buyer_id=actor;
 if not found or c.is_inquiry or c.payment_id is null or c.delivery_status='accepted' then raise exception 'Renewal unavailable' using errcode='42501';end if;
 select * into p from public.payments where id=c.payment_id;
 if not found or p.payment_channel<>'web' or p.stripe_capture_method<>'manual' or p.status not in ('authorized','canceled')
 or p.buyer_id is distinct from actor or p.seller_id is distinct from c.seller_id or p.listing_id is distinct from c.listing_id or p.job_id is distinct from c.job_id
 or not voice_flea_private.account_available(c.seller_id) or p.refunded_amount_jpy is distinct from 0
 or not exists(select 1 from public.profiles where id=p.seller_id and stripe_account_id=p.stripe_destination)
 or exists(select 1 from public.user_blocks where (blocker_id=p.buyer_id and blocked_user_id=p.seller_id) or (blocker_id=p.seller_id and blocked_user_id=p.buyer_id))
 then raise exception 'Renewal unavailable' using errcode='42501';end if;
 if exists(select 1 from voice_flea_private.authorization_cancellations where conversation_id=c.id and state in ('queued','canceled'))
 or exists(select 1 from voice_flea_private.trade_cancellations where conversation_id=c.id and state in ('queued','succeeded','needs_review'))
 then raise exception 'Cancellation in progress' using errcode='42501';end if;
 return jsonb_build_object('payment',to_jsonb(p),'conversation',to_jsonb(c));
end $$;
revoke all on function public.inspect_delivery_renewal(uuid,uuid) from public,anon,authenticated;
grant execute on function public.inspect_delivery_renewal(uuid,uuid) to service_role;
create function public.prepare_voice_renewal_checkout(actor uuid,trade_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.conversations;p public.payments;q voice_flea_private.voice_checkout_intents;r uuid;title text;
begin
 select * into c from public.conversations where id=trade_id and buyer_id=actor for update;
 if not found then raise exception 'Renewal unavailable' using errcode='42501';end if;
 perform public.inspect_delivery_renewal(actor,trade_id);
 select * into p from public.payments where id=c.payment_id for update;
 if p.status not in ('authorized','canceled') then raise exception 'Captured payment must not be renewed' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||coalesce(p.listing_id,p.job_application_id)::text,84));
 select * into q from voice_flea_private.voice_checkout_intents where buyer_id=actor and (listing_id=p.listing_id or job_application_id=p.job_application_id) and state='prepared';
 if q.id is not null then
 if q.renewal_conversation_id is distinct from c.id or q.amount_jpy<>p.amount_jpy or q.stripe_destination<>p.stripe_destination then raise exception 'Existing checkout requires attention' using errcode='42501';end if;
 return to_jsonb(q);end if;
 -- The Edge has freshly confirmed that Stripe canceled this exact intent.
 update public.payments set status='canceled',stripe_reconciled_at=clock_timestamp(),updated_at=clock_timestamp() where id=p.id;
 select qi.title into title from voice_flea_private.voice_checkout_intents qi join voice_flea_private.checkout_reservations cr on cr.id=qi.reservation_id where cr.session_id=p.stripe_checkout_session_id;
 if title is null then raise exception 'Original quote unavailable' using errcode='42501';end if;
 r=public.reserve_checkout_attempt(p.buyer_id,p.seller_id,gen_random_uuid());
 insert into voice_flea_private.voice_checkout_intents(reservation_id,buyer_id,seller_id,listing_id,job_id,job_application_id,amount_jpy,title,stripe_destination,renewal_conversation_id)
 values(r,p.buyer_id,p.seller_id,p.listing_id,p.job_id,p.job_application_id,p.amount_jpy,title,p.stripe_destination,c.id) returning * into q;
 return to_jsonb(q);
end $$;
revoke all on function public.prepare_voice_renewal_checkout(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_voice_renewal_checkout(uuid,uuid) to service_role;

create function public.record_voice_authorization_canceled(intent_id text,live boolean,observed timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 if intent_id is null or intent_id !~ '^pi_[A-Za-z0-9]+$' or live is null or observed is null or observed>clock_timestamp()+interval '1 minute' then raise exception 'Invalid cancellation snapshot' using errcode='22023';end if;
 select * into p from public.payments where stripe_payment_intent_id=intent_id for update;
 if not found then raise exception 'Authorization snapshot required first' using errcode='P0002';end if;
 if p.stripe_livemode is distinct from live or p.stripe_capture_method<>'manual' then raise exception 'Authorization identity mismatch' using errcode='22023';end if;
 if p.status='authorized' and p.stripe_reconciled_at<=observed then update public.payments set status='canceled',stripe_reconciled_at=observed,updated_at=clock_timestamp() where id=p.id;end if;
end $$;
revoke all on function public.record_voice_authorization_canceled(text,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.record_voice_authorization_canceled(text,boolean,timestamptz) to service_role;
