create function public.current_operator_access()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select voice_flea_private.is_moderator();
$$;

revoke all on function public.current_operator_access() from public, anon;
grant execute on function public.current_operator_access() to authenticated;
