create index support_inquiries_admin_cursor_idx on public.support_inquiries(status,created_at desc,id desc);
create function voice_flea_private.admin_support_inquiries(
 filter_status text default 'open',query_text text default '',before_created timestamptz default null,before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb; more boolean; totals jsonb; needle text:=lower(btrim(coalesce(query_text,'')));
begin
 if auth.uid() is null or not voice_flea_private.is_moderator() or not voice_flea_private.account_available(auth.uid()) then
  raise exception 'Operator access required' using errcode='42501';end if;
 if filter_status is null or filter_status not in ('all','open','reviewing','closed') or char_length(needle)>120
  or (before_created is null)<>(before_id is null) then
  raise exception 'Invalid support filter' using errcode='22023';end if;
 select jsonb_build_object('total',count(*),'open',count(*) filter(where status='open'),
  'reviewing',count(*) filter(where status='reviewing'),'closed',count(*) filter(where status='closed'))
 into totals from public.support_inquiries;
 with page as (
  select i.id,i.user_id,i.category,i.subject,i.message,i.status,i.created_at,
   coalesce(nullif(btrim(i.reply_email),''),case when u.deleted_at is null then u.email end) reply_email,
   ack.state acknowledgement_state,ack.provider_event acknowledgement_event
  from public.support_inquiries i left join auth.users u on u.id=i.user_id
  left join lateral(select o.state,o.provider_event from voice_flea_private.app_mail_outbox o
   where o.kind='support_ack' and o.support_inquiry_id=i.id order by o.created_at desc limit 1)ack on true
  where (filter_status='all' or i.status=filter_status)
   and (needle='' or strpos(lower(i.id::text||' '||coalesce(i.subject,'')||' '||coalesce(i.message,'')||' '||coalesce(i.reply_email,'')||' '||coalesce(u.email,'')),needle)>0)
   and (before_created is null or (i.created_at,i.id)<(before_created,before_id))
  order by i.created_at desc,i.id desc limit 11
 ),visible as(select * from page order by created_at desc,id desc limit 10)
 select (select coalesce(jsonb_agg(to_jsonb(v) order by created_at desc,id desc),'[]'::jsonb) from visible v),
  (select count(*)>10 from page) into rows,more;
 return jsonb_build_object('summary',totals,'rows',rows,'has_more',more);
end $$;
revoke all on function voice_flea_private.admin_support_inquiries(text,text,timestamptz,uuid) from public,anon;
grant execute on function voice_flea_private.admin_support_inquiries(text,text,timestamptz,uuid) to authenticated;
create function public.admin_support_inquiries(
 filter_status text default 'open',query_text text default '',before_created timestamptz default null,before_id uuid default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 select voice_flea_private.admin_support_inquiries(filter_status,query_text,before_created,before_id)
$$;
revoke all on function public.admin_support_inquiries(text,text,timestamptz,uuid) from public,anon;
grant execute on function public.admin_support_inquiries(text,text,timestamptz,uuid) to authenticated;
