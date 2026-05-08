set search_path = public, extensions;

alter table public.reservations
  add column if not exists booking_group_id uuid;

update public.reservations
set booking_group_id = id
where booking_group_id is null;

alter table public.reservations
  alter column booking_group_id set default gen_random_uuid(),
  alter column booking_group_id set not null;

create index if not exists reservations_booking_group_id_idx
  on public.reservations (booking_group_id);

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  event_type text not null,
  provider text not null default 'edge',
  sent_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint notification_events_event_type_check check (
    event_type in (
      'booking_confirmation',
      'payment_confirmation',
      'cash_expiry_warning',
      'cash_expired',
      'reservation_cancelled',
      'arrival_24h'
    )
  ),
  constraint notification_events_unique unique (reservation_id, event_type)
);

create index if not exists notification_events_reservation_id_idx
  on public.notification_events (reservation_id);

alter table public.notification_events enable row level security;

grant select, insert, update, delete on public.notification_events to authenticated;

drop policy if exists "Diana can manage notification_events" on public.notification_events;
create policy "Diana can manage notification_events"
on public.notification_events
for all
to authenticated
using (public.ecovila_app_role() = 'diana')
with check (public.ecovila_app_role() = 'diana');

drop policy if exists "Angela can read notification_events" on public.notification_events;
create policy "Angela can read notification_events"
on public.notification_events
for select
to authenticated
using (public.ecovila_app_role() = 'angela');
