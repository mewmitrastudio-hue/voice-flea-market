-- Approved application terms become an immutable, server-owned purchase quote.
alter table public.applications add column agreed_price_jpy integer check(agreed_price_jpy between 50 and 99999999);
alter table public.applications add column agreed_at timestamptz;
create function voice_flea_private.guard_job_contract()
returns trigger language plpgsql security definer set search_path='' as $$
declare j public.jobs;actor uuid:=auth.uid();
begin
 select * into j from public.jobs where id=new.job_id for update;
 if not found then raise exception 'Job unavailable' using errcode='42501';end if;
 if tg_op='INSERT' then
  if actor is not null and (actor<>new.applicant_id or actor=j.buyer_id or new.status<>'pending' or new.agreed_price_jpy is not null or new.agreed_at is not null) then raise exception 'Invalid application' using errcode='42501';end if;
  if new.proposed_price_jpy is null then new.proposed_price_jpy=j.budget_jpy;end if;
 else
  if new.job_id is distinct from old.job_id or new.applicant_id is distinct from old.applicant_id then raise exception 'Application identity cannot change' using errcode='42501';end if;
  if new.agreed_price_jpy is distinct from old.agreed_price_jpy or new.agreed_at is distinct from old.agreed_at then raise exception 'Contract terms are server-owned' using errcode='42501';end if;
  if row(new.proposed_price_jpy,new.delivery_days) is distinct from row(old.proposed_price_jpy,old.delivery_days)
   and (old.agreed_at is not null or actor is distinct from old.applicant_id) then raise exception 'Agreed offer cannot change' using errcode='42501';end if;
  if new.status is distinct from old.status and actor is not null and actor<>j.buyer_id then raise exception 'Buyer decision required' using errcode='42501';end if;
  if old.status='accepted' and new.status<>old.status and (exists(select 1 from public.payments where job_application_id=old.id and status in ('authorized','paid','partially_refunded')) or exists(select 1 from voice_flea_private.voice_checkout_intents where job_application_id=old.id and state='prepared') or exists(select 1 from voice_flea_private.voice_iap_orders where job_application_id=old.id and state='prepared')) then raise exception 'Resolve the paid contract first' using errcode='42501';end if;
  if new.status='accepted' and old.status<>'accepted' then
   if j.status<>'open' or exists(select 1 from public.applications where job_id=j.id and status='accepted' and id<>new.id) then raise exception 'A contractor has already been selected' using errcode='42501';end if;
   new.agreed_price_jpy=coalesce(old.proposed_price_jpy,old.agreed_price_jpy,j.budget_jpy);new.agreed_at=clock_timestamp();
  end if;
 end if;
 if new.proposed_price_jpy not between 50 and 99999999 then raise exception 'Invalid offer amount' using errcode='22023';end if;
 return new;
end $$;
revoke all on function voice_flea_private.guard_job_contract() from public,anon,authenticated;
create trigger guard_job_contract before insert or update on public.applications for each row execute function voice_flea_private.guard_job_contract();

