-- Post-stay review-request email (ADR-082): the evening after a guest checks out,
-- if staff left no checkout note in situația zilnică, nudge the guest for a Google
-- review. The dedicated send-review-requests function gates itself to the
-- [18:30, 19:00) Europe/Chisinau window, so a per-minute trigger fires the batch on
-- the first tick past 18:30 and retries any transient failure on the next ticks;
-- notification_events (event_type = 'review_request') keeps it exactly-once per guest.
--
-- The cron runs every minute only during UTC 15:00–16:59, which brackets 18:30 local
-- year-round (15:30 UTC in EEST / 16:30 UTC in EET) without a DST-specific expression;
-- the local-time gate lives in the function, not the cron. Outside the window the
-- function returns early before any DB work.
select cron.schedule(
  'ecovila-review-requests',
  '* 15-16 * * *',
  $cron$
    select net.http_post(
      url      := 'https://mckchrviaawdxtsfytut.supabase.co/functions/v1/send-review-requests',
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
