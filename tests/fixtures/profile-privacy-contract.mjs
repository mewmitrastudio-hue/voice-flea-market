// Public schema/query contract checked against build43 commit
// 3894aed972778cc7da7818701c485afcabed14be. Synthetic rows only.
export const profileColumns = ['id','verified','created_at','updated_at','profile_bio',
 'profile_specialties','profile_languages','display_name','country','languages',
 'dialects','voice_tags','bio','stripe_account_id','avatar_path','tagline','specialties','profile_tagline'];
export const legacy43OwnerQuery = "sb.from('profiles').select('*').eq('id',currentUser.id).maybeSingle()";