create function public.prepare_job_checkout(actor uuid,application uuid,destination text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.applications;j public.jobs;q voice_flea_private.voice_checkout_intents;r uuid;
begin
 if actor is null or not voice_flea_private.account_available(actor) then raise exception 'Sign in required' using errcode='42501';end if;
 select * into a from public.applications where id=application for update;
 if not found then raise exception 'Accepted application required' using errcode='42501';end if;
 select * into j from public.jobs where id=a.job_id for update;
 if j.buyer_id is distinct from actor or j.status<>'open' or a.status<>'accepted' or a.agreed_price_jpy is null or a.agreed_at is null
 or a.applicant_id=actor or not voice_flea_private.account_available(a.applicant_id)
 or exists(select 1 from public.user_blocks where (blocker_id=actor and blocked_user_id=a.applicant_id) or (blocker_id=a.applicant_id and blocked_user_id=actor))
 or not exists(select 1 from public.profiles where id=a.applicant_id and stripe_account_id=destination)
 then raise exception 'Agreed job contract unavailable' using errcode='42501';end if;
 if exists(select 1 from public.payments where job_id=j.id) then raise exception 'Use the existing job transaction' using errcode='42501';end if;
 if exists(select 1 from voice_flea_private.voice_iap_orders where job_id=j.id and state='prepared') then raise exception 'Resolve the existing Apple purchase first' using errcode='42501';end if;
 select * into q from voice_flea_private.voice_checkout_intents where job_application_id=a.id and state='prepared';
 if found then
 if q.stripe_destination<>destination or q.amount_jpy<>a.agreed_price_jpy or q.buyer_id<>actor then raise exception 'Contract quote mismatch' using errcode='42501';end if;
 return to_jsonb(q);end if;
 r=public.reserve_checkout_attempt(actor,a.applicant_id,gen_random_uuid());
 insert into voice_flea_private.voice_checkout_intents(reservation_id,buyer_id,seller_id,job_id,job_application_id,amount_jpy,title,stripe_destination)
 values(r,actor,a.applicant_id,j.id,a.id,a.agreed_price_jpy,j.title,destination) returning * into q;
 return to_jsonb(q);
end $$;
revoke all on function public.prepare_job_checkout(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_job_checkout(uuid,uuid,text) to service_role;

create function voice_flea_private.ensure_job_purchase_conversation(purchase_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.payments;c public.conversations;a public.applications;
begin
 select * into p from public.payments where id=purchase_id for update;
 if not found or p.job_id is null or p.job_application_id is null or not coalesce(voice_flea_private.verified_voice_payment(p) or voice_flea_private.active_voice_authorization(p),false) then raise exception 'Verified job purchase required' using errcode='42501';end if;
 -- A verified late receipt remains durable even after an account is closed.
 if not voice_flea_private.account_available(p.buyer_id) or not voice_flea_private.account_available(p.seller_id) then return null;end if;
 select * into a from public.applications where id=p.job_application_id and job_id=p.job_id and applicant_id=p.seller_id;
 if not found or a.agreed_price_jpy is distinct from p.amount_jpy then raise exception 'Job purchase identity mismatch' using errcode='42501';end if;
 select * into c from public.conversations where payment_id=p.id;
 if found then return to_jsonb(c);end if;
 select * into c from public.conversations where job_id=p.job_id and buyer_id=p.buyer_id and seller_id=p.seller_id and payment_id is null and not is_inquiry and delivery_status='none' and delivery_path is null order by created_at,id limit 1 for update;
 if found then update public.conversations set payment_id=p.id where id=c.id returning * into c;
 else insert into public.conversations(job_id,buyer_id,seller_id,is_inquiry,payment_id,delivery_status) values(p.job_id,p.buyer_id,p.seller_id,false,p.id,'none') returning * into c;end if;
 update public.jobs set status='in_progress' where id=p.job_id and status='open';
 return to_jsonb(c);
end $$;
revoke all on function voice_flea_private.ensure_job_purchase_conversation(uuid) from public,anon,authenticated;

alter table voice_flea_private.voice_iap_orders alter column listing_id drop not null;
alter table voice_flea_private.voice_iap_orders add column job_id uuid references public.jobs(id) on delete restrict;
alter table voice_flea_private.voice_iap_orders add column job_application_id uuid references public.applications(id) on delete restrict;
alter table voice_flea_private.voice_iap_orders add constraint voice_iap_target check(
 listing_id is not null and job_id is null and job_application_id is null or listing_id is null and job_id is not null and job_application_id is not null);
insert into voice_flea_private.voice_iap_products(product_id,amount_jpy) values('com.ayuhide.koenofurima.voice.jpy1500',1500) on conflict do nothing;
create function public.prepare_job_voice_iap_order(owner_id uuid,application uuid,attempt uuid,tx_environment text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.applications;j public.jobs;o voice_flea_private.voice_iap_orders;product voice_flea_private.voice_iap_products;
begin
 if owner_id is null or attempt is null or tx_environment not in ('Sandbox','Production') or not voice_flea_private.account_available(owner_id) then raise exception 'Purchase unavailable' using errcode='42501';end if;
 select * into a from public.applications where id=application for update;
 if not found then raise exception 'Accepted application required' using errcode='42501';end if;
 select * into j from public.jobs where id=a.job_id for update;
 if j.buyer_id is distinct from owner_id or j.status<>'open' or a.status<>'accepted' or a.agreed_price_jpy is null or a.agreed_at is null
 or a.applicant_id=owner_id or not voice_flea_private.account_available(a.applicant_id)
 or exists(select 1 from public.user_blocks where (blocker_id=owner_id and blocked_user_id=a.applicant_id) or (blocker_id=a.applicant_id and blocked_user_id=owner_id)) then raise exception 'Agreed contract unavailable' using errcode='42501';end if;
 if exists(select 1 from public.payments where job_id=j.id) then raise exception 'Use the existing job transaction' using errcode='42501';end if;
 if exists(select 1 from voice_flea_private.voice_checkout_intents where job_id=j.id and state='prepared') then raise exception 'Resolve the existing Web purchase first' using errcode='42501';end if;
 select * into product from voice_flea_private.voice_iap_products where amount_jpy=a.agreed_price_jpy and case when tx_environment='Production' then production_enabled else sandbox_enabled end;
 if not found then raise exception 'Apple product not ready' using errcode='55000';end if;
 select * into o from voice_flea_private.voice_iap_orders where id=attempt;
 if found and (o.buyer_id<>owner_id or o.job_application_id is distinct from a.id or o.environment<>tx_environment or o.amount_jpy<>a.agreed_price_jpy) then raise exception 'Order mismatch' using errcode='42501';end if;
 if o.id is null then select * into o from voice_flea_private.voice_iap_orders where job_application_id=a.id and buyer_id=owner_id and state='prepared' and environment=tx_environment order by created_at limit 1;end if;
 if o.id is null then
 insert into voice_flea_private.voice_iap_orders(id,buyer_id,seller_id,job_id,job_application_id,product_id,amount_jpy,environment)
 values(attempt,owner_id,a.applicant_id,j.id,a.id,product.product_id,a.agreed_price_jpy,tx_environment) returning * into o;
 end if;
 return jsonb_build_object('sellerId',o.seller_id,'orderId',o.id,'productId',o.product_id,'amountJpy',o.amount_jpy,'environment',o.environment,'state',o.state);
end $$;
revoke all on function public.prepare_job_voice_iap_order(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_job_voice_iap_order(uuid,uuid,uuid,text) to service_role;

create or replace function public.apply_verified_apple_voice(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,price_milliunits bigint,currency text,revoked boolean,actor uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o voice_flea_private.voice_iap_orders; p public.payments; c public.conversations;
begin
 select * into o from voice_flea_private.voice_iap_orders where id=order_id for update;
 if not found or (actor is not null and actor<>o.buyer_id) or sku is distinct from o.product_id
  or tx_environment is distinct from o.environment or tx_id is null or tx_id !~ '^[0-9]{1,40}$'
  or purchased_at is null or purchased_at<o.created_at-interval '10 minutes' or purchased_at>now()+interval '5 minutes'
  or currency is distinct from 'JPY' or price_milliunits is distinct from o.amount_jpy::bigint*1000
  or revoked is null then raise exception 'Transaction mismatch' using errcode='42501';end if;
 if o.transaction_id is not null and o.transaction_id<>tx_id then raise exception 'Order already consumed' using errcode='23505';end if;
 if o.payment_id is null then
  insert into public.payments(listing_id,job_id,job_application_id,buyer_id,seller_id,amount_jpy,platform_fee_jpy,seller_amount_jpy,status,
   payment_channel,apple_transaction_id,apple_environment,apple_verified_at,paid_at,refunded_amount_jpy,refunded_at)
  values(o.listing_id,o.job_id,o.job_application_id,o.buyer_id,o.seller_id,o.amount_jpy,null,null,case when revoked then 'refunded' else 'paid' end,
   'ios',tx_id,tx_environment,now(),purchased_at,case when revoked then o.amount_jpy else 0 end,case when revoked then now() end)
  returning * into p;
  update voice_flea_private.voice_iap_orders set payment_id=p.id,transaction_id=tx_id,
   state=case when revoked then 'revoked' else 'paid' end where id=o.id;
 else
  select * into p from public.payments where id=o.payment_id for update;
  if revoked or o.state='revoked' then
   update public.payments set status='refunded',refunded_amount_jpy=amount_jpy,
    refunded_at=coalesce(refunded_at,now()),apple_verified_at=now(),updated_at=now() where id=p.id returning * into p;
   update voice_flea_private.voice_iap_orders set state='revoked' where id=o.id;
  end if;
 end if;
 select * into c from public.conversations where payment_id=p.id;
 if c.id is null and p.status='paid' and voice_flea_private.account_available(p.buyer_id) and voice_flea_private.account_available(p.seller_id) then
  if o.job_id is not null then perform voice_flea_private.ensure_job_purchase_conversation(p.id);select * into c from public.conversations where payment_id=p.id;else
  insert into public.conversations(listing_id,buyer_id,seller_id,is_inquiry,payment_id,delivery_status)
  values(o.listing_id,o.buyer_id,o.seller_id,false,p.id,'none') returning * into c;
 end if;end if;
 return jsonb_build_object('paymentId',p.id,'conversationId',c.id,'environment',tx_environment,
  'revoked',p.status='refunded','state',p.status);
end $$;
revoke all on function public.apply_verified_apple_voice(uuid,text,text,text,timestamptz,bigint,text,boolean,uuid) from public,anon,authenticated;
grant execute on function public.apply_verified_apple_voice(uuid,text,text,text,timestamptz,bigint,text,boolean,uuid) to service_role;


create or replace function voice_flea_private.guard_conversation_payment()
returns trigger language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 if tg_op='UPDATE' then
  if new.payment_id is distinct from old.payment_id then
 if auth.uid() is null and old.payment_id is null and old.job_id is not null and old.delivery_status='none' and old.delivery_path is null and exists(
 select 1 from public.payments fresh where fresh.id=new.payment_id and fresh.job_id=old.job_id and fresh.buyer_id=old.buyer_id and fresh.seller_id=old.seller_id
 and (voice_flea_private.verified_voice_payment(fresh) or voice_flea_private.active_voice_authorization(fresh))) then return new;end if;
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



create or replace function public.prepare_voice_iap_order(owner_id uuid,listing uuid,attempt uuid,tx_environment text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.listings; o voice_flea_private.voice_iap_orders; product voice_flea_private.voice_iap_products;
begin
 if owner_id is null or attempt is null or tx_environment is null or tx_environment not in ('Sandbox','Production')
  or not voice_flea_private.account_available(owner_id) then raise exception 'Purchase unavailable' using errcode='42501';end if;
 -- Same buyer/listing requests serialize, including requests in different tabs.
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text||listing::text,83));
 select * into o from voice_flea_private.voice_iap_orders where id=attempt;
 if found then
  if o.buyer_id<>owner_id or o.listing_id<>listing or o.environment<>tx_environment then
   raise exception 'Order mismatch' using errcode='42501';end if;
  if o.state<>'prepared' then
   return jsonb_build_object('sellerId',o.seller_id,'orderId',o.id,'productId',o.product_id,'amountJpy',o.amount_jpy,'environment',o.environment,'state',o.state);
  end if;
 end if;
 select * into l from public.listings where id=listing and is_active for share;
 if not found or l.seller_id=owner_id or not voice_flea_private.account_available(l.seller_id) or exists(
  select 1 from public.user_blocks b where (b.blocker_id=owner_id and b.blocked_user_id=l.seller_id)
   or (b.blocker_id=l.seller_id and b.blocked_user_id=owner_id)) then
  raise exception 'Listing unavailable' using errcode='42501';end if;
 select * into product from voice_flea_private.voice_iap_products where amount_jpy=l.price_jpy
  and case when tx_environment='Production' then production_enabled else sandbox_enabled end;
 if not found then raise exception 'Apple product not ready' using errcode='55000';end if;
 if o.id is not null and (o.product_id<>product.product_id or o.amount_jpy<>l.price_jpy or o.seller_id<>l.seller_id) then
  raise exception 'Order price changed' using errcode='22023';end if;
 -- Reuse the one unconsumed intent so a lost response cannot cause two orders.
 select * into o from voice_flea_private.voice_iap_orders where buyer_id=owner_id and listing_id=listing
  and environment=tx_environment and state='prepared' and product_id=product.product_id and amount_jpy=l.price_jpy
  order by created_at desc limit 1;
 if not found then
  insert into voice_flea_private.voice_iap_orders(id,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment)
  values(attempt,owner_id,l.seller_id,l.id,product.product_id,l.price_jpy,tx_environment) returning * into o;
 end if;
 return jsonb_build_object('sellerId',o.seller_id,'orderId',o.id,'productId',o.product_id,'amountJpy',o.amount_jpy,'environment',o.environment,'state',o.state);
end $$;
revoke all on function public.prepare_voice_iap_order(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_voice_iap_order(uuid,uuid,uuid,text) to service_role;


create function voice_flea_private.review_job_application(application_id uuid,decision text,expected_price integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.applications;j public.jobs;actor uuid:=auth.uid();amount integer;
begin
 if actor is null or not voice_flea_private.account_available(actor) or decision not in ('accepted','rejected') then raise exception 'Buyer decision required' using errcode='42501';end if;
 select * into a from public.applications where id=application_id for update;
 if not found then raise exception 'Application unavailable' using errcode='42501';end if;
 select * into j from public.jobs where id=a.job_id for update;
 if j.buyer_id is distinct from actor then raise exception 'Buyer decision required' using errcode='42501';end if;
 amount=coalesce(a.proposed_price_jpy,a.agreed_price_jpy,j.budget_jpy);
 if decision='accepted' and (expected_price is null or expected_price<>amount) then raise exception 'Offer changed; confirm the current amount' using errcode='22023';end if;
 update public.applications set status=decision where id=a.id returning * into a;
 return to_jsonb(a);
end $$;
revoke all on function voice_flea_private.review_job_application(uuid,text,integer) from public,anon;
grant execute on function voice_flea_private.review_job_application(uuid,text,integer) to authenticated;
create function public.review_job_application(application_id uuid,decision text,expected_price integer)
returns jsonb language sql security invoker set search_path='' as $$select voice_flea_private.review_job_application(application_id,decision,expected_price)$$;
revoke all on function public.review_job_application(uuid,text,integer) from public,anon;
grant execute on function public.review_job_application(uuid,text,integer) to authenticated;

create or replace function voice_flea_private.authorization_cancellation_status(trade_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.conversations;p public.payments;r voice_flea_private.authorization_cancellations;a public.applications;
begin
 select * into c from public.conversations where id=trade_id and auth.uid() in (buyer_id,seller_id);
 if not found then raise exception 'Trade unavailable' using errcode='42501';end if;
 select * into p from public.payments where id=c.payment_id;
 select * into r from voice_flea_private.authorization_cancellations where conversation_id=c.id;
 if c.job_id is not null and c.payment_id is null then select * into a from public.applications where job_id=c.job_id and applicant_id=c.seller_id and status='accepted' order by created_at,id limit 1;end if;
 return jsonb_build_object('needsPayment',c.payment_id is null,'canFulfill',coalesce(voice_flea_private.verified_voice_payment(p) or voice_flea_private.active_voice_authorization(p),false),'applicationId',a.id,'agreedAmountJpy',a.agreed_price_jpy,'manual',p.stripe_capture_method='manual','paymentState',p.status,'amountJpy',p.amount_jpy,'authorizationExpired',p.stripe_capture_method='manual' and p.status in ('authorized','canceled') and p.authorization_expires_at<=now() and c.delivery_status<>'accepted' and coalesce(r.state,'none') not in ('queued','canceled'),'canRenew',auth.uid()=c.buyer_id and p.stripe_capture_method='manual' and p.status in ('authorized','canceled') and p.authorization_expires_at<=now() and c.delivery_status<>'accepted' and coalesce(r.state,'none') not in ('queued','canceled'),'state',coalesce(r.state,'none'),'buyerApproved',coalesce(r.buyer_approved,false),'sellerApproved',coalesce(r.seller_approved,false),
 'canApprove',p.status in ('authorized','canceled') and p.stripe_capture_method='manual' and c.delivery_status='none' and c.delivery_path is null and coalesce(r.state,'requested')<>'canceled' and not exists(select 1 from voice_flea_private.voice_checkout_intents where renewal_conversation_id=c.id and state='prepared'));
end $$;

create function voice_flea_private.close_refunded_job()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.job_id is not null and new.status='refunded' and not exists(select 1 from public.conversations where payment_id=new.id and delivery_status='accepted') then
 update public.jobs set status='cancelled' where id=new.job_id;
 end if;
 return new;
end $$;
revoke all on function voice_flea_private.close_refunded_job() from public,anon,authenticated;
create trigger close_refunded_job after insert or update of status on public.payments for each row execute function voice_flea_private.close_refunded_job();
