-- ADR-104: partial cancellation must cancel all the selected villas or none.
--
-- The CRM's new "anulare parțială" lets staff drop SOME villas of a booking and
-- refund a manually typed amount. Doing that as a PostgREST UPDATE guarded on
-- `cancelled_at is null and payment_status in ('pending','paid')` and then
-- counting the returned ids in JavaScript is NOT all-or-nothing: if one of two
-- selected rows was cancelled between the Edge Function's read and its write,
-- PostgREST commits the one row that still matched, and the function's 409
-- arrives after the fact — one villa cancelled, no refund, no notice to the
-- guest. Same failure ADR-101 fixed for the reschedule RPC, with money attached.
--
-- So the cancellation runs inside one transaction that asserts its own
-- cardinality: the UPDATE's RETURNING set must have exactly as many rows as
-- distinct ids were requested, or P0002 rolls the whole thing back and the
-- caller never reaches the MAIB refund.
--
-- Scoping every row to p_booking_group_id keeps the blast radius to one booking:
-- a caller cannot cancel arbitrary reservations by id alone.
--
-- The refund is CLAIMED in the same transaction (p_refund_pay_id...). Two reasons:
--
--   * MAIB allows one refund per payment, and maib_refunds.pay_id is unique, so
--     the insert IS the lock. Checking for an existing refund in the Edge
--     Function and then calling the refund engine is check-then-act: a guest
--     cancellation scheduling its own refund in that window would be silently
--     overwritten with the staff amount and paid out immediately.
--   * It makes the refund durable before any inventory is released. If the
--     function dies between cancelling and calling MAIB, the row is already
--     there as 'requested' with a due time a few minutes out, so the
--     reconcile-refunds cron finishes the payout instead of the guest silently
--     losing both the villa and the money.
--
-- Either both happen or neither: an existing refund raises P0001 and the
-- cancellation rolls back with it.
create or replace function public.cancel_reservation_rows(
  p_booking_group_id uuid,
  p_reservation_ids uuid[],
  p_reason text default 'Anulare parțială din CRM',
  p_refund_pay_id text default null,
  p_refund_amount integer default null,
  p_refund_currency text default 'MDL',
  p_refund_reason text default 'crm_partial_cancellation',
  p_refund_eligible_at timestamptz default null
)
  returns setof uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_requested integer;
  v_cancelled uuid[];
  v_claimed integer;
begin
  select count(distinct requested.id) into v_requested
  from unnest(coalesce(p_reservation_ids, '{}'::uuid[])) as requested(id);

  if v_requested = 0 then
    raise exception 'No reservations were selected for cancellation'
      using errcode = 'P0002';
  end if;

  if p_refund_pay_id is not null then
    -- Only a refund staff previously ABORTED may be re-claimed; a requested,
    -- processing, failed or succeeded row means someone else owns this payment's
    -- single refund and the caller must resolve that first.
    insert into public.maib_refunds (
      pay_id, booking_group_id, amount, currency, status, reason,
      request_payload, eligible_at
    )
    values (
      p_refund_pay_id, p_booking_group_id, p_refund_amount,
      coalesce(p_refund_currency, 'MDL'), 'requested', p_refund_reason,
      jsonb_build_object(
        'amount', p_refund_amount,
        'reason', p_refund_reason,
        'source', 'reservation-partial-cancel'
      ),
      p_refund_eligible_at
    )
    on conflict (pay_id) do update set
      booking_group_id = excluded.booking_group_id,
      amount           = excluded.amount,
      currency         = excluded.currency,
      status           = 'requested',
      reason           = excluded.reason,
      request_payload  = excluded.request_payload,
      eligible_at      = excluded.eligible_at,
      error_message    = null,
      updated_at       = now()
    where public.maib_refunds.status = 'cancelled';
    get diagnostics v_claimed = row_count;

    if v_claimed = 0 then
      raise exception 'A refund already exists for payment %', p_refund_pay_id
        using errcode = 'P0001';
    end if;
  end if;

  with cancelled as (
    update public.reservations r set
      payment_status = 'cancelled',
      payment_in_progress = false,
      payment_session_expires_at = null,
      cancelled_at = now(),
      cancellation_reason = p_reason
    where r.booking_group_id = p_booking_group_id
      and r.id = any(p_reservation_ids)
      and r.cancelled_at is null
      and r.payment_status in ('pending', 'paid')
    returning r.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_cancelled from cancelled;

  if coalesce(array_length(v_cancelled, 1), 0) <> v_requested then
    raise exception
      'Expected to cancel % reservation(s), matched %',
      v_requested, coalesce(array_length(v_cancelled, 1), 0)
      using errcode = 'P0002';
  end if;

  return query select unnest(v_cancelled);
end;
$$;

-- Service-role only, like the reschedule and swap RPCs: the browser must never
-- be able to cancel reservations directly, only through the Edge Function that
-- validates the selection, the payment state and the refund.
revoke all on function public.cancel_reservation_rows(
  uuid, uuid[], text, text, integer, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.cancel_reservation_rows(
  uuid, uuid[], text, text, integer, text, text, timestamptz
) to service_role;
