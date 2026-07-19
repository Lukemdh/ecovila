-- ADR-100: temporary staff holds ("rezervare temporară", 1h / 3h / 8h).
--
-- Staff need to block a villa while a client's cheque or bank transfer clears.
-- A hold is an ordinary reservation row, so the exclusion constraint
-- reservations_no_room_overlap keeps guests and staff out of the villa exactly
-- as a real booking does. Its shape:
--
--   payment_type    = 'office'   (a staff booking, 20260517190000)
--   payment_status  = 'pending'  (not paid yet -> still blocks the room)
--   cash_expires_at = deadline   (reused: "this pending row dies at T")
--   paid_at         = null       (so finance never counts or reports it)
--
-- So: a LIVE HOLD is office + pending + cash_expires_at not null. Every
-- cash-specific path in the codebase is already gated on payment_type = 'cash'
-- (expiry cron, expiry-warning SMS, cash extension, confirm-reservation-payment),
-- so none of them can see a hold. Pre-existing office rows are all `paid` with a
-- null cash_expires_at, so they can never match the predicate either.
--
-- No new column: adding hold_expires_at would duplicate the "pending row with a
-- deadline" concept the schema already has, and would need its own index and its
-- own countdown/confirmation plumbing. If holds later gain extensions, history or
-- their own analytics, add a reservation-kind column and a dedicated expiry
-- timestamp together — not a lone boolean.

-- 1. The deadline is stamped by the DATABASE, never by the admin browser.
--
-- Staff rows are inserted straight from the CRM (admin/js/crm-sidebar.js), so a
-- laptop with a wrong clock could otherwise create a hold that is already expired
-- or one that lasts for days. This trigger reads the requested duration from the
-- client value and snaps it to the nearest allowed bucket measured from server
-- now(). Clock skew therefore changes nothing but, at worst, which of the three
-- buttons you appear to have pressed — the hold is always 1, 3 or 8 hours long
-- and always starts now.
create or replace function public.enforce_temporary_hold_expiry()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  requested_hours numeric;
  snapped_hours integer;
begin
  if new.payment_type <> 'office'
    or new.payment_status <> 'pending'
    or new.cash_expires_at is null
  then
    return new;
  end if;

  requested_hours := extract(epoch from (new.cash_expires_at - now())) / 3600.0;

  -- Midpoints between the three allowed durations (1h, 3h, 8h).
  snapped_hours := case
    when requested_hours < 2 then 1
    when requested_hours < 5.5 then 3
    else 8
  end;

  new.cash_expires_at := now() + make_interval(hours => snapped_hours);
  -- A hold is never paid. Belt and braces: paid_at drives the finance
  -- cancellation report, and an expired hold must never surface there.
  new.paid_at := null;

  return new;
end;
$$;

drop trigger if exists enforce_temporary_hold_expiry on public.reservations;

create trigger enforce_temporary_hold_expiry
before insert on public.reservations
for each row
execute function public.enforce_temporary_hold_expiry();

-- 1b. A live hold must ALWAYS carry a deadline.
--
-- Without this, an `office + pending + NULL` row would be a villa blocked
-- forever and invisible to everything that manages holds: the trigger above
-- returns early on a null deadline, and the panel, both RPCs and the expiry cron
-- all require a non-null one. The exclusion constraint would still keep the
-- villa off the market with nothing in the CRM able to release it.
--
-- NOT VALID so the migration cannot fail on pre-existing rows (every office row
-- to date is `paid` with a null deadline, so none should match anyway) — it is
-- enforced on every INSERT and UPDATE from here on, which is what matters.
alter table public.reservations
  drop constraint if exists reservations_live_hold_requires_deadline;

alter table public.reservations
  add constraint reservations_live_hold_requires_deadline
  check (
    payment_type <> 'office'
    or payment_status <> 'pending'
    or cancelled_at is not null
    or cash_expires_at is not null
  )
  not valid;

-- 2. Confirming a hold ("cheque cleared") — whole group, server clock, atomic.
--
-- Access model matches swap_reservation_rooms (ADR-091): the logged-in CRM calls
-- this RPC directly as `authenticated`, SECURITY DEFINER bypasses RLS, so the
-- function gates itself on the writer role. Angela stays read-only.
--
-- The deadline is re-checked against server now() inside the UPDATE: between
-- cash_expires_at and the next cron tick the row is still `pending`, and without
-- this predicate the CRM could revive a hold the guest-facing calendar has
-- already treated as dead for up to a minute.
create or replace function public.confirm_temporary_hold(p_booking_group_id uuid)
  returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  confirmed integer;
  leftover integer;
