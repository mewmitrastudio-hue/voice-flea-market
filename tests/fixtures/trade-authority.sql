-- Existing production authority guards captured read-only on 2026-10-28.
CREATE OR REPLACE FUNCTION voice_flea_private.guard_conversation_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op='UPDATE' and (
    new.buyer_id is distinct from old.buyer_id or
    new.seller_id is distinct from old.seller_id or
    new.is_inquiry is distinct from old.is_inquiry or
    (old.is_inquiry and (new.job_id is distinct from old.job_id or
      (new.listing_id is distinct from old.listing_id and not (
        new.listing_id is null and not exists(select 1 from public.listings l where l.id=old.listing_id)
      ))))
  ) then raise exception 'Conversation identity cannot be changed' using errcode='42501'; end if;
  if tg_op='INSERT' and new.is_inquiry then
    if auth.uid() is null or auth.uid()<>new.buyer_id or not exists (
      select 1 from public.listings l where l.id=new.listing_id
      and l.seller_id=new.seller_id and l.is_active
    ) or exists (
      select 1 from public.user_blocks b where
      (b.blocker_id=new.buyer_id and b.blocked_user_id=new.seller_id) or
      (b.blocker_id=new.seller_id and b.blocked_user_id=new.buyer_id)
    ) then raise exception 'Inquiry is unavailable' using errcode='42501'; end if;
  end if;
  return new;
end $function$
;
create trigger guard_conversation_identity before insert or update on public.conversations for each row execute function voice_flea_private.guard_conversation_identity();
CREATE OR REPLACE FUNCTION voice_flea_private.guard_trade_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor uuid:=auth.uid(); begin
 -- Anonymous writes are denied by RLS. Trusted server operations have no user UID.
 if actor is null then return new; end if;
 if tg_op='INSERT' then
  if new.is_inquiry then return new; end if;
  if new.delivery_status<>'none' or new.delivery_path is not null or new.delivered_at is not null or new.accepted_at is not null then raise exception 'New trades must be unfulfilled' using errcode='42501';end if;
  if (new.listing_id is null)=(new.job_id is null) then raise exception 'Trade target required' using errcode='42501';end if;
  if new.listing_id is not null and not exists(select 1 from public.payments p where p.listing_id=new.listing_id and p.buyer_id=new.buyer_id and p.seller_id=new.seller_id and p.status='paid') then raise exception 'Paid purchase required' using errcode='42501';end if;
  if new.job_id is not null and not exists(select 1 from public.jobs j join public.applications a on a.job_id=j.id where j.id=new.job_id and j.buyer_id=new.buyer_id and a.applicant_id=new.seller_id and a.status='accepted') then raise exception 'Accepted application required' using errcode='42501';end if;
  return new;
 end if;
 if new.listing_id is distinct from old.listing_id or new.job_id is distinct from old.job_id or new.created_at is distinct from old.created_at then
  -- Preserve FK cleanup for deleted records, without allowing reassignment.
  if not(new.created_at=old.created_at and (new.listing_id=old.listing_id or (new.listing_id is null and not exists(select 1 from public.listings where id=old.listing_id))) and (new.job_id=old.job_id or (new.job_id is null and not exists(select 1 from public.jobs where id=old.job_id)))) then raise exception 'Trade identity cannot change' using errcode='42501';end if;
 end if;
 if row(new.delivery_path,new.delivery_status,new.delivered_at,new.accepted_at) is not distinct from row(old.delivery_path,old.delivery_status,old.delivered_at,old.accepted_at) then return new;end if;
 if old.is_inquiry then raise exception 'Inquiry has no delivery' using errcode='42501';end if;
 if actor=old.seller_id and old.delivery_status<>'accepted' and new.delivery_status='submitted' and new.delivery_path like old.id::text||'/%' and new.accepted_at is null then
  new.delivered_at=now();return new;
 end if;
 if actor=old.buyer_id and old.delivery_status='submitted' and old.delivery_path is not null and new.delivery_status='accepted' and new.delivery_path=old.delivery_path and new.delivered_at=old.delivered_at then
  new.accepted_at=now();return new;
 end if;
 raise exception 'Delivery transition is not allowed for this user' using errcode='42501';
end $function$
;
create trigger guard_trade_authority before insert or update on public.conversations for each row execute function voice_flea_private.guard_trade_authority();
