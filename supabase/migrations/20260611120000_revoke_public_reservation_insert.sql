-- Public reservations must go through the create-reservation Edge Function,
-- which validates input and recomputes the authoritative price server-side.
-- A direct PostgREST insert as anon would bypass that validation and allow a
-- client-chosen total_price, so the anon insert path is closed entirely.
-- The CRM keeps inserting as authenticated staff via the
-- "CRM staff can manage reservations" policy, and Edge Functions use the
-- service role, which bypasses RLS.

drop policy if exists "Public can create guest reservations" on public.reservations;

revoke insert on public.reservations from anon;
