-- Operator-supplied aggregate documents are evidence awaiting reconciliation.
-- Import does not change a payment, fee split, payout, balance or deletion gate.
create table voice_flea_private.apple_financial_reports(
 id uuid primary key default gen_random_uuid(),
 sha256 text not null unique check(sha256 ~ '^[0-9a-f]{64}$'),
 source_name text not null,source_text text not null check(octet_length(source_text)<=1048576),
 period_start date not null,period_end date not null check(period_end>=period_start),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 imported_by uuid not null,created_at timestamptz not null default clock_timestamp());
alter table voice_flea_private.apple_financial_reports enable row level security;
revoke all on voice_flea_private.apple_financial_reports from public,anon,authenticated;
grant select,insert on voice_flea_private.apple_financial_reports to service_role;

create function voice_flea_private.store_apple_financial_report(actor uuid,snapshot jsonb,source_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r voice_flea_private.apple_financial_reports;fingerprint text:=snapshot->>'sha256';
begin
 if actor is null or not voice_flea_private.account_available(actor) or not exists(select 1 from voice_flea_private.moderators where user_id=actor) then raise exception 'Operator required' using errcode='42501';end if;
 if snapshot is null or source_text is null or octet_length(source_text)>1048576
 or fingerprint is distinct from encode(sha256(convert_to(source_text,'UTF8')),'hex')
 or snapshot->>'state' is distinct from 'document_imported_unreconciled'
 or coalesce(snapshot->>'sha256','') !~ '^[0-9a-f]{64}$' or coalesce(length(snapshot->>'sourceName'),0) not between 1 and 180
 or jsonb_typeof(snapshot->'rows') is distinct from 'array' or jsonb_typeof(snapshot->'totals') is distinct from 'array'
 or jsonb_array_length(snapshot->'rows') not between 1 and 10000
 or (snapshot->>'rowCount')::integer<>jsonb_array_length(snapshot->'rows')
 or octet_length(snapshot::text)>6000000 then raise exception 'Invalid financial document' using errcode='22023';end if;
 insert into voice_flea_private.apple_financial_reports(sha256,source_name,source_text,period_start,period_end,snapshot,imported_by)
 values(snapshot->>'sha256',snapshot->>'sourceName',source_text,(snapshot->>'periodStart')::date,(snapshot->>'periodEnd')::date,snapshot,actor)
 on conflict(sha256) do nothing;
 select * into r from voice_flea_private.apple_financial_reports f where f.sha256=fingerprint;
 return jsonb_build_object('id',r.id,'sha256',r.sha256,'created_at',r.created_at,'state','document_imported_unreconciled');
end $$;
revoke all on function voice_flea_private.store_apple_financial_report(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function voice_flea_private.store_apple_financial_report(uuid,jsonb,text) to service_role;
create function public.store_apple_financial_report(actor uuid,snapshot jsonb,source_text text)
returns jsonb language sql security invoker set search_path='' as $$select voice_flea_private.store_apple_financial_report(actor,snapshot,source_text)$$;
revoke all on function public.store_apple_financial_report(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.store_apple_financial_report(uuid,jsonb,text) to service_role;

create function voice_flea_private.admin_apple_financial_reports()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not voice_flea_private.account_available(auth.uid()) or not voice_flea_private.is_moderator() then raise exception 'Operator required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id desc) from (
 select id,source_name,sha256,period_start,period_end,created_at,snapshot->'totals' totals,'document_imported_unreconciled'::text state
 from voice_flea_private.apple_financial_reports order by created_at desc,id desc limit 10) r),'[]'::jsonb);
end $$;
revoke all on function voice_flea_private.admin_apple_financial_reports() from public,anon;
grant execute on function voice_flea_private.admin_apple_financial_reports() to authenticated;
create function public.admin_apple_financial_reports()
returns jsonb language sql stable security invoker set search_path='' as $$select voice_flea_private.admin_apple_financial_reports()$$;
revoke all on function public.admin_apple_financial_reports() from public,anon;
grant execute on function public.admin_apple_financial_reports() to authenticated;