begin
  if public.ecovila_app_role() <> 'diana' then
    raise exception 'Only the diana staff role may confirm a temporary hold'
      using errcode = '42501';
  end if;

  if p_booking_group_id is null then
    raise exception 'A booking group id is required';
  end if;

  update public.reservations r
     set payment_status = 'paid',
         cash_expires_at = null
   where r.booking_group_id = p_booking_group_id
     and r.payment_type = 'office'
     and r.payment_status = 'pending'
     and r.cancelled_at is null
     and r.cash_expires_at is not null
     and r.cash_expires_at > now();
  get diagnostics confirmed = row_count;

  if confirmed = 0 then
    raise exception 'Rezervarea temporară a expirat sau a fost deja eliberată'
      using errcode = 'P0002';
  end if;

  -- Every row of a group is inserted in one statement and therefore shares one
  -- deadline, so a half-confirmed group should be impossible. Assert it anyway:
  -- raising here rolls the whole confirmation back rather than leaving a booking
  -- split between paid and about-to-expire rows.
  select count(*) into leftover
    from public.reservations r
   where r.booking_group_id = p_booking_group_id
     and r.payment_status = 'pending'
     and r.cancelled_at is null;

  if leftover > 0 then
    raise exception 'Rezervarea temporară nu a putut fi confirmată integral (% camere rămase)', leftover
      using errcode = 'P0002';
  end if;

  return confirmed;
end;
$$;

-- 3. Releasing a hold early ("the cheque bounced") — whole group, one statement.
-- Deliberately NOT the CRM delete path: that one is built for real bookings and
-- notifies the guest / attempts a refund. A hold was never paid and the guest was
-- never promised anything, so it just disappears.
create or replace function public.release_temporary_hold(p_booking_group_id uuid)
  returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  released integer;
begin
  if public.ecovila_app_role() <> 'diana' then
    raise exception 'Only the diana staff role may release a temporary hold'
      using errcode = '42501';
  end if;

  if p_booking_group_id is null then
    raise exception 'A booking group id is required';
  end if;

  update public.reservations r
     set payment_status = 'cancelled',
         cancelled_at = now(),
         cancellation_reason = 'hold_released'
   where r.booking_group_id = p_booking_group_id
     and r.payment_type = 'office'
     and r.payment_status = 'pending'
     and r.cancelled_at is null
     and r.cash_expires_at is not null;
  get diagnostics released = row_count;

  if released = 0 then
    raise exception 'Rezervarea temporară nu mai este activă'
      using errcode = 'P0002';
  end if;

  return released;
end;
$$;

-- Revoking from PUBLIC also strips the implicit EXECUTE every role inherits, so
-- the grants must be explicit (same pattern as public.rate_limit_hit, ADR-060).
revoke all on function public.confirm_temporary_hold(uuid) from public, anon, authenticated;
grant execute on function public.confirm_temporary_hold(uuid) to authenticated, service_role;

revoke all on function public.release_temporary_hold(uuid) from public, anon, authenticated;
grant execute on function public.release_temporary_hold(uuid) to authenticated, service_role;

-- 4. Auto-release. Pure SQL on pg_cron, like ecovila-expire-maib-sessions
-- (20260527082000) — not a branch inside expire-cash-reservations, because that
-- function texts and emails the guest when a hold dies. A hold is internal: it
-- expires silently and the villa simply becomes bookable again.
--
-- Covered by the existing reservations_payment_status_idx (payment_status,
-- cash_expires_at) index.
do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'ecovila-expire-temporary-holds'
  ) then
    perform cron.unschedule('ecovila-expire-temporary-holds');
  end if;

  perform cron.schedule(
    'ecovila-expire-temporary-holds',
    '* * * * *',
    $cron$
      update public.reservations
         set payment_status = 'cancelled',
             cancelled_at = now(),
             cancellation_reason = 'hold_expired'
       where payment_type = 'office'
         and payment_status = 'pending'
         and cancelled_at is null
         and cash_expires_at is not null
         and cash_expires_at < now();
    $cron$
  );
end;
$$;
