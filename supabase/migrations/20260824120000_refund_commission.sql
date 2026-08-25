-- ADR-105 expands the refund ledgers before any function starts writing quotes.
-- gross_amount/refund_amount deliberately remain nullable: old deployed
-- functions keep writing during the migration-to-function crossover, and a
-- NOT NULL column would turn a successful cancellation into a missing refund.
alter table public.maib_refunds
  add column if not exists gross_amount integer,
  add column if not exists withheld_commission integer not null default 0,
  add column if not exists commission_rate_bps integer not null default 0,
  add column if not exists refund_policy_version text;

alter table public.maib_refunds
  drop constraint if exists maib_refunds_quote_check,
  drop constraint if exists maib_refunds_commission_rate_bps_check;

alter table public.maib_refunds
  add constraint maib_refunds_quote_check check (
    gross_amount is null or (
      gross_amount = amount + withheld_commission
      and withheld_commission >= 0
      and withheld_commission <= gross_amount
    )
  ),
  add constraint maib_refunds_commission_rate_bps_check
    check (commission_rate_bps between 0 and 10000);

update public.maib_refunds
set gross_amount = amount,
    withheld_commission = 0,
    commission_rate_bps = 0,
    refund_policy_version = 'legacy-full-refund'
where gross_amount is null;

alter table public.reservation_changes
  add column if not exists refund_amount integer,
  add column if not exists refund_withheld integer not null default 0,
  add column if not exists refund_rate_bps integer not null default 0,
  add column if not exists refund_policy_version text;

alter table public.reservation_changes
  drop constraint if exists reservation_changes_refund_quote_check,
  drop constraint if exists reservation_changes_refund_rate_bps_check;

alter table public.reservation_changes
  add constraint reservation_changes_refund_quote_check check (
    refund_amount is null or (
      difference_amount = refund_amount + refund_withheld
      and refund_withheld >= 0
      and refund_withheld <= difference_amount
    )
  ),
  add constraint reservation_changes_refund_rate_bps_check
    check (refund_rate_bps between 0 and 10000);

-- Rows already paid back predate the policy and therefore returned the whole
-- difference. Stamp the historical fact rather than leaving executor fallbacks
-- to infer it forever.
update public.reservation_changes
set refund_amount = difference_amount,
    refund_withheld = 0,
    refund_rate_bps = 0,
    refund_policy_version = 'legacy-full-refund'
where status = 'refunded'
  and refund_amount is null;

-- A cancellation already in flight was decided under the old full-refund
-- promise. Its paid difference authorizations must ride that same decision even
-- if the new reconcile bundle first reaches them after policy activation.
update public.reservation_changes rc
set refund_amount = rc.difference_amount,
    refund_withheld = 0,
    refund_rate_bps = 0,
    refund_policy_version = 'legacy-full-refund'
where rc.status = 'paid'
  and rc.refunded_at is null
  and rc.difference_amount > 0
  and rc.refund_amount is null
  and exists (
    select 1
    from public.maib_refunds mr
    where mr.booking_group_id = rc.booking_group_id
      and mr.status in ('requested', 'processing', 'failed')
  );

-- PostgreSQL keys functions by argument types. Adding four defaulted arguments
-- with CREATE OR REPLACE would leave the old 8-argument overload alive and make
-- PostgREST's old 8-key crossover call ambiguous (42725), so remove that exact
-- signature first.
drop function if exists public.cancel_reservation_rows(
  uuid, uuid[], text, text, integer, text, text, timestamptz
);

create function public.cancel_reservation_rows(
  p_booking_group_id uuid,
  p_reservation_ids uuid[],
  p_reason text default 'Anulare parțială din CRM',
  p_refund_pay_id text default null,
  p_refund_amount integer default null,
  p_refund_currency text default 'MDL',
  p_refund_reason text default 'crm_partial_cancellation',
  p_refund_eligible_at timestamptz default null,
  p_refund_gross_amount integer default null,
  p_refund_withheld integer default 0,
  p_refund_rate_bps integer default 0,
  p_refund_policy_version text default null
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
    insert into public.maib_refunds (
      pay_id, booking_group_id, amount, gross_amount, withheld_commission,
      commission_rate_bps, refund_policy_version, currency, status, reason,
      request_payload, eligible_at
    )
    values (
      p_refund_pay_id, p_booking_group_id, p_refund_amount,
      p_refund_gross_amount, coalesce(p_refund_withheld, 0),
      coalesce(p_refund_rate_bps, 0), p_refund_policy_version,
      coalesce(p_refund_currency, 'MDL'), 'requested', p_refund_reason,
      jsonb_build_object(
        'gross', p_refund_gross_amount,
        'amount', p_refund_amount,
        'withheld', coalesce(p_refund_withheld, 0),
        'rateBps', coalesce(p_refund_rate_bps, 0),
        'version', p_refund_policy_version,
        'reason', p_refund_reason,
        'source', 'reservation-partial-cancel'
      ),
      p_refund_eligible_at
    )
    on conflict (pay_id) do update set
      booking_group_id       = excluded.booking_group_id,
      amount                 = excluded.amount,
      gross_amount           = excluded.gross_amount,
      withheld_commission    = excluded.withheld_commission,
      commission_rate_bps    = excluded.commission_rate_bps,
      refund_policy_version  = excluded.refund_policy_version,
      currency               = excluded.currency,
      status                 = 'requested',
      reason                 = excluded.reason,
      request_payload        = excluded.request_payload,
      eligible_at            = excluded.eligible_at,
      error_message          = null,
      updated_at             = now()
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

revoke all on function public.cancel_reservation_rows(
  uuid, uuid[], text, text, integer, text, text, timestamptz,
  integer, integer, integer, text
) from public, anon, authenticated;
grant execute on function public.cancel_reservation_rows(
  uuid, uuid[], text, text, integer, text, text, timestamptz,
  integer, integer, integer, text
) to service_role;
