-- Email is optional for office (walk-in) reservations added by staff in the CRM.
-- The public booking path still requires a valid email (enforced in the
-- create-reservation Edge Function), so only the NOT NULL is relaxed here.
--
-- The existing reservations_guest_email_check ( position('@' in guest_email) > 1 )
-- already permits NULL: a CHECK constraint only fails when its expression is
-- FALSE, and the expression evaluates to NULL (not FALSE) for a NULL email. So
-- NULL emails pass while malformed non-null emails ('', 'foo') stay rejected.
alter table public.reservations
  alter column guest_email drop not null;
