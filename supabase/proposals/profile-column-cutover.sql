-- STAGE 2 REVIEW PROPOSAL ONLY. NOT APPLIED. NEVER RUN WHILE BUILD43 REMAINS SUPPORTED.
-- Requires a validated replacement app, explicit cutover authorization and verified retirement of legacy clients.
begin;
do $$ begin
 if current_setting('voice_flea.legacy_profiles_retired',true) is distinct from 'confirmed' then
   raise exception 'STOP: legacy build43 retirement and cutover approval must be verified first';
 end if;
end $$;
revoke select on public.profiles from anon, authenticated;
revoke select (id, verified, created_at, updated_at, profile_bio, profile_specialties,
 profile_languages, display_name, country, languages, dialects, voice_tags, bio,
 stripe_account_id, avatar_path, tagline, specialties, profile_tagline)
 on public.profiles from anon, authenticated;
grant select (id, verified, created_at, updated_at, profile_bio, profile_specialties,
 profile_languages, display_name, country, languages, dialects, voice_tags, bio,
 avatar_path, tagline, specialties, profile_tagline) on public.profiles to anon, authenticated;
do $$ begin
 if has_column_privilege('anon','public.profiles','stripe_account_id','SELECT') or has_column_privilege('authenticated','public.profiles','stripe_account_id','SELECT') then
   raise exception 'Inherited/PUBLIC grant still exposes Stripe ID; abort without changing unrelated roles';
 end if;
 if not has_column_privilege('service_role','public.profiles','stripe_account_id','SELECT') then
   raise exception 'Service-only Stripe lookup must remain available';
 end if;
end $$;
commit;
