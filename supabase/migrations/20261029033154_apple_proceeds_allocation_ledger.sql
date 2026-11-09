-- A report row is aggregate evidence. The operator explicitly selects the
-- payments it accounts for; no timestamp-based transaction links are invented.
-- Allocation records a liability, never bank receipt or a Stripe transfer.
create table voice_flea_private.apple_proceeds_batches(
 id uuid primary key default gen_random_uuid(),
 report_id uuid not null references voice_flea_private.apple_financial_reports(id),
 report_line integer not null,
 payment_ids uuid[] not null,
 source_proceeds numeric(20,6) not null check(source_proceeds>=0),
 allocated_jpy bigint not null check(allocated_jpy>=0),
 fractional_remainder numeric(7,6) not null check(fractional_remainder>=0 and fractional_remainder<1),
 basis text not null default 'operator_selected_report_units' check(basis='operator_selected_report_units'),
 allocated_by uuid not null,created_at timestamptz not null default clock_timestamp(),
 unique(report_id,report_line),
 check(source_proceeds=allocated_jpy+fractional_remainder));
create table voice_flea_private.apple_proceeds_allocations(
 payment_id uuid primary key references public.payments(id),
 batch_id uuid not null references voice_flea_private.apple_proceeds_batches(id),
 seller_id uuid not null,
 net_jpy bigint not null check(net_jpy>=0),
 platform_fee_jpy bigint not null check(platform_fee_jpy>=0),
 seller_amount_jpy bigint not null check(seller_amount_jpy>=0),
 state text not null default 'allocated_unpaid' check(state in ('allocated_unpaid','adjustment_required')),
 check(net_jpy=platform_fee_jpy+seller_amount_jpy));
create index apple_proceeds_allocations_batch on voice_flea_private.apple_proceeds_allocations(batch_id);
create index apple_proceeds_allocations_seller on voice_flea_private.apple_proceeds_allocations(seller_id,state);
alter table voice_flea_private.apple_proceeds_batches enable row level security;
alter table voice_flea_private.apple_proceeds_allocations enable row level security;
revoke all on voice_flea_private.apple_proceeds_batches,voice_flea_private.apple_proceeds_allocations from public,anon,authenticated;
grant select,insert,update on voice_flea_private.apple_proceeds_batches,voice_flea_private.apple_proceeds_allocations to service_role;

