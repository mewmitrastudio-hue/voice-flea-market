# Supabase SDK auth contract fixture

The complete official UMD response fetched on 2026-11-07 from:
https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.min.js

Both runtime fallback CDN URLs use this exact version. The unversioned @2 response observed during investigation was byte-identical. The checksum is in supabase-js-2.119.0.sha256. License: official package LICENSE, stored beside this file.

Test-only fixture. It is not included in www or the iOS web bundle. Tests run the real SDK with all network requests mocked locally; they never authenticate or modify a remote account. Keep the version, fixture, hash and runtime URLs aligned when intentionally upgrading. Adapter compatibility includes the SDK's main session key, -user, -code-verifier, -flows-code-verifier and bounded -flow-<id>-code-verifier suffixes within the new recording namespace only.
