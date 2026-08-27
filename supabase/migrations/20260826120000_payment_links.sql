-- ADR-106: standalone, single-use payment links. These tables and RPCs are
-- intentionally independent from reservations and reservation settlement.

create table public.payment_links (
  id uuid primary key default gen_random_uuid(),
  amount integer not null check (amount between 1 and 1000000),
  currency text not null default 'MDL' check (currency = 'MDL'),
  payment_rail text not null check (payment_rail in ('mia', 'card')),
  label text check (label is null or char_length(label) <= 120),
  status text not null default 'active' check (status in ('active', 'paid', 'revoked')),
  expires_at timestamptz,
  paid_at timestamptz,
  paid_amount integer,
  revoked_at timestamptz,
  settled_attempt_id uuid,
  refunded_at timestamptz,
  refunded_amount integer,
  refund_note text,
  manual_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'paid') = (paid_at is not null)),
  check (status <> 'revoked' or revoked_at is not null),
  check (
    (refunded_at is null and refunded_amount is null)
    or (
      refunded_at is not null
      and refunded_amount is not null
      and refunded_amount between 1 and paid_amount
      and status = 'paid'
    )
  )
);

create table public.payment_link_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_link_id uuid not null references public.payment_links(id) on delete restrict,
  amount integer not null,
  currency text not null default 'MDL',
  payment_rail text not null,
  pay_id text unique,
  provider_payment_id text unique,
  status text not null default 'creating'
    check (status in ('creating', 'pending', 'paid', 'failed', 'cancelled')),
  checkout_url text,
  provider_payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  processed_at timestamptz,
  manual_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payment_links
  add constraint payment_links_settled_attempt_id_fkey
  foreign key (settled_attempt_id)
  references public.payment_link_attempts(id)
  on delete restrict;

create unique index payment_link_attempts_one_live_idx
  on public.payment_link_attempts (payment_link_id)
  where status in ('creating', 'pending');

create index payment_link_attempts_link_created_idx
  on public.payment_link_attempts (payment_link_id, created_at desc);

alter table public.payment_links enable row level security;
alter table public.payment_link_attempts enable row level security;

grant select on public.payment_links, public.payment_link_attempts to authenticated;

create policy "Diana can read payment links"
  on public.payment_links
  for select
  to authenticated
  using (public.ecovila_app_role() = 'diana');

create policy "Diana can read payment link attempts"
  on public.payment_link_attempts
  for select
  to authenticated
  using (public.ecovila_app_role() = 'diana');

