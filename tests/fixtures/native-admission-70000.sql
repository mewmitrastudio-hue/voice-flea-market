-- DRAFT ONLY: CLI migration generation unavailable. Reserved suffix 70000.
-- New admission is intentionally impossible until audited 60000 integration and
-- an exact-order-ID boost preparation overload have been reviewed. Recovery works.
create function voice_flea_private.native_admission_dto(a voice_flea_private.native_retry_attempts)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('orderId',a.order_id,'intentId',a.intent_id,'attemptNonce',a.nonce,
 'previousOrderId',a.previous_order_id,'environment',a.environment,'productId',a.product_id,'amountJpy',a.amount_jpy,'state',a.admission_state)
$$;
revoke all on function voice_flea_private.native_admission_dto(voice_flea_private.native_retry_attempts) from public,anon,authenticated,service_role;
create index native_retry_owner_keyset on voice_flea_private.native_retry_attempts(owner_id,created_at,order_id) where protocol_origin='v3';

-- Rate limits are durable and owner-scoped, never token/IP logs. Fixed row per
-- owner/class bounds storage. Rejected requests do not execute any transition.
create table voice_flea_private.native_admission_rate(owner_id uuid references auth.users(id),category text,window_at timestamptz not null,hits integer not null,primary key(owner_id,category));
alter table voice_flea_private.native_admission_rate enable row level security;
revoke all on voice_flea_private.native_admission_rate from public,anon,authenticated,service_role;
create function voice_flea_private.native_admission_rate_check(actor uuid,category text)
returns void language plpgsql set search_path='' as $$
#variable_conflict use_variable
declare n integer;
begin
 if actor is null or category not in ('read','write') then raise exception 'not_authorized'; end if;
 insert into voice_flea_private.native_admission_rate as r values(actor,category,clock_timestamp(),1)
 on conflict on constraint native_admission_rate_pkey do update set hits=case when r.window_at<clock_timestamp()-interval '1 minute' then 1 else r.hits+1 end,
 window_at=case when r.window_at<clock_timestamp()-interval '1 minute' then clock_timestamp() else r.window_at end returning hits into n;
 if n>(case when category='read' then 120 else 30 end) then raise exception 'recovery_not_enabled'; end if;
