create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

set search_path = public, extensions;

create or replace function public.ecovila_app_role()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
$$;

comment on function public.ecovila_app_role() is
  'Reads auth.jwt().app_metadata.role. Set Diana to role=diana and Angela to role=angela in raw_app_meta_data.';

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  number integer not null unique,
  type text not null,
  is_active boolean not null default true,
  constraint rooms_type_check check (type in ('small', 'large', 'hotel')),
  constraint rooms_number_check check (number between 1 and 25)
);

create table if not exists public.pricing_tiers (
  id uuid primary key default gen_random_uuid(),
  nights_tier integer not null,
  day_type text not null,
  adult_price integer not null,
  kid_price integer not null,
  effective_from date not null,
  created_at timestamptz not null default now(),
  constraint pricing_tiers_nights_tier_check check (nights_tier in (1, 2, 3)),
  constraint pricing_tiers_day_type_check check (day_type in ('weekday', 'holiday')),
  constraint pricing_tiers_adult_price_check check (adult_price >= 0),
  constraint pricing_tiers_kid_price_check check (kid_price >= 0),
  constraint pricing_tiers_effective_unique unique (nights_tier, day_type, effective_from)
);

create table if not exists public.holidays (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  label text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.rooms(id),
  guest_first_name text not null,
  guest_last_name text not null,
  guest_phone text not null,
  guest_email text not null,
  check_in date not null,
  check_out date not null,
  adults integer not null,
  kids_ages integer[] not null default '{}'::integer[],
  total_price integer not null,
  payment_type text not null,
  payment_status text not null,
  room_explicitly_selected boolean not null default false,
  conference_room boolean not null default false,
  notes text,
  cash_expires_at timestamptz,
  cash_extended boolean not null default false,
  created_by text not null default 'guest',
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancellation_reason text,
  constraint reservations_guest_phone_check check (guest_phone ~ '^\+373[0-9]{8}$'),
  constraint reservations_guest_email_check check (position('@' in guest_email) > 1),
  constraint reservations_check_out_after_check_in check (check_out > check_in),
  constraint reservations_adults_check check (adults >= 0),
  constraint reservations_total_price_check check (total_price >= 0),
  constraint reservations_payment_type_check check (payment_type in ('cash', 'card')),
  constraint reservations_payment_status_check check (payment_status in ('pending', 'paid', 'cancelled')),
  constraint reservations_created_by_check check (created_by in ('guest', 'diana')),
  constraint reservations_cancelled_state_check check (
    (payment_status = 'cancelled' and cancelled_at is not null)
    or (payment_status <> 'cancelled' and cancelled_at is null and cancellation_reason is null)
  ),
  constraint reservations_no_room_overlap exclude using gist (
    room_id with =,
    daterange(check_in, check_out, '[)') with &&
  )
  where (room_id is not null and payment_status in ('pending', 'paid') and cancelled_at is null)
);

create table if not exists public.cancellation_tokens (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(32), 'hex'),
  used boolean not null default false,
  created_at timestamptz not null default now(),
  constraint cancellation_tokens_token_length_check check (length(token) >= 32)
);

create index if not exists rooms_type_active_number_idx
  on public.rooms (type, is_active, number);

create index if not exists pricing_tiers_lookup_idx
  on public.pricing_tiers (effective_from desc, nights_tier, day_type);

create index if not exists holidays_date_idx
  on public.holidays (date);

create index if not exists reservations_room_dates_idx
  on public.reservations (room_id, check_in, check_out)
  where cancelled_at is null;

create index if not exists reservations_payment_status_idx
  on public.reservations (payment_status, cash_expires_at);

create index if not exists reservations_guest_search_idx
  on public.reservations (guest_last_name, guest_first_name, guest_phone);

create index if not exists cancellation_tokens_reservation_id_idx
  on public.cancellation_tokens (reservation_id);

