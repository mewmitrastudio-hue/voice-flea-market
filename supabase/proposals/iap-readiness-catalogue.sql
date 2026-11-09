-- Local proposal only; no production application. Run as one transaction.
-- Uses existing service_role schema USAGE and SELECT; no new table privileges.
begin;
create function public.read_voice_iap_diagnostic_products()
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'product_id',p.product_id,'amount_jpy',p.amount_jpy,
  'sandbox_enabled',p.sandbox_enabled,'production_enabled',p.production_enabled
 ) order by p.amount_jpy),'[]'::jsonb)
 from voice_flea_private.voice_iap_products p
$$;
revoke all on function public.read_voice_iap_diagnostic_products() from public,anon,authenticated;
grant execute on function public.read_voice_iap_diagnostic_products() to service_role;
commit;
