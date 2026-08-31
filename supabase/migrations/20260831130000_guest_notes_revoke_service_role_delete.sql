-- ADR-111 follow-up. 20260831120000 granted service_role only select/insert/update
-- on public.guest_notes, intending "no role the application uses can hard-delete a
-- guest note". A narrower GRANT does not take back what Supabase's default
-- privileges on new tables in `public` already conferred, so a probe after the
-- deploy still showed DELETE held by service_role — the one role every Edge
-- Function runs as.
--
-- Revoke it explicitly. `postgres` keeps DELETE deliberately: a genuine GDPR
-- erasure request should require a direct privileged connection, which is the
-- intended friction, not something an application bug can reach.
revoke delete on table public.guest_notes from service_role;

-- Same reasoning for the exclusions list: the office contacts must not be
-- removable by application code, or a note could be attached to them afterwards.
revoke delete on table public.guest_flag_exclusions from service_role;