create function voice_flea_private.allocate_apple_proceeds(report uuid,line_number integer,purchases uuid[],evidence_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r voice_flea_private.apple_financial_reports;row_data jsonb;b voice_flea_private.apple_proceeds_batches;
 ids uuid[];n integer;i integer:=0;unit_net numeric;total_net numeric;base bigint;extra bigint;
 p public.payments;o voice_flea_private.voice_iap_orders;net bigint;fee bigint;
begin
 if auth.uid() is null or not voice_flea_private.account_available(auth.uid()) or not voice_flea_private.is_moderator() then
 raise exception 'Operator required' using errcode='42501';end if;
 if purchases is null or cardinality(purchases) not between 1 and 1000 or array_position(purchases,null) is not null
 or coalesce(length(trim(evidence_note)),0) not between 10 and 2000 then raise exception 'Explicit payment selection and reconciliation note required' using errcode='22023';end if;
 select array_agg(distinct x order by x) into ids from unnest(purchases) x;
 if cardinality(ids)<>cardinality(purchases) then raise exception 'Duplicate payment' using errcode='22023';end if;
 select * into r from voice_flea_private.apple_financial_reports where id=report for update;
 if not found then raise exception 'Report not found' using errcode='22023';end if;
 select * into b from voice_flea_private.apple_proceeds_batches where report_id=report and report_line=line_number;
 if found then
 if b.payment_ids is distinct from ids then raise exception 'Report row already allocated' using errcode='23505';end if;
 return jsonb_build_object('id',b.id,'allocated_jpy',b.allocated_jpy,'fractional_remainder',b.fractional_remainder,'state',case when exists(select 1 from voice_flea_private.apple_proceeds_allocations where batch_id=b.id and state='adjustment_required') then 'adjustment_required' else 'allocated_unpaid' end);end if;
 select value into row_data from jsonb_array_elements(r.snapshot->'rows') where (value->>'line')::integer=line_number;
 if row_data is null or row_data->>'kind' is distinct from 'S' or row_data->>'currency' is distinct from 'JPY'
 or row_data->>'customerCurrency' is distinct from 'JPY' or row_data->>'country' is distinct from 'JP'
 or coalesce(row_data->>'sku','') !~ '^com\.ayuhide\.koenofurima\.voice\.jpy[1-9][0-9]{0,7}$'
 then raise exception 'A Japanese yen voice sale row is required' using errcode='22023';end if;
 n=(row_data->>'quantity')::integer;unit_net=(row_data->>'unitProceeds')::numeric;total_net=(row_data->>'proceeds')::numeric;
 if n<>cardinality(ids) or n<1 or unit_net<0 or total_net<>unit_net*n
 or (row_data->>'customerPrice')::numeric<unit_net then raise exception 'Report units or proceeds mismatch' using errcode='22023';end if;
 -- Retain sub-yen amounts as a documented carry; allocate only whole yen.
 base=floor(unit_net)::bigint;extra=floor(total_net)::bigint-base*n;
 -- Lock payments in stable ID order, serializing allocation against refunds.
 perform 1 from public.payments where id=any(ids) order by id for update;
 if (select count(*) from public.payments where id=any(ids))<>n then raise exception 'Payment missing' using errcode='22023';end if;
 for p in select * from public.payments where id=any(ids) order by id loop
 select * into o from voice_flea_private.voice_iap_orders where payment_id=p.id;
 if not found or o.state<>'paid' or o.environment<>'Production' or o.product_id is distinct from row_data->>'sku'
 or o.transaction_id is distinct from p.apple_transaction_id or o.buyer_id<>p.buyer_id or o.seller_id<>p.seller_id
 or o.amount_jpy<>p.amount_jpy or p.amount_jpy<>(row_data->>'customerPrice')::numeric
 or p.payment_channel<>'ios' or p.apple_environment is distinct from 'Production' or p.apple_verified_at is null
 or p.status<>'paid' or p.refunded_amount_jpy is distinct from 0
 or p.seller_amount_jpy is not null or p.platform_fee_jpy is not null
 or not exists(select 1 from public.conversations c where c.payment_id=p.id and not c.is_inquiry and c.delivery_status='accepted')
 or exists(select 1 from voice_flea_private.apple_proceeds_allocations where payment_id=p.id)
 then raise exception 'Completed verified unallocated Apple sale required' using errcode='42501';end if;
 end loop;
 insert into voice_flea_private.apple_proceeds_batches(report_id,report_line,payment_ids,source_proceeds,allocated_jpy,fractional_remainder,allocated_by)
 values(report,line_number,ids,total_net,floor(total_net)::bigint,total_net-floor(total_net),auth.uid()) returning * into b;
 insert into voice_flea_private.apple_proceeds_notes(batch_id,actor,note) values(b.id,auth.uid(),trim(evidence_note));
 for p in select * from public.payments where id=any(ids) order by id loop
 i=i+1;net=base+case when i<=extra then 1 else 0 end;fee=round(net::numeric*15/100)::bigint;
 insert into voice_flea_private.apple_proceeds_allocations(payment_id,batch_id,seller_id,net_jpy,platform_fee_jpy,seller_amount_jpy)
 values(p.id,b.id,p.seller_id,net,fee,net-fee);
 update public.payments set platform_fee_jpy=fee,seller_amount_jpy=net-fee where id=p.id;
 end loop;
 return jsonb_build_object('id',b.id,'allocated_jpy',b.allocated_jpy,'fractional_remainder',b.fractional_remainder,'state','allocated_unpaid');
end $$;
-- Separate audit notes keep reconciliation context private and immutable to clients.
create table voice_flea_private.apple_proceeds_notes(
 id uuid primary key default gen_random_uuid(),batch_id uuid not null references voice_flea_private.apple_proceeds_batches(id),
 actor uuid not null,note text not null,created_at timestamptz not null default clock_timestamp());
create index apple_proceeds_notes_batch on voice_flea_private.apple_proceeds_notes(batch_id);
alter table voice_flea_private.apple_proceeds_notes enable row level security;
revoke all on voice_flea_private.apple_proceeds_notes from public,anon,authenticated;
grant select,insert on voice_flea_private.apple_proceeds_notes to service_role;
revoke all on function voice_flea_private.allocate_apple_proceeds(uuid,integer,uuid[],text) from public,anon;
grant execute on function voice_flea_private.allocate_apple_proceeds(uuid,integer,uuid[],text) to authenticated;
create function public.allocate_apple_proceeds(report uuid,line_number integer,purchases uuid[],evidence_note text)
returns jsonb language sql security invoker set search_path='' as $$select voice_flea_private.allocate_apple_proceeds(report,line_number,purchases,evidence_note)$$;
revoke all on function public.allocate_apple_proceeds(uuid,integer,uuid[],text) from public,anon;
grant execute on function public.allocate_apple_proceeds(uuid,integer,uuid[],text) to authenticated;

create function voice_flea_private.flag_apple_proceeds_adjustment()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.payment_channel='ios' and (new.status is distinct from 'paid' or new.refunded_amount_jpy is distinct from 0) then
 update voice_flea_private.apple_proceeds_allocations set state='adjustment_required' where payment_id=new.id;
 end if;return new;
end $$;
revoke all on function voice_flea_private.flag_apple_proceeds_adjustment() from public,anon,authenticated;
create trigger flag_apple_proceeds_adjustment after update of status,refunded_amount_jpy on public.payments
for each row execute function voice_flea_private.flag_apple_proceeds_adjustment();

create function voice_flea_private.apple_proceeds_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not voice_flea_private.account_available(auth.uid()) then raise exception 'Sign in required' using errcode='42501';end if;
 return jsonb_build_object('allocated_unpaid_count',(select count(*) from voice_flea_private.apple_proceeds_allocations where seller_id=auth.uid() and state='allocated_unpaid'),
 'allocated_unpaid_jpy',(select coalesce(sum(a.seller_amount_jpy),0) from voice_flea_private.apple_proceeds_allocations a where seller_id=auth.uid() and a.state='allocated_unpaid'),
 'adjustment_count',(select count(*) from voice_flea_private.apple_proceeds_allocations where seller_id=auth.uid() and state='adjustment_required'));
end $$;
revoke all on function voice_flea_private.apple_proceeds_status() from public,anon;
grant execute on function voice_flea_private.apple_proceeds_status() to authenticated;
create function public.apple_proceeds_status()
returns jsonb language sql stable security invoker set search_path='' as $$select voice_flea_private.apple_proceeds_status()$$;
revoke all on function public.apple_proceeds_status() from public,anon;
grant execute on function public.apple_proceeds_status() to authenticated;

create function voice_flea_private.admin_apple_proceeds_workbook(report uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r voice_flea_private.apple_financial_reports;
begin
 if auth.uid() is null or not voice_flea_private.account_available(auth.uid()) or not voice_flea_private.is_moderator() then raise exception 'Operator required' using errcode='42501';end if;
 select * into r from voice_flea_private.apple_financial_reports where id=report;
 if not found then raise exception 'Report not found' using errcode='22023';end if;
 return jsonb_build_object('id',r.id,'rows',r.snapshot->'rows',
 'batches',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'line',b.report_line,'paymentIds',b.payment_ids,'allocatedJpy',b.allocated_jpy,'remainder',b.fractional_remainder,'state',case when exists(select 1 from voice_flea_private.apple_proceeds_allocations a where a.batch_id=b.id and a.state='adjustment_required') then 'adjustment_required' else 'allocated_unpaid' end)) from voice_flea_private.apple_proceeds_batches b where b.report_id=r.id),'[]'::jsonb),
 'candidates',coalesce((select jsonb_agg(to_jsonb(c)) from (
 select p.id,p.seller_id,p.amount_jpy,p.paid_at,o.product_id,p.apple_transaction_id
 from public.payments p join voice_flea_private.voice_iap_orders o on o.payment_id=p.id and o.environment='Production' and o.state='paid'
 where p.payment_channel='ios' and p.apple_environment='Production' and p.apple_verified_at is not null
 and p.status='paid' and p.refunded_amount_jpy=0 and p.seller_amount_jpy is null and p.platform_fee_jpy is null
 and exists(select 1 from public.conversations c where c.payment_id=p.id and not c.is_inquiry and c.delivery_status='accepted')
 and not exists(select 1 from voice_flea_private.apple_proceeds_allocations a where a.payment_id=p.id)
 order by p.paid_at,p.id limit 1001) c),'[]'::jsonb));
end $$;
revoke all on function voice_flea_private.admin_apple_proceeds_workbook(uuid) from public,anon;
grant execute on function voice_flea_private.admin_apple_proceeds_workbook(uuid) to authenticated;
create function public.admin_apple_proceeds_workbook(report uuid)
returns jsonb language sql stable security invoker set search_path='' as $$select voice_flea_private.admin_apple_proceeds_workbook(report)$$;
revoke all on function public.admin_apple_proceeds_workbook(uuid) from public,anon;
grant execute on function public.admin_apple_proceeds_workbook(uuid) to authenticated;
