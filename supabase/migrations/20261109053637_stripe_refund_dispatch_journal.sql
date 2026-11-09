-- LOCAL ONLY. Both Edge routes and SQL dispatch are disabled until separately reviewed cutover.
-- Existing provider idempotency history cannot be inferred from a new local journal.
create table voice_flea_private.stripe_refund_dispatch_config(
 singleton boolean primary key default true check(singleton),enabled boolean not null default false,
 platform_id text,cutover_at timestamptz,
 check(not enabled or (platform_id ~ '^acct_[A-Za-z0-9]+$' and cutover_at is not null))
);
insert into voice_flea_private.stripe_refund_dispatch_config(singleton) values(true);
create table voice_flea_private.stripe_refund_operations(
 id uuid primary key default gen_random_uuid(),payment_id uuid not null unique references public.payments(id),
 platform_id text not null,livemode boolean not null,expected jsonb not null,parameters jsonb not null,idempotency_key text not null unique,
 state text not null check(state in ('prepared','dispatching','pending','succeeded','needs_review')),
 refund_id text,refund_status text,buyer_refund_verified boolean not null default false,error_code text,
 parameter_conflict boolean not null default false,dispatched_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),observed_at timestamptz
);
create table voice_flea_private.stripe_refund_observations(
 id bigint generated always as identity primary key,operation_id uuid not null references voice_flea_private.stripe_refund_operations(id),
 evidence jsonb not null,recorded_at timestamptz not null default clock_timestamp()
);
alter table voice_flea_private.stripe_refund_dispatch_config enable row level security;
alter table voice_flea_private.stripe_refund_operations enable row level security;
alter table voice_flea_private.stripe_refund_observations enable row level security;
revoke all on voice_flea_private.stripe_refund_dispatch_config,voice_flea_private.stripe_refund_operations,voice_flea_private.stripe_refund_observations from public,anon,authenticated,service_role;

create function voice_flea_private.stripe_refund_binding(p public.payments) returns jsonb language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('id',p.id,'payment_channel',p.payment_channel,'stripe_payment_intent_id',p.stripe_payment_intent_id,
 'stripe_charge_id',p.stripe_charge_id,'stripe_livemode',p.stripe_livemode,'amount_jpy',p.amount_jpy,'platform_fee_jpy',p.platform_fee_jpy,
 'stripe_destination',p.stripe_destination,'buyer_id',p.buyer_id,'seller_id',p.seller_id,'listing_id',p.listing_id,'job_id',p.job_id,
 'apple_transaction_id',p.apple_transaction_id,'apple_environment',p.apple_environment,'apple_verified_at',p.apple_verified_at)
$$;
create function voice_flea_private.stripe_refund_block(p public.payments) returns text language sql stable security invoker set search_path='' as $$
 select case when p.id is null or p.payment_channel is distinct from 'web' or p.apple_transaction_id is not null or p.apple_environment is not null or p.apple_verified_at is not null then 'wrong_payment_channel'
 when p.stripe_dispute_review_required then 'stripe_dispute_review_required'
 when p.status is distinct from 'paid' or p.refunded_amount_jpy is distinct from 0 then 'partial_or_unknown_refund_requires_review'
 when p.stripe_livemode is null or p.stripe_reconciled_at is null or p.stripe_payment_intent_id is null or p.stripe_payment_intent_id !~ '^pi_[A-Za-z0-9]+$'
 or p.stripe_charge_id is null or p.stripe_charge_id !~ '^ch_[A-Za-z0-9]+$' or p.stripe_destination is null or p.stripe_destination !~ '^acct_[A-Za-z0-9]+$'
 or p.platform_fee_jpy is null then 'payment_binding_unverified' else null end
$$;
create function voice_flea_private.stripe_refund_request_authorized(payment_id uuid,origin text,actor uuid,job_id uuid,lease uuid)
returns void language plpgsql security definer set search_path='' as $$
declare j voice_flea_private.refund_auto_jobs;r voice_flea_private.trade_cancellations;
begin
 if origin='manual' then
 -- Exact ADMIN_USER_ID authorization remains in the authenticated Edge endpoint, never broadened to moderator membership.
 if actor is null or not exists(select 1 from auth.users where id=actor) then raise exception 'Operator identity required';end if;
 elsif origin='auto' then
 select * into j from voice_flea_private.refund_auto_jobs where id=job_id;
 select * into r from voice_flea_private.trade_cancellations where id=j.cancellation_id;
 if j.id is null or j.payment_id is distinct from payment_id or j.state<>'processing' or lease is null or j.lease_id is null or j.lease_id is distinct from lease or j.lease_until is null or j.lease_until<=clock_timestamp()
 or r.id is null or r.payment_id is distinct from payment_id or r.buyer_approved is not true or r.seller_approved is not true
 or not exists(select 1 from public.conversations c where c.id=r.conversation_id and c.payment_id=stripe_refund_request_authorized.payment_id and c.delivery_status='none' and c.delivery_path is null)
 then raise exception 'Automatic refund approval or lease changed';end if;
 else raise exception 'Invalid refund origin';end if;