create or replace function public.claim_payment_link_attempt(
  p_link_id uuid,
  p_rail text,
  p_now timestamptz
)
returns table (
  attempt_id uuid,
  payment_link_id uuid,
  amount integer,
  currency text,
  payment_rail text,
  pay_id text,
  provider_payment_id text,
  status text,
  checkout_url text,
  provider_payload jsonb,
  expires_at timestamptz,
  processed_at timestamptz,
  manual_review boolean,
  created_at timestamptz,
  updated_at timestamptz,
  superseded_pay_id text,
  superseded_payment_rail text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_link public.payment_links%rowtype;
  v_live public.payment_link_attempts%rowtype;
  v_attempt public.payment_link_attempts%rowtype;
  v_superseded_pay_id text;
  v_superseded_rail text;
begin
  select l.*
    into v_link
  from public.payment_links l
  where l.id = p_link_id
  for update;

  if not found then
    raise exception 'Payment link not found' using errcode = 'P0002';
  end if;
  if v_link.status = 'paid' then
    raise exception 'Payment link is already paid' using errcode = 'P0001';
  end if;
  if v_link.status = 'revoked' then
    raise exception 'Payment link is revoked' using errcode = 'P0001';
  end if;
  if v_link.expires_at is not null and v_link.expires_at <= p_now then
    raise exception 'Payment link is expired' using errcode = 'P0001';
  end if;
  if p_rail is null or p_rail <> v_link.payment_rail then
    raise exception 'Payment rail does not match the payment link' using errcode = 'P0001';
  end if;

  select a.*
    into v_live
  from public.payment_link_attempts a
  where a.payment_link_id = v_link.id
    and a.status in ('creating', 'pending')
  limit 1
  for update;

  if v_live.id is not null then
    if
      (v_live.status = 'creating' and v_live.created_at <= p_now - interval '2 minutes')
      or (
        v_live.status = 'pending'
        and v_live.expires_at is not null
        and v_live.expires_at <= p_now
      )
    then
      v_superseded_pay_id := v_live.pay_id;
      v_superseded_rail := v_live.payment_rail;

      update public.payment_link_attempts a set
        status = 'cancelled',
        processed_at = coalesce(a.processed_at, p_now),
        updated_at = p_now
      where a.id = v_live.id
        and a.status in ('creating', 'pending');
    else
      raise exception 'A live payment-link attempt already exists' using errcode = 'P0001';
    end if;
  end if;

  insert into public.payment_link_attempts (
    payment_link_id,
    amount,
    currency,
    payment_rail,
    status,
    created_at,
    updated_at
  )
  values (
    v_link.id,
    v_link.amount,
    v_link.currency,
    v_link.payment_rail,
    'creating',
    p_now,
    p_now
  )
  returning * into v_attempt;

  return query select
    v_attempt.id,
    v_attempt.payment_link_id,
    v_attempt.amount,
    v_attempt.currency,
    v_attempt.payment_rail,
    v_attempt.pay_id,
    v_attempt.provider_payment_id,
    v_attempt.status,
    v_attempt.checkout_url,
    v_attempt.provider_payload,
    v_attempt.expires_at,
    v_attempt.processed_at,
    v_attempt.manual_review,
    v_attempt.created_at,
    v_attempt.updated_at,
    v_superseded_pay_id,
    v_superseded_rail;
end;
$$;

create or replace function public.settle_payment_link_attempt(
  p_attempt_id uuid,
  p_provider_payment_id text,
  p_provider_amount integer,
  p_provider_currency text,
  p_provider_payload jsonb,
  p_now timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_link_id uuid;
  v_link public.payment_links%rowtype;
  v_attempt public.payment_link_attempts%rowtype;
  v_alert boolean;
  v_cancel_pay_id text;
  v_cancel_rail text;
begin
  select a.payment_link_id
    into v_link_id
  from public.payment_link_attempts a
  where a.id = p_attempt_id;

  if v_link_id is null then
    raise exception 'Payment-link attempt not found' using errcode = 'P0002';
  end if;

  select l.*
    into v_link
  from public.payment_links l
  where l.id = v_link_id
  for update;

  if not found then
    raise exception 'Payment link not found for attempt' using errcode = 'P0002';
  end if;

  select a.*
    into v_attempt
  from public.payment_link_attempts a
  where a.id = p_attempt_id
    and a.payment_link_id = v_link.id
  for update;

  if not found or v_attempt.payment_link_id <> v_link.id then
    raise exception 'Payment-link attempt does not belong to the locked link'
      using errcode = 'P0002';
  end if;

  if
    v_link.status = 'paid'
    and v_link.settled_attempt_id is not distinct from v_attempt.id
  then
    update public.payment_link_attempts a set
      status = 'paid',
      provider_payment_id = coalesce(nullif(p_provider_payment_id, ''), a.provider_payment_id),
      provider_payload = coalesce(p_provider_payload, '{}'::jsonb),
      processed_at = coalesce(a.processed_at, p_now),
      updated_at = p_now
    where a.id = v_attempt.id;

    return pg_catalog.jsonb_build_object(
      'outcome', 'already',
      'linkId', v_link.id,
      'attemptId', v_attempt.id,
      'manualReview', v_link.manual_review or v_attempt.manual_review,
      'alert', false
    );
  end if;

  if
    p_provider_amount is null
    or p_provider_amount <> v_attempt.amount
    or p_provider_currency is null
    or p_provider_currency <> v_attempt.currency
  then
    v_alert := not (v_link.manual_review and v_attempt.manual_review);

    update public.payment_link_attempts a set
      provider_payment_id = coalesce(nullif(p_provider_payment_id, ''), a.provider_payment_id),
      provider_payload = coalesce(p_provider_payload, '{}'::jsonb),
      manual_review = true,
      updated_at = p_now
    where a.id = v_attempt.id;

    update public.payment_links l set
      manual_review = true,
      updated_at = p_now
    where l.id = v_link.id;

    return pg_catalog.jsonb_build_object(
      'outcome', 'amount_mismatch',
      'linkId', v_link.id,
      'attemptId', v_attempt.id,
      'expectedAmount', v_attempt.amount,
      'expectedCurrency', v_attempt.currency,
      'providerAmount', p_provider_amount,
      'providerCurrency', p_provider_currency,
      'manualReview', true,
      'alert', v_alert
    );
  end if;

  select a.pay_id, a.payment_rail
    into v_cancel_pay_id, v_cancel_rail
  from public.payment_link_attempts a
  where a.payment_link_id = v_link.id
    and a.id <> v_attempt.id
    and a.status in ('creating', 'pending')
  limit 1
  for update;

  update public.payment_link_attempts a set
    status = 'cancelled',
    processed_at = coalesce(a.processed_at, p_now),
    updated_at = p_now
  where a.payment_link_id = v_link.id
    and a.id <> v_attempt.id
    and a.status in ('creating', 'pending');

  if
    v_link.status = 'paid'
    and v_link.settled_attempt_id is distinct from v_attempt.id
  then
    v_alert := not (v_link.manual_review and v_attempt.manual_review);

    update public.payment_link_attempts a set
      status = 'paid',
      provider_payment_id = coalesce(nullif(p_provider_payment_id, ''), a.provider_payment_id),
      provider_payload = coalesce(p_provider_payload, '{}'::jsonb),
      processed_at = coalesce(a.processed_at, p_now),
      manual_review = true,
      updated_at = p_now
    where a.id = v_attempt.id;

    update public.payment_links l set
      manual_review = true,
      updated_at = p_now
    where l.id = v_link.id;

    return pg_catalog.jsonb_build_object(
      'outcome', 'duplicate_capture',
      'linkId', v_link.id,
      'attemptId', v_attempt.id,
      'settledAttemptId', v_link.settled_attempt_id,
      'manualReview', true,
      'alert', v_alert,
      'cancelPayId', v_cancel_pay_id,
      'cancelRail', v_cancel_rail
    );
  end if;

  if
    v_attempt.status in ('failed', 'cancelled')
    or v_link.status = 'revoked'
    or (v_link.expires_at is not null and v_link.expires_at <= p_now)
  then
    v_alert := not (v_link.manual_review and v_attempt.manual_review);

    update public.payment_link_attempts a set
      status = 'paid',
      provider_payment_id = coalesce(nullif(p_provider_payment_id, ''), a.provider_payment_id),
      provider_payload = coalesce(p_provider_payload, '{}'::jsonb),
      processed_at = coalesce(a.processed_at, p_now),
      manual_review = true,
      updated_at = p_now
    where a.id = v_attempt.id;

    update public.payment_links l set
      status = 'paid',
      paid_at = p_now,
      paid_amount = p_provider_amount,
      settled_attempt_id = v_attempt.id,
      manual_review = true,
      updated_at = p_now
    where l.id = v_link.id;

    return pg_catalog.jsonb_build_object(
      'outcome', 'late_capture',
      'linkId', v_link.id,
      'attemptId', v_attempt.id,
      'manualReview', true,
      'alert', v_alert,
      'cancelPayId', v_cancel_pay_id,
      'cancelRail', v_cancel_rail
    );
  end if;

  update public.payment_link_attempts a set
    status = 'paid',
    provider_payment_id = coalesce(nullif(p_provider_payment_id, ''), a.provider_payment_id),
    provider_payload = coalesce(p_provider_payload, '{}'::jsonb),
    processed_at = coalesce(a.processed_at, p_now),
    updated_at = p_now
  where a.id = v_attempt.id;

  update public.payment_links l set
    status = 'paid',
    paid_at = p_now,
    paid_amount = p_provider_amount,
    settled_attempt_id = v_attempt.id,
    updated_at = p_now
  where l.id = v_link.id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'settled',
    'linkId', v_link.id,
    'attemptId', v_attempt.id,
    'manualReview', false,
    'alert', false,
    'cancelPayId', v_cancel_pay_id,
    'cancelRail', v_cancel_rail
  );
end;
$$;

create or replace function public.revoke_payment_link(
  p_link_id uuid,
  p_now timestamptz
)
returns table (pay_id text, payment_rail text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_link public.payment_links%rowtype;
  v_live public.payment_link_attempts%rowtype;
begin
  select l.*
    into v_link
  from public.payment_links l
  where l.id = p_link_id
  for update;

  if not found then
    raise exception 'Payment link not found' using errcode = 'P0002';
  end if;
  if v_link.status = 'paid' then
    raise exception 'A paid payment link cannot be revoked' using errcode = 'P0001';
  end if;

  select a.*
    into v_live
  from public.payment_link_attempts a
  where a.payment_link_id = v_link.id
    and a.status in ('creating', 'pending')
  limit 1
  for update;

  if v_live.id is not null then
    update public.payment_link_attempts a set
      status = 'cancelled',
      processed_at = coalesce(a.processed_at, p_now),
      updated_at = p_now
    where a.id = v_live.id
      and a.status in ('creating', 'pending');
  end if;

  update public.payment_links l set
    status = 'revoked',
    revoked_at = coalesce(l.revoked_at, p_now),
    updated_at = p_now
  where l.id = v_link.id;

  return query select v_live.pay_id, v_live.payment_rail;
end;
$$;

create or replace function public.mark_payment_link_refunded(
  p_link_id uuid,
  p_amount integer,
  p_note text,
  p_now timestamptz
)
returns public.payment_links
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_link public.payment_links%rowtype;
begin
  select l.*
    into v_link
  from public.payment_links l
  where l.id = p_link_id
  for update;

  if not found then
    raise exception 'Payment link not found' using errcode = 'P0002';
  end if;
  if v_link.status <> 'paid' then
    raise exception 'Only a paid payment link can be marked refunded' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount < 1 then
    raise exception 'Refund amount must be a positive integer' using errcode = 'P0001';
  end if;
  if v_link.paid_amount is null or p_amount > v_link.paid_amount then
    raise exception 'Refund amount cannot exceed the paid amount' using errcode = 'P0001';
  end if;

  update public.payment_links l set
    refunded_at = p_now,
    refunded_amount = p_amount,
    refund_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
    updated_at = p_now
  where l.id = v_link.id
  returning l.* into v_link;

  return v_link;
end;
$$;

revoke execute on function public.claim_payment_link_attempt(uuid, text, timestamptz)
  from public;
grant execute on function public.claim_payment_link_attempt(uuid, text, timestamptz)
  to service_role;

revoke execute on function public.settle_payment_link_attempt(
  uuid, text, integer, text, jsonb, timestamptz
) from public;
grant execute on function public.settle_payment_link_attempt(
  uuid, text, integer, text, jsonb, timestamptz
) to service_role;

revoke execute on function public.revoke_payment_link(uuid, timestamptz)
  from public;
grant execute on function public.revoke_payment_link(uuid, timestamptz)
  to service_role;

revoke execute on function public.mark_payment_link_refunded(
  uuid, integer, text, timestamptz
) from public;
grant execute on function public.mark_payment_link_refunded(
  uuid, integer, text, timestamptz
) to service_role;
