-- Service-only append of an additionally verified original/submitted JWS after
-- the latest Apple proof has already been durably classified. No grant, refund,
-- allocation, admission or finish authority is created by retaining this proof.
create function public.retain_native_verified_evidence(actor uuid,order_id uuid,tx_id text,tx_environment text,signed_transaction text)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare r voice_flea_private.native_verified_receipts;
begin
 select * into r from voice_flea_private.native_verified_receipts x where x.environment=tx_environment and x.transaction_id=tx_id for update;
 if not found or r.order_id is distinct from order_id or (actor is not null and r.owner_id<>actor)
  or signed_transaction is null or length(signed_transaction) not between 1 and 30000 then raise exception 'Receipt evidence binding mismatch'; end if;
 insert into voice_flea_private.native_verified_receipt_evidence(environment,transaction_id,signed_transaction)
 select tx_environment,tx_id,signed_transaction where not exists(select 1 from voice_flea_private.native_verified_receipt_evidence e
  where e.environment=tx_environment and e.transaction_id=tx_id and e.signed_transaction=retain_native_verified_evidence.signed_transaction);
 return jsonb_build_object('retained',true);
end $$;
revoke all on function public.retain_native_verified_evidence(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.retain_native_verified_evidence(uuid,uuid,text,text,text) to service_role;