end $$;
create function public.prepare_stripe_refund(payment_id uuid,origin text,actor uuid,job_id uuid,lease uuid,platform_id text,live boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare p public.payments;o voice_flea_private.stripe_refund_operations;c voice_flea_private.stripe_refund_dispatch_config;blocked text;params jsonb;legacy_refund text;participant uuid;
begin
 select * into c from voice_flea_private.stripe_refund_dispatch_config where singleton;
 if not c.enabled or c.platform_id is distinct from platform_id or live is null then raise exception 'Refund dispatch disabled or scope mismatch';end if;
 perform voice_flea_private.stripe_refund_request_authorized(payment_id,origin,actor,job_id,lease);
 select * into p from public.payments where id=payment_id;
 for participant in select x from unnest(array[p.buyer_id,p.seller_id]) x order by x loop
 perform pg_advisory_xact_lock(hashtextextended(participant::text,16));end loop;
 select * into p from public.payments where id=payment_id for update;
 if p.id is null or p.payment_channel is distinct from 'web' or p.stripe_livemode is distinct from live then raise exception 'Wrong refund channel or mode';end if;
 select * into o from voice_flea_private.stripe_refund_operations x where x.payment_id=payment_id;
 if o.id is not null then
 if o.expected is distinct from voice_flea_private.stripe_refund_binding(p) or o.platform_id<>platform_id or o.livemode<>live then raise exception 'Refund operation identity changed';end if;
 return to_jsonb(o)||jsonb_build_object('payment',to_jsonb(p));end if;
 blocked=voice_flea_private.stripe_refund_block(p);
 if p.created_at<c.cutover_at or p.created_at is null then blocked='legacy_refund_history_requires_review';end if;
 if origin='auto' then select provider_refund_id into legacy_refund from voice_flea_private.refund_auto_jobs where id=job_id;end if;
 -- Preserve original request flags and idempotency key. Never hide parameter conflicts behind a new key.
 params=jsonb_build_object('payment_intent',p.stripe_payment_intent_id,'reverse_transfer','true')||case when p.platform_fee_jpy>0 then jsonb_build_object('refund_application_fee','true') else '{}'::jsonb end;
 insert into voice_flea_private.stripe_refund_operations(payment_id,platform_id,livemode,expected,parameters,idempotency_key,state,error_code,refund_id)
 values(p.id,platform_id,live,voice_flea_private.stripe_refund_binding(p),params,'refund-payment-'||p.id::text,case when blocked is null then 'prepared' else 'needs_review' end,blocked,legacy_refund) returning * into o;
 return to_jsonb(o)||jsonb_build_object('payment',to_jsonb(p));
end $$;
create function public.claim_stripe_refund_dispatch(payment_id uuid,origin text,actor uuid,job_id uuid,lease uuid,platform_id text,live boolean,operation_id uuid,parameters jsonb,observation jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare p public.payments;o voice_flea_private.stripe_refund_operations;c voice_flea_private.stripe_refund_dispatch_config;blocked text;
begin
 select * into p from public.payments where id=payment_id for update;
 select * into o from voice_flea_private.stripe_refund_operations where id=operation_id and stripe_refund_operations.payment_id=payment_id for update;
 if o.id is null then raise exception 'Refund operation required';end if;
 if o.state<>'prepared' then return to_jsonb(o)||jsonb_build_object('dispatch_granted',false);end if;
 perform voice_flea_private.stripe_refund_request_authorized(payment_id,origin,actor,job_id,lease);
 select * into c from voice_flea_private.stripe_refund_dispatch_config where singleton;
 blocked=voice_flea_private.stripe_refund_block(p);
 if not c.enabled or c.platform_id is distinct from platform_id or o.platform_id is distinct from platform_id or o.livemode is distinct from live then blocked='refund_scope_changed';end if;
 if o.expected is distinct from voice_flea_private.stripe_refund_binding(p) or o.parameters is distinct from parameters then blocked='refund_parameter_conflict';end if;
 if observation->>'stripe_payment_intent_id' is distinct from p.stripe_payment_intent_id or observation->>'stripe_charge_id' is distinct from p.stripe_charge_id
 or (observation->>'stripe_livemode')::boolean is distinct from p.stripe_livemode or (observation->>'amount_jpy')::integer is distinct from p.amount_jpy
 or (observation->>'refunded_amount_jpy')::integer is distinct from 0 or observation->'disputed' is distinct from 'false'::jsonb or observation->'refunded' is distinct from 'false'::jsonb
 or observation->>'destination' is distinct from p.stripe_destination or (observation->>'application_fee_jpy')::integer is distinct from p.platform_fee_jpy
 or (observation->>'stripe_reconciled_at')::timestamptz is null or (observation->>'stripe_reconciled_at')::timestamptz<clock_timestamp()-interval '1 minute'
 or (observation->>'stripe_reconciled_at')::timestamptz>clock_timestamp()+interval '1 minute' then blocked='refund_observation_unverified';end if;
 update voice_flea_private.stripe_refund_operations set state=case when blocked is null then 'dispatching' else 'needs_review' end,
 dispatched_at=case when blocked is null then clock_timestamp() else null end,error_code=blocked,parameter_conflict=coalesce(blocked='refund_parameter_conflict',false)
 where id=o.id returning * into o;
 return to_jsonb(o)||jsonb_build_object('dispatch_granted',blocked is null);
end $$;
create function public.record_stripe_refund_outcome(operation_id uuid,evidence jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o voice_flea_private.stripe_refund_operations;p public.payments;s jsonb:=evidence->'observation';rid text:=evidence->>'refund_id';rs text:=evidence->>'refund_status';verified boolean:=false;code text:=evidence->>'error_code';obs timestamptz;
begin
 select p0.* into p from public.payments p0 join voice_flea_private.stripe_refund_operations x on x.payment_id=p0.id where x.id=operation_id for update of p0;
 select * into o from voice_flea_private.stripe_refund_operations where id=operation_id for update;
 if o.id is null or o.expected is distinct from voice_flea_private.stripe_refund_binding(p) then raise exception 'Refund operation identity changed';end if;
 if rid is not null and (rid !~ '^re_[A-Za-z0-9]+$' or (o.refund_id is not null and o.refund_id<>rid) or (evidence->>'refund_amount_jpy')::integer is distinct from p.amount_jpy
 or rs is null or rs not in ('succeeded','pending','requires_action','failed','canceled')) then raise exception 'Refund outcome identity mismatch';end if;
 if s is not null and s<>'null'::jsonb then
 if s->>'stripe_payment_intent_id' is distinct from p.stripe_payment_intent_id or s->>'stripe_charge_id' is distinct from p.stripe_charge_id
 or (s->>'stripe_livemode')::boolean is distinct from p.stripe_livemode or (s->>'amount_jpy')::integer is distinct from p.amount_jpy
 then raise exception 'Refund observation identity mismatch';end if;
 obs=(s->>'stripe_reconciled_at')::timestamptz;
 -- Financial fact is recorded even under a review hold. No status is forged back to paid.
 perform public.record_stripe_payment_snapshot(s);
 select * into p from public.payments where id=o.payment_id;
 end if;
 insert into voice_flea_private.stripe_refund_observations(operation_id,evidence) values(o.id,evidence);
 -- A delayed/older observation is retained but cannot overwrite newer provider facts.
 if o.observed_at is not null and obs is not null and obs<o.observed_at then return to_jsonb(o);end if;
 rid=coalesce(rid,o.refund_id);rs=coalesce(rs,o.refund_status);
 verified=rid is not null and rs='succeeded' and (s->>'refunded_amount_jpy')::integer=p.amount_jpy and p.status='refunded' and p.refunded_amount_jpy=p.amount_jpy;
 if rs='succeeded' and not coalesce(verified,false) and code is null then code='refund_reconciliation_pending';end if;
 if p.stripe_dispute_review_required or s->'disputed'='true'::jsonb then code='stripe_dispute_review_required';end if;
 if o.parameter_conflict or code='provider_parameter_conflict' then code='provider_parameter_conflict';end if;
 update voice_flea_private.stripe_refund_operations set refund_id=rid,refund_status=rs,
 buyer_refund_verified=case when obs is not null then coalesce(verified,false) else buyer_refund_verified end,
 state=case when code is null and verified then 'succeeded' when code is null and rs='pending' then 'pending' else 'needs_review' end,
 error_code=coalesce(code,case when rs in ('requires_action','failed','canceled') then 'refund_requires_review' end),
 parameter_conflict=parameter_conflict or coalesce(code='provider_parameter_conflict',false),observed_at=coalesce(obs,observed_at)
 where id=o.id returning * into o;
 return to_jsonb(o);
end $$;

revoke all on function voice_flea_private.stripe_refund_binding(public.payments),voice_flea_private.stripe_refund_block(public.payments),voice_flea_private.stripe_refund_request_authorized(uuid,text,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.prepare_stripe_refund(uuid,text,uuid,uuid,uuid,text,boolean),public.claim_stripe_refund_dispatch(uuid,text,uuid,uuid,uuid,text,boolean,uuid,jsonb,jsonb),public.record_stripe_refund_outcome(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_stripe_refund(uuid,text,uuid,uuid,uuid,text,boolean),public.claim_stripe_refund_dispatch(uuid,text,uuid,uuid,uuid,text,boolean,uuid,jsonb,jsonb),public.record_stripe_refund_outcome(uuid,jsonb) to service_role;

-- Preserve the observed worker-secret, bilateral approval, undelivered, job limit and retry policy.
-- Old worker versions also pass through this gate; disabled means no claimed jobs.
create schema voice_flea_refund_legacy;
revoke all on schema voice_flea_refund_legacy from public,anon,authenticated,service_role;
alter function voice_flea_private.refund_auto_claim(text) set schema voice_flea_refund_legacy;
revoke all on function voice_flea_refund_legacy.refund_auto_claim(text) from public,anon,authenticated,service_role;
create function voice_flea_private.refund_auto_claim(provided_token text) returns jsonb language plpgsql security definer set search_path='' as $$
declare jobs jsonb;j jsonb;p public.payments;result jsonb:='[]';blocked text;
begin
 if not exists(select 1 from voice_flea_private.stripe_refund_dispatch_config where singleton and enabled) then raise exception 'Refund dispatch disabled';end if;
 jobs=voice_flea_refund_legacy.refund_auto_claim(provided_token);
 for j in select value from jsonb_array_elements(jobs) loop
 select * into p from public.payments where id=(j->>'payment_id')::uuid for update;
 blocked=voice_flea_private.stripe_refund_block(p);
 -- Full buyer refund is a fact, not authority to release other financial holds.
 if p.status='refunded' and p.payment_channel='web' and not p.stripe_dispute_review_required then blocked=null;end if;
 if blocked is not null then
 update voice_flea_private.refund_auto_jobs set state='needs_review',error_code=blocked,lease_until=null where id=(j->>'id')::uuid;
 update voice_flea_private.trade_cancellations set state='needs_review' where payment_id=p.id;
 else result=result||jsonb_build_array(j);end if;
 end loop;return result;
end $$;
revoke all on function voice_flea_private.refund_auto_claim(text) from public,anon,authenticated;
grant execute on function voice_flea_private.refund_auto_claim(text) to service_role;

alter function voice_flea_private.refund_auto_result(uuid,uuid,text,text,text,boolean) set schema voice_flea_refund_legacy;
revoke all on function voice_flea_refund_legacy.refund_auto_result(uuid,uuid,text,text,text,boolean) from public,anon,authenticated,service_role;
create function voice_flea_private.refund_auto_result(job_id uuid,lease uuid,refund_id text default null,refund_status text default null,error_code text default null,permanent boolean default false)
returns void language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare j voice_flea_private.refund_auto_jobs;o voice_flea_private.stripe_refund_operations;p public.payments;
begin
 select * into j from voice_flea_private.refund_auto_jobs where id=job_id for update;
 select * into p from public.payments where id=j.payment_id for update;
 select * into o from voice_flea_private.stripe_refund_operations where payment_id=j.payment_id;
 if j.id is null or o.id is null then raise exception 'Durable refund outcome required';end if;
 -- The operation journal has already saved late verified provider results. A stale job lease cannot overwrite a newer worker.
 if j.state<>'processing' or j.lease_id is distinct from lease then return;end if;
 if refund_id is not null and refund_id is distinct from o.refund_id then raise exception 'Refund identity mismatch';end if;
 if o.state='succeeded' and o.buyer_refund_verified and not p.stripe_dispute_review_required and p.status='refunded' and p.refunded_amount_jpy=p.amount_jpy then
 -- Original outbox dedupe and notification are retained ONLY for a verified buyer refund without an active review.
 perform voice_flea_refund_legacy.refund_auto_result(job_id,lease,o.refund_id,o.refund_status,null,false);
 return;end if;
 update voice_flea_private.refund_auto_jobs set provider_refund_id=coalesce(o.refund_id,provider_refund_id),provider_status=o.refund_status,
 error_code=coalesce(o.error_code,'refund_review_required'),state=case when o.state='pending' and not p.stripe_dispute_review_required then 'waiting' else 'needs_review' end,
 next_attempt_at=clock_timestamp()+interval '15 minutes',lease_until=null where id=j.id;
 update voice_flea_private.trade_cancellations set state=case when o.state='pending' and not p.stripe_dispute_review_required then 'queued' else 'needs_review' end where id=j.cancellation_id;
end $$;
revoke all on function voice_flea_private.refund_auto_result(uuid,uuid,text,text,text,boolean) from public,anon,authenticated;
grant execute on function voice_flea_private.refund_auto_result(uuid,uuid,text,text,text,boolean) to service_role;

alter function public.prepare_delivery_acceptance(uuid,uuid) set schema voice_flea_refund_legacy;
revoke all on function voice_flea_refund_legacy.prepare_delivery_acceptance(uuid,uuid) from public,anon,authenticated,service_role;
create function public.prepare_delivery_acceptance(actor uuid,trade_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare payment uuid;
begin
 perform 1 from public.conversations where id=trade_id and buyer_id=actor for update;
 select p.id into payment from public.payments p join public.conversations c on c.payment_id=p.id where c.id=trade_id and c.buyer_id=actor for update of p;
 if exists(select 1 from voice_flea_private.stripe_refund_operations where payment_id=payment and state<>'succeeded') then raise exception 'Refund result review required';end if;
 return voice_flea_refund_legacy.prepare_delivery_acceptance(actor,trade_id);
end $$;
revoke all on function public.prepare_delivery_acceptance(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_delivery_acceptance(uuid,uuid) to service_role;

alter function public.finalize_delivery_acceptance(uuid,uuid,text) set schema voice_flea_refund_legacy;
revoke all on function voice_flea_refund_legacy.finalize_delivery_acceptance(uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.finalize_delivery_acceptance(actor uuid,trade_id uuid,transfer text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare payment uuid;
begin
 perform 1 from public.conversations where id=trade_id and buyer_id=actor for update;
 select p.id into payment from public.payments p join public.conversations c on c.payment_id=p.id where c.id=trade_id and c.buyer_id=actor for update of p;
 if exists(select 1 from voice_flea_private.stripe_refund_operations where payment_id=payment and state<>'succeeded') then raise exception 'Refund result review required';end if;
 return voice_flea_refund_legacy.finalize_delivery_acceptance(actor,trade_id,transfer);
end $$;
revoke all on function public.finalize_delivery_acceptance(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.finalize_delivery_acceptance(uuid,uuid,text) to service_role;

alter function public.prepare_account_deletion(uuid) set schema voice_flea_refund_legacy;
revoke all on function voice_flea_refund_legacy.prepare_account_deletion(uuid) from public,anon,authenticated,service_role;
create function public.prepare_account_deletion(target uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(target::text,16));
 if exists(select 1 from voice_flea_private.stripe_refund_operations o join public.payments p on p.id=o.payment_id where target in(p.buyer_id,p.seller_id) and o.state<>'succeeded') then return jsonb_build_object('allowed',false,'message','返金結果を照合中の取引があります。新しい返金を送らず運営へお問い合わせください。');end if;
 return voice_flea_refund_legacy.prepare_account_deletion(target);
end $$;
revoke all on function public.prepare_account_deletion(uuid) from public,anon,authenticated;
grant execute on function public.prepare_account_deletion(uuid) to service_role;

alter function public.finish_account_deletion(uuid) set schema voice_flea_refund_legacy;
revoke all on function voice_flea_refund_legacy.finish_account_deletion(uuid) from public,anon,authenticated,service_role;
create function public.finish_account_deletion(target uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(target::text,16));
 if exists(select 1 from voice_flea_private.stripe_refund_operations o join public.payments p on p.id=o.payment_id where target in(p.buyer_id,p.seller_id) and o.state<>'succeeded') then raise exception 'Refund result review required';end if;
 perform voice_flea_refund_legacy.finish_account_deletion(target);
end $$;
revoke all on function public.finish_account_deletion(uuid) from public,anon,authenticated;
grant execute on function public.finish_account_deletion(uuid) to service_role;
-- Do not inherit an unknown deployed wrapper ACL. Only authenticated Edge service code may invoke worker RPCs.
revoke all on function public.refund_auto_claim(text),public.refund_auto_result(uuid,uuid,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.refund_auto_claim(text),public.refund_auto_result(uuid,uuid,text,text,text,boolean) to service_role;
