set search_path = public, extensions;

alter table public.notification_events
  add column if not exists delivery_status text not null default 'sent',
  add column if not exists attempt_count integer not null default 1,
  add column if not exists attempted_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists last_error text,
  add column if not exists provider_response jsonb not null default '{}'::jsonb;

alter table public.notification_events
  drop constraint if exists notification_events_delivery_status_check,
  drop constraint if exists notification_events_attempt_count_check;

alter table public.notification_events
  add constraint notification_events_delivery_status_check
  check (delivery_status in ('reserved', 'sent', 'failed', 'abandoned')),
  add constraint notification_events_attempt_count_check
  check (attempt_count between 1 and 3);

update public.notification_events
set
  delivery_status = coalesce(delivery_status, 'sent'),
  attempt_count = coalesce(attempt_count, 1),
  attempted_at = coalesce(attempted_at, sent_at),
  completed_at = coalesce(completed_at, sent_at)
where delivery_status is null
   or attempt_count is null
   or attempted_at is null
   or completed_at is null;

alter table public.notification_events
  alter column sent_at drop default,
  alter column sent_at drop not null;