end $$;
revoke all on function voice_flea_private.native_admission_rate_check(uuid,text) from public,anon,authenticated,service_role;
create function public.native_purchase_context(actor uuid,requested_order uuid,requested_nonce uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a voice_flea_private.native_retry_attempts; k text; seller uuid;
begin
 if actor is null then raise exception 'not_authorized'; end if;
 perform voice_flea_private.native_admission_rate_check(actor,'read');
 select * into a from voice_flea_private.native_retry_attempts x where x.order_id=requested_order and x.owner_id=actor and x.nonce=requested_nonce and x.protocol_origin='v3';
 if not found then raise exception 'not_authorized'; end if;
 select i.kind into k from voice_flea_private.native_fulfillment_intents i where i.id=a.intent_id and i.owner_id=actor;
 if k='boost' then seller=actor;else select o.seller_id into seller from voice_flea_private.voice_iap_orders o where o.id=a.order_id;end if;
 return jsonb_build_object('kind',k,'environment',a.environment,'sellerId',seller);
end $$;
revoke all on function public.native_purchase_context(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.native_purchase_context(uuid,uuid,uuid) to service_role;
create function public.native_purchase_list_attempts(actor uuid,page_size integer default 25,after_created timestamptz default null,after_order uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare entries jsonb; cursor jsonb; count_rows integer;
begin
 if actor is null then raise exception 'not_authorized'; end if;
 if page_size is null or page_size not between 1 and 100 or (after_created is null)<>(after_order is null) or (after_created is not null and not isfinite(after_created)) then raise exception 'purchase_state_conflict'; end if;
 perform voice_flea_private.native_admission_rate_check(actor,'read');
 -- One bounded statement observes a consistent page; no second unlocked scan.
 with page as materialized(select a from voice_flea_private.native_retry_attempts a where a.owner_id=actor and a.protocol_origin='v3'
 and (after_created is null or (a.created_at,a.order_id)>(after_created,after_order)) order by a.created_at,a.order_id limit page_size+1),
 numbered as(select a,row_number() over(order by (a).created_at,(a).order_id) n from page)
 select coalesce(jsonb_agg(voice_flea_private.native_admission_dto(a) order by (a).created_at,(a).order_id) filter(where n<=page_size),'[]'::jsonb),
 count(*)::integer,
 (jsonb_agg(jsonb_build_object('createdAt',to_char((a).created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'orderId',(a).order_id)) filter(where n=page_size))->0
 into entries,count_rows,cursor from numbered;
 return jsonb_build_object('attempts',entries,'nextCursor',case when count_rows>page_size then cursor else null end,'launchGranted',false);
end $$;
revoke all on function public.native_purchase_list_attempts(uuid,integer,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.native_purchase_list_attempts(uuid,integer,timestamptz,uuid) to service_role;

-- The existing 4-argument legacy API remains untouched. This exact-ID overload
-- creates only the caller-persisted immutable order, never adopts/renames one.
create function public.prepare_boost_order_in_environment(owner_id uuid,listing uuid,tier text,tx_environment text,attempt uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
begin
 if owner_id is null or listing is null or attempt is null or tier is null or tier not in ('silver','gold','platinum') or tx_environment is null or tx_environment not in ('Sandbox','Production') then raise exception 'purchase_state_conflict';end if;
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,16));
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,913));
 perform pg_advisory_xact_lock(hashtextextended(listing::text,72));
 if to_regprocedure('voice_flea_private.legacy_refund_subject_pending(uuid,text,uuid)') is null or to_regclass('voice_flea_private.legacy_apple_refund_reviews') is null then raise exception 'recovery_not_enabled';end if;
 if voice_flea_private.legacy_refund_subject_pending(owner_id,'boost',listing) then raise exception 'review_required';end if;
 if not voice_flea_private.account_available(owner_id) then raise exception 'purchase_state_conflict';end if;
 perform 1 from public.listings l where l.id=listing and l.seller_id=owner_id and l.is_active for share;
 if not found then raise exception 'purchase_state_conflict';end if;
 if exists(select 1 from voice_flea_private.native_fulfillment_intents i where i.owner_id=owner_id and i.kind='boost' and i.subject_id=listing) then raise exception 'purchase_state_conflict';end if;
 if exists(select 1 from public.listing_boosts b where b.listing_id=listing and b.status='active' and b.environment=tx_environment and b.ends_at>now()) then raise exception 'already_fulfilled';end if;
 if exists(select 1 from voice_flea_private.boost_orders b where b.seller_id=owner_id and b.listing_id=listing and b.state='pending') then raise exception 'legacy_reconciliation_required';end if;
 if exists(select 1 from voice_flea_private.boost_orders b where b.id=attempt) or exists(select 1 from voice_flea_private.voice_iap_orders v where v.id=attempt) then raise exception 'legacy_reconciliation_required';end if;
 insert into voice_flea_private.boost_orders(id,seller_id,listing_id,plan,product_id,environment) values(attempt,owner_id,listing,tier,'com.ayuhide.koenofurima.boost.'||tier,tx_environment);
 return jsonb_build_object('orderId',attempt);
end $$;
revoke all on function public.prepare_boost_order_in_environment(uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
-- Deliberately no service grant: only the atomic SECURITY DEFINER wrapper calls
-- this overload. A service-role standalone prepare cannot leave an unregistered order.

create function voice_flea_private.native_admission_quote_check(a voice_flea_private.native_retry_attempts,expected_seller uuid)
returns void language plpgsql set search_path='' as $$
declare i voice_flea_private.native_fulfillment_intents;v voice_flea_private.voice_iap_orders;b voice_flea_private.boost_orders;
begin
 select * into i from voice_flea_private.native_fulfillment_intents n where n.id=a.intent_id and n.owner_id=a.owner_id;
 if not found or not voice_flea_private.account_available(a.owner_id) then raise exception 'purchase_state_conflict';end if;
 -- A late old receipt can hold an intent after its fresh child was prepared.
 -- Never scope review to the current order: all attempts share one purpose.
 if exists(select 1 from voice_flea_private.native_verified_receipts r
  where r.intent_id=a.intent_id and (exists(select 1 from voice_flea_private.native_refund_review_holds h where h.environment=r.environment and h.transaction_id=r.transaction_id)
   or (r.classification='excess_payment_review' and not r.revoked))) then raise exception 'review_required';end if;
 if i.kind='boost' then
  select * into b from voice_flea_private.boost_orders x where x.id=a.order_id for update;
  if b.seller_id is distinct from a.owner_id or b.product_id is distinct from a.product_id or b.environment is distinct from a.environment then raise exception 'purchase_state_conflict';end if;
  perform 1 from public.listings l where l.id=b.listing_id and l.seller_id=a.owner_id and l.is_active for share;
  if not found then raise exception 'quote_changed';end if;
  if exists(select 1 from public.listing_boosts x where x.listing_id=b.listing_id and x.environment=b.environment and x.status='active' and x.ends_at>now()) then raise exception 'already_fulfilled';end if;
 else
  select * into v from voice_flea_private.voice_iap_orders x where x.id=a.order_id for update;
  if v.seller_id is distinct from expected_seller or v.buyer_id is distinct from a.owner_id or v.product_id is distinct from a.product_id or v.amount_jpy is distinct from a.amount_jpy or v.environment is distinct from a.environment then raise exception 'quote_changed';end if;
  if not voice_flea_private.account_available(v.seller_id) then raise exception 'purchase_state_conflict';end if;
  if i.kind='voice_listing' then
   perform 1 from public.listings l where l.id=v.listing_id and l.is_active and l.seller_id=v.seller_id and l.price_jpy=v.amount_jpy for share;
  else
   perform 1 from public.jobs j join public.applications p on p.job_id=j.id where j.id=v.job_id and j.buyer_id=a.owner_id and j.status='open' and p.id=v.job_application_id and p.status='accepted' and p.applicant_id=v.seller_id and p.agreed_price_jpy=v.amount_jpy for share of j,p;
  end if;
  if not found then raise exception 'quote_changed';end if;
  if exists(select 1 from public.user_blocks u where (u.blocker_id=a.owner_id and u.blocked_user_id=v.seller_id) or (u.blocker_id=v.seller_id and u.blocked_user_id=a.owner_id)) then raise exception 'purchase_state_conflict';end if;
  if not exists(select 1 from voice_flea_private.voice_iap_products p where p.product_id=v.product_id and p.amount_jpy=v.amount_jpy and case when v.environment='Production' then p.production_enabled else p.sandbox_enabled end) then raise exception 'quote_changed';end if;
 end if;
end $$;
revoke all on function voice_flea_private.native_admission_quote_check(voice_flea_private.native_retry_attempts,uuid) from public,anon,authenticated,service_role;

create function public.native_purchase_admission(actor uuid,requested_action text,requested_order uuid default null,requested_nonce uuid default null,
 fresh_order uuid default null,requested_kind text default null,subject uuid default null,tier text default null,tx_environment text default null,
 expected_seller uuid default null,voice_environments text[] default '{}'::text[],boost_environments text[] default '{}'::text[])
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare a voice_flea_private.native_retry_attempts; i voice_flea_private.native_fulfillment_intents;
 r jsonb; op text; selected uuid; purpose uuid; allowed text[]; launched boolean=false;
begin
 if actor is null then raise exception 'not_authorized'; end if;
 if requested_action is null or requested_action not in ('status','begin','cancelReport','pendingReport','prepareRetry','prepareInitial') then raise exception 'purchase_state_conflict'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text,16));
 perform pg_advisory_xact_lock(hashtextextended(actor::text,913));
 perform voice_flea_private.native_admission_rate_check(actor,case when requested_action='status' then 'read' else 'write' end);
 -- Immutable build-time hold. An env flag alone CANNOT enable incomplete SQL.
 -- Replace only after the actual 60000 snapshot, guard/purpose race audit, and
 -- exact-ID Boost contract have all been integrated and independently tested.
 if requested_action in ('prepareInitial','begin','prepareRetry') then raise exception 'recovery_not_enabled'; end if;
 if requested_action in ('prepareInitial','begin','prepareRetry') then
  if to_regprocedure('voice_flea_private.legacy_refund_subject_pending(uuid,text,uuid)') is null or to_regprocedure('voice_flea_private.legacy_refund_purpose_pending(uuid)') is null or to_regclass('voice_flea_private.legacy_apple_refund_reviews') is null then raise exception 'recovery_not_enabled';end if;
 end if;
 if requested_action='prepareInitial' then
  if fresh_order is null or subject is null or requested_kind is null or requested_kind not in ('voice_listing','voice_job','boost') or tx_environment is null or tx_environment not in ('Sandbox','Production') then raise exception 'purchase_state_conflict';end if;
  allowed=case when requested_kind='boost' then boost_environments else voice_environments end;
  if allowed is null or not coalesce(tx_environment=any(allowed),false) then raise exception 'purchase_state_conflict';end if;
  purpose=subject;
  if requested_kind='voice_job' then select p.job_id into purpose from public.applications p where p.id=subject;end if;
  if purpose is null then raise exception 'purchase_state_conflict';end if;
  if voice_flea_private.legacy_refund_subject_pending(actor,requested_kind,purpose) then raise exception 'review_required';end if;
  select * into a from voice_flea_private.native_retry_attempts x where x.order_id=fresh_order for update;
  if found then
   select * into i from voice_flea_private.native_fulfillment_intents n where n.id=a.intent_id;
   if a.owner_id is distinct from actor or a.protocol_origin<>'v3' or a.previous_order_id is not null or i.kind is distinct from requested_kind or i.subject_id is distinct from purpose or a.environment is distinct from tx_environment then raise exception 'not_authorized';end if;
   if requested_kind='boost' and a.product_id is distinct from 'com.ayuhide.koenofurima.boost.'||tier then raise exception 'quote_changed';end if;
   if requested_kind='voice_job' and not exists(select 1 from voice_flea_private.voice_iap_orders v where v.id=fresh_order and v.job_application_id=subject) then raise exception 'quote_changed';end if;
   perform voice_flea_private.native_admission_quote_check(a,expected_seller);
   return jsonb_build_object('attempt',voice_flea_private.native_admission_dto(a),'launchGranted',false);
  end if;
  if exists(select 1 from voice_flea_private.voice_iap_orders v where v.id=fresh_order) or exists(select 1 from voice_flea_private.boost_orders b where b.id=fresh_order) then raise exception 'legacy_reconciliation_required';end if;
  if requested_kind='voice_listing' then r=public.prepare_voice_iap_order(actor,subject,fresh_order,tx_environment);
  elsif requested_kind='voice_job' then r=public.prepare_job_voice_iap_order(actor,subject,fresh_order,tx_environment);
  else r=public.prepare_boost_order_in_environment(actor,subject,tier,tx_environment,fresh_order);end if;
  if (r->>'orderId')::uuid is distinct from fresh_order then raise exception 'legacy_reconciliation_required';end if;
  r=public.native_retry_admission(actor,'register',fresh_order,null,null);
  select * into a from voice_flea_private.native_retry_attempts x where x.order_id=fresh_order and x.owner_id=actor for update;
  if not found then raise exception 'purchase_state_conflict';end if;
  perform voice_flea_private.native_admission_quote_check(a,expected_seller);
  return jsonb_build_object('attempt',voice_flea_private.native_admission_dto(a),'launchGranted',false);
 end if;
 select * into a from voice_flea_private.native_retry_attempts x where x.order_id=requested_order and x.owner_id=actor and x.nonce=requested_nonce and x.protocol_origin='v3' for update;
 if not found then raise exception 'not_authorized'; end if;
 if requested_action in ('begin','prepareRetry') then
  select * into i from voice_flea_private.native_fulfillment_intents n where n.id=a.intent_id and n.owner_id=actor for update;
  allowed=case when i.kind='boost' then boost_environments else voice_environments end;
  if a.environment is distinct from tx_environment or allowed is null or not coalesce(a.environment=any(allowed),false) then raise exception 'purchase_state_conflict';end if;
  if voice_flea_private.legacy_refund_purpose_pending(a.order_id) then raise exception 'review_required';end if;
  perform voice_flea_private.native_admission_quote_check(a,expected_seller);
 end if;
 op=case requested_action when 'status' then 'status' when 'cancelReport' then 'client_cancel' when 'pendingReport' then 'pending' when 'begin' then 'begin' when 'prepareRetry' then 'retry' end;
 begin
  r=public.native_retry_admission(actor,op,requested_order,requested_nonce,case when requested_action='prepareRetry' then fresh_order else null end);
 exception when others then
  -- Deliberately map known transition denials; SQL/network surprises stay unknown.
  if sqlerrm in ('Approval is not cancellation','Purchase was not dispatched','Invalid pending transition','Retry requires reported cancellation','Fresh order required','Use latest attempt') then raise exception 'purchase_state_conflict'; end if;
  if sqlerrm in ('Fresh quote required','Fresh contract required') then raise exception 'quote_changed';end if;
  if sqlerrm='Intent already fulfilled' then raise exception 'already_fulfilled';end if;
  if sqlerrm='Legacy refund purpose requires review before native registration or launch' then raise exception 'review_required';end if;
  raise;
 end;
 selected=case when requested_action='prepareRetry' then fresh_order else requested_order end;
 launched=requested_action='begin' and coalesce((r->>'launchGranted')::boolean,false);
 select * into a from voice_flea_private.native_retry_attempts x where x.order_id=selected and x.owner_id=actor for update;
 if not found then raise exception 'not_authorized'; end if;
 return jsonb_build_object('attempt',voice_flea_private.native_admission_dto(a),'launchGranted',launched);
exception when others then
 if sqlerrm in ('APPLE_REFUND_REVIEW_HELD','Legacy refund purpose requires review before native registration or launch') then raise exception 'review_required';end if;
 if sqlerrm in ('Legacy attempt requires reconciliation','Legacy prepared order requires reconciliation','Overlapping prepared order requires reconciliation','Existing financial history requires explicit intent reconciliation','Existing boost history requires explicit intent reconciliation','Existing purchase or authorization requires attention') then raise exception 'legacy_reconciliation_required';end if;
 if sqlerrm in ('Use the existing fulfillment intent','Use native intent recovery','Order not prepared','Listing unavailable','Account unavailable','Product unavailable','Purchase unavailable','Seller unavailable','Order already consumed') then raise exception 'purchase_state_conflict';end if;
 if sqlerrm in ('Order price changed','Fresh quote required','Fresh contract required') then raise exception 'quote_changed';end if;
 raise;
end $$;
revoke all on function public.native_purchase_admission(uuid,text,uuid,uuid,uuid,text,uuid,text,text,uuid,text[],text[]) from public,anon,authenticated;
grant execute on function public.native_purchase_admission(uuid,text,uuid,uuid,uuid,text,uuid,text,text,uuid,text[],text[]) to service_role;
