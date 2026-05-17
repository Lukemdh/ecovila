-- Step 6: Guest-facing confirmation and cancellation RPCs
-- These security-definer functions allow anonymous guests to:
--   1. Read their pending reservation timer status
--   2. Extend a cash reservation once
--   3. Cancel a pending reservation (from the confirmation page)
--   4. Cancel a reservation by token + phone (from the anulare link)

set search_path = public, extensions;

-- Returns payment type, status, and cash timer fields for a pending reservation.
-- Used by confirmare.html to fetch live timer data from the server.
create or replace function public.get_pending_reservation_status(res_id uuid)
returns table (
  payment_type     text,
  payment_status   text,
  cash_expires_at  timestamptz,
  cash_extended    boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    r.payment_type,
    r.payment_status,
    r.cash_expires_at,
    r.cash_extended
  from public.reservations r
  where r.id = res_id
  limit 1;
$$;

-- Extends cash_expires_at by 30 minutes. Allowed only once per reservation.
-- Returns the new cash_expires_at on success, null if extension was not eligible.
create or replace function public.extend_cash_reservation(res_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_new_expiry timestamptz;
begin
  update public.reservations
  set
    cash_expires_at = cash_expires_at + interval '30 minutes',
    cash_extended   = true
  where
    id              = res_id
    and payment_type    = 'cash'
    and payment_status  = 'pending'
    and cash_extended   = false
    and cash_expires_at > now()
    and cancelled_at    is null
  returning cash_expires_at into v_new_expiry;

  return v_new_expiry;
end;
$$;

-- Cancels a pending reservation by ID (guest pressing "Anulează" on confirmare page).
-- Returns true if the reservation was cancelled, false if it was not found or already processed.
create or replace function public.cancel_pending_reservation(res_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_affected integer;
begin
  update public.reservations
  set
    payment_status      = 'cancelled',
    cancelled_at        = now(),
    cancellation_reason = 'guest_request'
  where
    id             = res_id
    and payment_status = 'pending'
    and cancelled_at   is null;

  get diagnostics v_affected = row_count;
  return v_affected > 0;
end;
$$;

-- Cancels a reservation via cancellation token + phone verification (anulare link flow).
-- Enforces the 72-hour rule: cancellation is blocked if check-in is within 72 hours.
-- Returns one of: 'cancelled' | 'already_cancelled' | 'not_found' | 'phone_mismatch' | 'too_late'
create or replace function public.cancel_reservation_by_token(
  lookup_token     text,
  confirming_phone text
)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation_id  uuid;
  v_guest_phone     text;
  v_check_in        date;
  v_payment_status  text;
  v_cancelled_at    timestamptz;
begin
  -- Find reservation by unused token
  select
    r.id,
    r.guest_phone,
    r.check_in,
    r.payment_status,
    r.cancelled_at
  into
    v_reservation_id,
    v_guest_phone,
    v_check_in,
    v_payment_status,
    v_cancelled_at
  from public.cancellation_tokens ct
  join public.reservations r on r.id = ct.reservation_id
  where
    ct.token = lookup_token
    and ct.used = false
  limit 1;

  if v_reservation_id is null then
    return 'not_found';
  end if;

  if v_payment_status = 'cancelled' or v_cancelled_at is not null then
    return 'already_cancelled';
  end if;

  if v_guest_phone <> confirming_phone then
    return 'phone_mismatch';
  end if;

  -- 72-hour rule: block if check-in (at 13:00) is within 72 hours from now
  if now() + interval '72 hours' > v_check_in::timestamptz + interval '13 hours' then
    return 'too_late';
  end if;

  -- Cancel the reservation
  update public.reservations
  set
    payment_status      = 'cancelled',
    cancelled_at        = now(),
    cancellation_reason = 'guest_request'
  where id = v_reservation_id;

  -- Mark token as used so the link cannot be replayed
  update public.cancellation_tokens
  set used = true
  where token = lookup_token;

  return 'cancelled';
end;
$$;

-- Grant execute to anonymous and authenticated users
revoke all on function public.get_pending_reservation_status(uuid) from public;
grant execute on function public.get_pending_reservation_status(uuid) to anon, authenticated;

revoke all on function public.extend_cash_reservation(uuid) from public;
grant execute on function public.extend_cash_reservation(uuid) to anon, authenticated;

revoke all on function public.cancel_pending_reservation(uuid) from public;
grant execute on function public.cancel_pending_reservation(uuid) to anon, authenticated;

revoke all on function public.cancel_reservation_by_token(text, text) from public;
grant execute on function public.cancel_reservation_by_token(text, text) to anon, authenticated;
