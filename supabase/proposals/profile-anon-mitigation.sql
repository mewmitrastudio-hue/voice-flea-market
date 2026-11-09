-- REVIEW PROPOSAL ONLY: not a migration, not applied to production.
-- Temporary anon-only mitigation. Authenticated non-owner disclosure REMAINS.
-- Do not extend this revoke to authenticated while build43 is supported.
begin;
revoke select on public.profiles from anon;
revoke select (id, verified, created_at, updated_at, profile_bio, profile_specialties,
 profile_languages, display_name, country, languages, dialects, voice_tags, bio,
 stripe_account_id, avatar_path, tagline, specialties, profile_tagline)
 on public.profiles from anon;
grant select (id, verified, created_at, updated_at, profile_bio, profile_specialties,
 profile_languages, display_name, country, languages, dialects, voice_tags, bio,
 avatar_path, tagline, specialties, profile_tagline) on public.profiles to anon;
do $$ begin
 if has_column_privilege('anon','public.profiles','stripe_account_id','SELECT') then
   raise exception 'Inherited/PUBLIC grant still exposes Stripe ID; abort without changing unrelated roles';
 end if;
 if not has_table_privilege('authenticated','public.profiles','SELECT') then
   raise exception 'Build43 authenticated wildcard compatibility is not preserved';
 end if;
end $$;
commit;
