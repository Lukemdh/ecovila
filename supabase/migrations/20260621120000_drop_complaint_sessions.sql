-- ADR-080: Retire the orphaned complaint OTP-login subsystem.
--
-- ADR-068 gated complaints behind a phone-OTP login that minted a short-lived
-- session token in public.complaint_sessions. ADR-080 makes the complaint form
-- auth-free (no login, no anonymity toggle), so complaint-login-start and
-- complaint-login-verify are deleted and nothing reads or writes this table any
-- more. Its rows are ephemeral 30-minute tokens, so dropping it loses no data.

set search_path = public, extensions;

drop table if exists public.complaint_sessions;
