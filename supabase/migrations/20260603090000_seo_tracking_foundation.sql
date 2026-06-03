alter table public.reservations
  add column if not exists tracking_event_id text,
  add column if not exists tracking_fbp text,
  add column if not exists tracking_fbc text,
  add column if not exists tracking_user_agent text,
  add column if not exists tracking_source_url text;

create index if not exists reservations_tracking_event_id_idx
  on public.reservations (tracking_event_id)
  where tracking_event_id is not null;

create table if not exists public.tracking_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null,
  event_id text not null,
  booking_group_id uuid,
  source text not null,
  provider_results jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint tracking_events_event_name_check check (
    event_name in (
      'PageView',
      'ViewContent',
      'Search',
      'InitiateCheckout',
      'AddPaymentInfo',
      'Purchase',
      'Lead'
    )
  ),
  constraint tracking_events_event_id_not_blank check (length(btrim(event_id)) > 0),
  unique (event_name, event_id)
);

create index if not exists tracking_events_booking_group_id_idx
  on public.tracking_events (booking_group_id);

alter table public.tracking_events enable row level security;

grant select, insert, update, delete on public.tracking_events to authenticated;

drop policy if exists "Diana can manage tracking events" on public.tracking_events;
create policy "Diana can manage tracking events"
on public.tracking_events
for all
to authenticated
using (public.ecovila_app_role() = 'diana')
with check (public.ecovila_app_role() = 'diana');
