set search_path = public, extensions;

alter table public.notification_events
  add column if not exists delivery_status text not null default 'sent',
  add column if not exists attempted_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists last_error text,
  add column if not exists provider_response jsonb not null default '{}'::jsonb;

alter table public.notification_events
  drop constraint if exists notification_events_delivery_status_check;

alter table public.notification_events
  add constraint notification_events_delivery_status_check
  check (delivery_status in ('reserved', 'sent', 'failed'));

update public.notification_events
set
  delivery_status = coalesce(delivery_status, 'sent'),
  attempted_at = coalesce(attempted_at, sent_at),
  completed_at = coalesce(completed_at, sent_at)
where delivery_status is null
   or attempted_at is null
   or completed_at is null;

alter table public.notification_events
  alter column sent_at drop default,
  alter column sent_at drop not null;