create or replace function public.get_reservation_by_cancellation_token(lookup_token text)
returns table (
  reservation_id uuid,
  room_id uuid,
  room_number integer,
  room_type text,
  guest_first_name text,
  guest_last_name text,
  check_in date,
  check_out date,
  adults integer,
  kids_ages integer[],
  total_price integer,
  payment_type text,
  payment_status text,
  room_explicitly_selected boolean,
  conference_room boolean,
  created_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    r.id as reservation_id,
    r.room_id,
    rooms.number as room_number,
    rooms.type as room_type,
    r.guest_first_name,
    r.guest_last_name,
    r.check_in,
    r.check_out,
    r.adults,
    r.kids_ages,
    r.total_price,
    r.payment_type,
    r.payment_status,
    r.room_explicitly_selected,
    r.conference_room,
    r.created_at,
    r.cancelled_at,
    r.cancellation_reason
  from public.cancellation_tokens tokens
  join public.reservations r on r.id = tokens.reservation_id
  left join public.rooms on rooms.id = r.room_id
  where lookup_token is not null
    and lookup_token <> ''
    and tokens.token = lookup_token
    and tokens.used = false
  limit 1;
$$;

revoke all on function public.ecovila_app_role() from public;
grant execute on function public.ecovila_app_role() to anon, authenticated;

revoke all on function public.get_reservation_by_cancellation_token(text) from public;
grant execute on function public.get_reservation_by_cancellation_token(text) to anon, authenticated;

alter table public.rooms enable row level security;
alter table public.pricing_tiers enable row level security;
alter table public.holidays enable row level security;
alter table public.reservations enable row level security;
alter table public.cancellation_tokens enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.rooms, public.pricing_tiers, public.holidays to anon, authenticated;
grant insert on public.reservations to anon, authenticated;
grant select, insert, update, delete on
  public.rooms,
  public.pricing_tiers,
  public.holidays,
  public.reservations,
  public.cancellation_tokens
to authenticated;

drop policy if exists "Public can read rooms" on public.rooms;
create policy "Public can read rooms"
on public.rooms
for select
to anon, authenticated
using (is_active = true);

drop policy if exists "Diana can manage rooms" on public.rooms;
create policy "Diana can manage rooms"
on public.rooms
for all
to authenticated
using (public.ecovila_app_role() = 'diana')
with check (public.ecovila_app_role() = 'diana');

drop policy if exists "Angela can read rooms" on public.rooms;
create policy "Angela can read rooms"
on public.rooms
for select
to authenticated
using (public.ecovila_app_role() = 'angela');

drop policy if exists "Public can read pricing_tiers" on public.pricing_tiers;
create policy "Public can read pricing_tiers"
on public.pricing_tiers
for select
to anon, authenticated
using (true);

drop policy if exists "Diana can manage pricing_tiers" on public.pricing_tiers;
create policy "Diana can manage pricing_tiers"
on public.pricing_tiers
for all
to authenticated
using (public.ecovila_app_role() = 'diana')
with check (public.ecovila_app_role() = 'diana');

drop policy if exists "Angela can read pricing_tiers" on public.pricing_tiers;
create policy "Angela can read pricing_tiers"
on public.pricing_tiers
for select
to authenticated
using (public.ecovila_app_role() = 'angela');

drop policy if exists "Public can read holidays" on public.holidays;
create policy "Public can read holidays"
on public.holidays
for select
to anon, authenticated
using (true);

drop policy if exists "Diana can manage holidays" on public.holidays;
create policy "Diana can manage holidays"
on public.holidays
for all
to authenticated
using (public.ecovila_app_role() = 'diana')
with check (public.ecovila_app_role() = 'diana');

drop policy if exists "Angela can read holidays" on public.holidays;
create policy "Angela can read holidays"
on public.holidays
for select
to authenticated
using (public.ecovila_app_role() = 'angela');

drop policy if exists "Public can create guest reservations" on public.reservations;
create policy "Public can create guest reservations"
on public.reservations
for insert
to anon, authenticated
with check (
  created_by = 'guest'
  and payment_status = 'pending'
  and payment_type in ('cash', 'card')
  and adults >= 1
  and room_id is not null
  and conference_room = false
  and notes is null
  and cancelled_at is null
  and cancellation_reason is null
);

drop policy if exists "Diana can manage reservations" on public.reservations;
create policy "Diana can manage reservations"
on public.reservations
for all
to authenticated
using (public.ecovila_app_role() = 'diana')
with check (public.ecovila_app_role() = 'diana');

drop policy if exists "Angela can read reservations" on public.reservations;
create policy "Angela can read reservations"
on public.reservations
for select
to authenticated
using (public.ecovila_app_role() = 'angela');

drop policy if exists "Diana can manage cancellation_tokens" on public.cancellation_tokens;
create policy "Diana can manage cancellation_tokens"
on public.cancellation_tokens
for all
to authenticated
using (public.ecovila_app_role() = 'diana')
with check (public.ecovila_app_role() = 'diana');

drop policy if exists "Angela can read cancellation_tokens" on public.cancellation_tokens;
create policy "Angela can read cancellation_tokens"
on public.cancellation_tokens
for select
to authenticated
using (public.ecovila_app_role() = 'angela');

insert into public.rooms (number, type)
values
  (1, 'small'),
  (2, 'small'),
  (3, 'small'),
  (4, 'small'),
  (5, 'small'),
  (6, 'small'),
  (7, 'small'),
  (8, 'small'),
  (9, 'large'),
  (10, 'large'),
  (11, 'large'),
  (12, 'large'),
  (13, 'large'),
  (14, 'large'),
  (15, 'large'),
  (16, 'hotel'),
  (17, 'hotel'),
  (18, 'hotel'),
  (19, 'hotel'),
  (20, 'hotel'),
  (21, 'hotel'),
  (22, 'hotel'),
  (23, 'hotel'),
  (24, 'hotel'),
  (25, 'hotel')
on conflict (number) do update
set
  type = excluded.type,
  is_active = true;

insert into public.pricing_tiers (
  nights_tier,
  day_type,
  adult_price,
  kid_price,
  effective_from
)
values
  (1, 'weekday', 1100, 900, date '2026-05-06'),
  (1, 'holiday', 1300, 1000, date '2026-05-06'),
  (2, 'weekday', 1000, 800, date '2026-05-06'),
  (2, 'holiday', 1200, 900, date '2026-05-06'),
  (3, 'weekday', 900, 700, date '2026-05-06'),
  (3, 'holiday', 1100, 800, date '2026-05-06')
on conflict (nights_tier, day_type, effective_from) do update
set
  adult_price = excluded.adult_price,
  kid_price = excluded.kid_price;
