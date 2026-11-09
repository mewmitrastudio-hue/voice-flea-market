-- Serialize both purchase channels for one buyer/listing.
-- Never expire Apple reservations based on elapsed time or an empty device scan.

create or replace function public.prepare_voice_checkout(actor uuid,listing uuid,destination text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.listings;q voice_flea_private.voice_checkout_intents;r uuid;uid uuid;
begin
 if actor is null or not voice_flea_private.account_available(actor) then raise exception 'Sign in required' using errcode='42501';end if;
 -- Both entry points acquire this lock before their channel-specific lock.
 perform pg_advisory_xact_lock(hashtextextended(actor::text||listing::text,85));
 if exists(select 1 from voice_flea_private.voice_iap_orders where buyer_id=actor and listing_id=listing and state='prepared') then
 raise exception 'Resolve the existing purchase in the other channel first' using errcode='42501';end if;
 if exists(select 1 from public.payments p where p.buyer_id=actor and p.listing_id=listing
 and (p.status in ('pending','authorized','partially_refunded') or p.status='paid' and not exists(
 select 1 from public.conversations c where c.payment_id=p.id and not c.is_inquiry and c.delivery_status='accepted'))) then
 raise exception 'Existing purchase or authorization requires attention' using errcode='42501';end if;
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

create or replace function public.prepare_voice_iap_order(owner_id uuid,listing uuid,attempt uuid,tx_environment text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.listings; o voice_flea_private.voice_iap_orders; product voice_flea_private.voice_iap_products;
begin
 if owner_id is null or attempt is null or tx_environment is null or tx_environment not in ('Sandbox','Production')
  or not voice_flea_private.account_available(owner_id) then raise exception 'Purchase unavailable' using errcode='42501';end if;
 -- Same buyer/listing requests serialize, including requests in different tabs.
 -- Both entry points acquire this lock before their channel-specific lock.
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text||listing::text,85));
 if exists(select 1 from voice_flea_private.voice_checkout_intents where buyer_id=owner_id and listing_id=listing and state='prepared') then
 raise exception 'Resolve the existing purchase in the other channel first' using errcode='42501';end if;
 if exists(select 1 from public.payments p where p.buyer_id=owner_id and p.listing_id=listing
 and (p.status in ('pending','authorized','partially_refunded') or p.status='paid' and not exists(
 select 1 from public.conversations c where c.payment_id=p.id and not c.is_inquiry and c.delivery_status='accepted'))) then
 raise exception 'Existing purchase or authorization requires attention' using errcode='42501';end if;
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
