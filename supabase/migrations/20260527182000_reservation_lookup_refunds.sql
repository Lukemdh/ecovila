set search_path = public, extensions;

create table if not exists public.reservation_lookup_codes (
  id uuid primary key default gen_random_uuid(),
  phone text not null check (phone ~ '^\+[0-9]{8,15}$'),
  code_hash text not null,
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 6),
  expires_at timestamptz not null,
  verified_at timestamptz,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists reservation_lookup_codes_phone_created_at_idx
  on public.reservation_lookup_codes (phone, created_at desc);

create index if not exists reservation_lookup_codes_expires_at_idx
  on public.reservation_lookup_codes (expires_at);

alter table public.reservation_lookup_codes enable row level security;

create table if not exists public.reservation_manage_tokens (
  token_hash text primary key,
  phone text not null check (phone ~ '^\+[0-9]{8,15}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists reservation_manage_tokens_phone_idx
  on public.reservation_manage_tokens (phone);

create index if not exists reservation_manage_tokens_expires_at_idx
  on public.reservation_manage_tokens (expires_at);

alter table public.reservation_manage_tokens enable row level security;

create table if not exists public.maib_refunds (
  id uuid primary key default gen_random_uuid(),
  pay_id text not null references public.maib_payments(pay_id) on delete cascade,
  booking_group_id uuid not null,
  amount integer not null check (amount > 0),
  currency text not null default 'MDL' check (currency = 'MDL'),
  status text not null default 'requested' check (status in ('requested', 'succeeded', 'failed')),
  reason text not null,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  provider_refund_id text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pay_id)
);

create index if not exists maib_refunds_booking_group_id_idx
  on public.maib_refunds (booking_group_id);

alter table public.maib_refunds enable row level security;
