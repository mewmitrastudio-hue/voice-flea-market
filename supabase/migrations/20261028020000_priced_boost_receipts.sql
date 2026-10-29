-- Never grant a boost or record revenue from a hardcoded plan price alone.
-- The Edge service supplies price/currency from the authenticated Apple payload.
-- Apple prices are milliunits. Revocations must still remove an earlier grant
-- even if its old receipt has no price or the catalogue price has since changed.
create function public.apply_priced_apple_boost(order_id uuid,tx_id text,sku text,tx_environment text,
 purchased_at timestamptz,revoked boolean,price_milliunits bigint,currency text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare amount integer;
begin
 amount=case sku when 'com.ayuhide.koenofurima.boost.silver' then 300
  when 'com.ayuhide.koenofurima.boost.gold' then 800
  when 'com.ayuhide.koenofurima.boost.platinum' then 1500 else null end;
 if amount is null or revoked is null or (not revoked and (
  price_milliunits is distinct from amount::bigint*1000 or currency is distinct from 'JPY')) then
  raise exception 'Apple boost price mismatch' using errcode='22023';
 end if;
 return public.apply_verified_apple_boost(order_id,tx_id,sku,tx_environment,purchased_at,revoked);
end $$;
revoke all on function public.apply_priced_apple_boost(uuid,text,text,text,timestamptz,boolean,bigint,text) from public,anon,authenticated;
grant execute on function public.apply_priced_apple_boost(uuid,text,text,text,timestamptz,boolean,bigint,text) to service_role;
