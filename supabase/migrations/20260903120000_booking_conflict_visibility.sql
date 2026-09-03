set search_path = public, extensions;

-- The live definition was read with pg_get_functiondef on 2026-09-03 and compared against
-- 20260507090000_booking_public_availability.sql: no drift, the bodies are identical. This
-- statement therefore changes exactly one thing — the added ORDER BY.
--
-- The ordering is not cosmetic. js/supabase.js now pages this RPC with unwrapAllSupabaseRows,
-- and paging without a deterministic total ordering can skip or repeat a row across a page
-- boundary. Reading the LIVE definition before recreating an object is the B-39 lesson
-- (docs/bugs.md): that outage happened because a CHECK was recreated from a stale assumption.
create or replace function public.get_public_availability_blocks(range_start date, range_end date)
returns table (
  room_id uuid,
  check_in date,
  check_out date
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    reservations.room_id,
    reservations.check_in,
    reservations.check_out
  from public.reservations
  where range_start is not null
    and range_end is not null
    and range_end > range_start
    and reservations.room_id is not null
    and reservations.payment_status in ('pending', 'paid')
    and reservations.cancelled_at is null
    and daterange(reservations.check_in, reservations.check_out, '[)')
      && daterange(range_start, range_end, '[)')
  order by reservations.room_id, reservations.check_in;
$$;

revoke all on function public.get_public_availability_blocks(date, date) from public;
grant execute on function public.get_public_availability_blocks(date, date) to anon, authenticated;

create table public.booking_failures (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  reason text not null check (reason in ('rooms_unavailable', 'invalid_request', 'rate_limited', 'server_error')),
  sqlstate text,
  room_type text,
  check_in date,
  check_out date,
  units integer,
  room_explicitly_selected boolean,
  guest_language text,
  detail text
);

create index booking_failures_created_at_idx
  on public.booking_failures (created_at desc);

alter table public.booking_failures enable row level security;

revoke all on table public.booking_failures from anon, authenticated, public;
grant select on table public.booking_failures to authenticated;
grant all on table public.booking_failures to service_role;

create policy "Diana can read booking failures"
  on public.booking_failures
  for select
  to authenticated
  using (public.ecovila_app_role() = 'diana');

create policy "Angela can read booking failures"
  on public.booking_failures
  for select
  to authenticated
  using (public.ecovila_app_role() = 'angela');
