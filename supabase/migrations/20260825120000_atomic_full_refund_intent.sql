-- ADR-105 final QA: one cancellation quote spans the main payment and every
-- paid add-guests authorization. The previous Edge Function updated those rows
-- one by one, so a late failure committed a prefix and let the executor mix a
-- stamped net with an unstamped gross. This additive RPC is the new writer; old
-- deployed functions keep using the existing tables/functions unchanged during
-- the migration-to-function crossover.

-- Old writers can still create a nullable quote after the ADR-105 migration ran.
-- Once a main legacy intent exists, explicitly mark its outstanding differences
-- legacy too; the executor is deliberately forbidden from inferring legacy from
-- NULL because NULL is also the signature of a partially failed new intent.
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
      and (
        mr.refund_policy_version = 'legacy-full-refund'
        or mr.gross_amount is null
      )
  );

drop function if exists public.prepare_full_refund_intent(
  text, uuid, integer, integer, integer, integer, text, text, text, text,
  timestamptz, boolean
);

create function public.prepare_full_refund_intent(
  p_pay_id text,
  p_booking_group_id uuid,
  p_main_amount integer,
  p_main_gross_amount integer,
  p_main_withheld integer,
  p_main_rate_bps integer,
  p_main_policy_version text,
  p_currency text,
  p_reason text,
  p_source text,
  p_eligible_at timestamptz default null,
  p_allow_cancelled boolean default false
)
returns table (
  main_status text,
  main_eligible_at timestamptz,
  main_amount integer,
  main_gross_amount integer,
  main_withheld integer,
  main_rate_bps integer,
  main_policy_version text,
  change_quotes jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_main public.maib_refunds%rowtype;
  v_effective_rate integer := p_main_rate_bps;
  v_effective_version text := p_main_policy_version;
  v_was_unquoted boolean := false;
begin
  if p_pay_id is null or btrim(p_pay_id) = '' or p_booking_group_id is null then
    raise exception 'Refund payment and booking group are required' using errcode = 'P0002';
  end if;
  if p_main_amount <= 0
     or p_main_gross_amount <> p_main_amount + p_main_withheld
     or p_main_withheld < 0
     or p_main_rate_bps not between 0 and 10000
     or p_main_policy_version is null then
    raise exception 'Invalid main refund quote' using errcode = 'P0002';
  end if;

  select * into v_main
  from public.maib_refunds
  where pay_id = p_pay_id
  for update;

  if found and v_main.gross_amount is null then
    -- An old deployed writer can still land here after this migration but
    -- before the Edge Function rollout finishes. Brand that already-made
    -- full-refund promise explicitly; the executor never infers legacy itself.
    v_was_unquoted := true;
    v_effective_rate := 0;
    v_effective_version := 'legacy-full-refund';
    update public.maib_refunds set
      gross_amount = amount,
      withheld_commission = 0,
      commission_rate_bps = 0,
      refund_policy_version = v_effective_version,
      updated_at = now()
    where pay_id = p_pay_id
    returning * into v_main;
  end if;

  if found and v_main.status = 'succeeded' then
    -- The provider's single refund slot is spent. Return the stored picture but
    -- never authorize new difference money under a later cancellation attempt.
    if v_was_unquoted then
      update public.reservation_changes rc set
        refund_amount = rc.difference_amount,
        refund_withheld = 0,
        refund_rate_bps = 0,
        refund_policy_version = 'legacy-full-refund',
        updated_at = now()
      where rc.booking_group_id = p_booking_group_id
        and rc.status = 'paid'
        and rc.refunded_at is null
        and rc.difference_amount > 0
        and rc.refund_amount is null;
    end if;
    return query
    select
      v_main.status,
      v_main.eligible_at,
      v_main.amount,
      coalesce(v_main.gross_amount, v_main.amount),
      coalesce(v_main.withheld_commission, 0),
      coalesce(v_main.commission_rate_bps, 0),
      coalesce(v_main.refund_policy_version, 'legacy-full-refund'),
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'changeId', rc.id,
          'gross', rc.difference_amount,
          'net', rc.refund_amount,
          'withheld', rc.refund_withheld,
          'rateBps', rc.refund_rate_bps,
          'version', rc.refund_policy_version
        ) order by rc.id)
        from public.reservation_changes rc
        where rc.booking_group_id = p_booking_group_id
          and rc.status in ('paid', 'refunded')
          and rc.refund_amount > 0
      ), '[]'::jsonb);
    return;
  end if;

  if found and v_main.status = 'cancelled' and not p_allow_cancelled then
    return query select
      v_main.status,
      v_main.eligible_at,
      v_main.amount,
      coalesce(v_main.gross_amount, v_main.amount),
      coalesce(v_main.withheld_commission, 0),
      coalesce(v_main.commission_rate_bps, 0),
      coalesce(v_main.refund_policy_version, 'legacy-full-refund'),
      '[]'::jsonb;
    return;
  end if;

  if v_was_unquoted then
    null;
  elsif found and (
    v_main.amount <> p_main_amount
    or v_main.gross_amount <> p_main_gross_amount
    or v_main.withheld_commission <> p_main_withheld
  ) then
    raise exception 'A different refund quote already exists for payment %', p_pay_id
      using errcode = 'P0001';
  elsif not found then
    insert into public.maib_refunds (
      pay_id, booking_group_id, amount, gross_amount, withheld_commission,
      commission_rate_bps, refund_policy_version, currency, status, reason,
      request_payload, eligible_at
    ) values (
      p_pay_id, p_booking_group_id, p_main_amount, p_main_gross_amount,
      p_main_withheld, p_main_rate_bps, p_main_policy_version,
      coalesce(p_currency, 'MDL'), 'requested', p_reason,
      jsonb_build_object(
        'gross', p_main_gross_amount,
        'amount', p_main_amount,
        'withheld', p_main_withheld,
        'rateBps', p_main_rate_bps,
        'version', p_main_policy_version,
        'reason', p_reason,
        'source', p_source,
        'scheduled', p_eligible_at is not null
      ),
      p_eligible_at
    )
    returning * into v_main;
  else
    update public.maib_refunds set
      status = case when status = 'processing' then 'processing' else 'requested' end,
      reason = p_reason,
      request_payload = jsonb_build_object(
        'gross', gross_amount,
        'amount', amount,
        'withheld', withheld_commission,
        'rateBps', commission_rate_bps,
        'version', refund_policy_version,
        'reason', p_reason,
        'source', p_source,
        'scheduled', coalesce(eligible_at, p_eligible_at) is not null
      ),
      eligible_at = coalesce(eligible_at, p_eligible_at),
      error_message = case when status = 'cancelled' then null else error_message end,
      updated_at = now()
    where pay_id = p_pay_id
    returning * into v_main;
    v_effective_rate := v_main.commission_rate_bps;
    v_effective_version := v_main.refund_policy_version;
  end if;

  -- Lock the exact executor set before validating or writing any member. Any
  -- mismatch raises inside this transaction, rolling back the main intent and
  -- every difference stamp together.
  perform rc.id
  from public.reservation_changes rc
  where rc.booking_group_id = p_booking_group_id
    and rc.status = 'paid'
    and rc.refunded_at is null
    and rc.difference_amount > 0
  for update;

  if exists (
    select 1
    from public.reservation_changes rc
    where rc.booking_group_id = p_booking_group_id
      and rc.status = 'paid'
      and rc.refunded_at is null
      and rc.difference_amount > 0
      and rc.refund_amount is not null
      and (
        rc.refund_amount <>
          ((rc.difference_amount::bigint * (10000 - v_effective_rate) + 9999) / 10000)::integer
        or rc.refund_withheld <> rc.difference_amount - rc.refund_amount
      )
  ) then
    raise exception 'A different refund quote already exists for a difference payment'
      using errcode = 'P0001';
  end if;

  update public.reservation_changes rc set
    refund_amount =
      ((rc.difference_amount::bigint * (10000 - v_effective_rate) + 9999) / 10000)::integer,
    refund_withheld = rc.difference_amount -
      ((rc.difference_amount::bigint * (10000 - v_effective_rate) + 9999) / 10000)::integer,
    refund_rate_bps = v_effective_rate,
    refund_policy_version = v_effective_version,
    updated_at = now()
  where rc.booking_group_id = p_booking_group_id
    and rc.status = 'paid'
    and rc.refunded_at is null
    and rc.difference_amount > 0
    and rc.refund_amount is null;

  return query
  select
    v_main.status,
    v_main.eligible_at,
    v_main.amount,
    coalesce(v_main.gross_amount, v_main.amount),
    coalesce(v_main.withheld_commission, 0),
    coalesce(v_main.commission_rate_bps, 0),
    coalesce(v_main.refund_policy_version, 'legacy-full-refund'),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'changeId', rc.id,
        'gross', rc.difference_amount,
        'net', rc.refund_amount,
        'withheld', rc.refund_withheld,
        'rateBps', rc.refund_rate_bps,
        'version', rc.refund_policy_version
      ) order by rc.id)
      from public.reservation_changes rc
      where rc.booking_group_id = p_booking_group_id
        and rc.status = 'paid'
        and rc.refunded_at is null
        and rc.difference_amount > 0
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.prepare_full_refund_intent(
  text, uuid, integer, integer, integer, integer, text, text, text, text,
  timestamptz, boolean
) from public, anon, authenticated;
grant execute on function public.prepare_full_refund_intent(
  text, uuid, integer, integer, integer, integer, text, text, text, text,
  timestamptz, boolean
) to service_role;
