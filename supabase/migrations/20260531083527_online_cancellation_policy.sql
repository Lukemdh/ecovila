-- Enforce the current public online cancellation policy:
-- - cash reservations are reimbursed only at the office, not cancelled online;
-- - online cancellation is available at least 7 calendar days before arrival
--   or during the first 2 hours after reservation creation.
-- Returns one of: 'cancelled' | 'already_cancelled' | 'not_found' |
-- 'phone_mismatch' | 'cash_office' | 'too_late'

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
  v_payment_type    text;
  v_payment_status  text;
  v_cancelled_at    timestamptz;
  v_check_in        date;
  v_created_at      timestamptz;
  v_days_until_arrival integer;
begin
  select
    r.id,
    r.guest_phone,
    r.payment_type,
    r.payment_status,
    r.cancelled_at,
    r.check_in,
    r.created_at
  into
    v_reservation_id,
    v_guest_phone,
    v_payment_type,
    v_payment_status,
    v_cancelled_at,
    v_check_in,
    v_created_at
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

  if v_payment_type = 'cash' then
    return 'cash_office';
  end if;

  v_days_until_arrival := v_check_in - (timezone('Europe/Chisinau', now())::date);

  if not (
    v_days_until_arrival >= 7
    or (now() >= v_created_at and now() - v_created_at < interval '2 hours')
  ) then
    return 'too_late';
  end if;

  update public.reservations
  set
    payment_status      = 'cancelled',
    payment_in_progress = false,
    payment_session_expires_at = null,
    cancelled_at        = now(),
    cancellation_reason = 'guest_request'
  where id = v_reservation_id;

  update public.cancellation_tokens
  set used = true
  where token = lookup_token;

  return 'cancelled';
end;
$$;

revoke all on function public.cancel_reservation_by_token(text, text) from public;
grant execute on function public.cancel_reservation_by_token(text, text) to anon, authenticated;
