create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

-- The function is shared-secret gated and notification_events provides dedup.
-- Run every minute so new bookings with guest flags reach staff promptly.
select cron.schedule(
  'ecovila-guest-flag-alerts',
  '* * * * *',
  $cron$
    select net.http_post(
      url      := 'https://mckchrviaawdxtsfytut.supabase.co/functions/v1/send-guest-flag-alerts',
      headers  := jsonb_build_object(
        'Content-Type',    'application/json',
        'x-ecovila-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'ecovila_cron_secret'
          limit 1
        )
      ),
      body     := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $cron$
);
