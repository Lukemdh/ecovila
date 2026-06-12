-- Enable extensions
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

-- expire-cash-reservations: every minute
select cron.schedule(
  'ecovila-expire-cash',
  '* * * * *',
  $cron$
    select net.http_post(
      url      := 'https://mckchrviaawdxtsfytut.supabase.co/functions/v1/expire-cash-reservations',
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
      timeout_milliseconds := 10000
    );
  $cron$
);

-- send-reminders: daily at 07:00 UTC = 10:00 Chisinau (UTC+3)
select cron.schedule(
  'ecovila-send-reminders',
  '0 7 * * *',
  $cron$
    select net.http_post(
      url      := 'https://mckchrviaawdxtsfytut.supabase.co/functions/v1/send-reminders',
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
