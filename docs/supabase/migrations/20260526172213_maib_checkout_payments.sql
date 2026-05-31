set search_path = public, extensions;

alter table public.reservations
  add column if not exists payment_in_progress boolean not null default false,
  add column if not exists payment_session_expires_at timestamptz;

create index if not exists reservations_payment_in_progress_idx
  on public.reservations (payment_in_progress, payment_session_expires_at)
  where payment_status = 'pending'
    and payment_type = 'card'
    and cancelled_at is null;

create table if not exists public.maib_payments (
  pay_id text primary key,
  provider_payment_id text unique,
  booking_group_id uuid not null,
  primary_reservation_id uuid references public.reservations(id) on delete set null,
  reservation_ids uuid[] not null default '{}'::uuid[],
  amount integer not null,
  currency text not null default 'MDL',
  payment_rail text not null,
  status text not null default 'created',
  checkout_url text not null,
  callback_payload jsonb not null default '{}'::jsonb,
  refund_payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  processed_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint maib_payments_amount_check check (amount >= 0),
  constraint maib_payments_currency_check check (currency = 'MDL'),
  constraint maib_payments_payment_rail_check check (payment_rail in ('mia', 'card')),
  constraint maib_payments_status_check check (
    status in ('created', 'pending', 'paid', 'failed', 'cancelled', 'refunded')
  )
);

create index if not exists maib_payments_booking_group_id_idx
  on public.maib_payments (booking_group_id);

create index if not exists maib_payments_expires_at_idx
  on public.maib_payments (expires_at)
  where status in ('created', 'pending');

alter table public.maib_payments enable row level security;
