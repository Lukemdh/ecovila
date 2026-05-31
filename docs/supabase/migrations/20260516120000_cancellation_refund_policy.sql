-- Align the public cancellation RPC with the current legal policy:
-- online cancellation stays available, while refund eligibility is communicated separately.
-- Returns one of: 'cancelled' | 'already_cancelled' | 'not_found' | 'phone_mismatch'

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
  v_payment_status  text;
  v_cancelled_at    timestamptz;
begin
  -- Find reservation by unused token.
  select
    r.id,
    r.guest_phone,
    r.payment_status,
    r.cancelled_at
  into
    v_reservation_id,
    v_guest_phone,
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

  update public.reservations
  set
    payment_status      = 'cancelled',
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
