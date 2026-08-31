-- ONE-OFF pacing schedule for the B-39 catch-up. DELETE THIS JOB WITH THE FUNCTION.
--
-- 144 guests were missed while ADR-082's review email was broken. The first 36 were
-- sent by hand on 2026-08-31, leaving 108 — three more runs of 36, plus one spare day
-- in case a run fails.
--
-- The day-of-month range is deliberate: `1-4` in month `9` fires on 1, 2, 3 and 4
-- September and then never again this year. An open-ended daily job would keep
-- calling a function whose work is finished, and would outlive everyone's memory of
-- why it exists. If a run fails, the next day picks up the same backlog — the
-- function records an event only after a successful send, so nobody is skipped and
-- nobody is asked twice.
--
-- The 4th run is expected to be a no-op returning {"sent":0}. That is the intended
-- end state, not a fault.
--
-- 10:00 UTC = 13:00 Europe/Chisinau in September. It deliberately does not share a
-- window with `ecovila-review-requests` (15:00-16:59 UTC). The two cannot double-send
-- in any case: both key their dedup on the booking group's stable owner id, so
-- whichever runs first makes the other skip.
select cron.schedule(
  'ecovila-review-backfill',
  '0 10 1-4 9 *',
  $cron$
    select net.http_post(
      url      := 'https://mckchrviaawdxtsfytut.supabase.co/functions/v1/backfill-review-requests',
      headers  := jsonb_build_object(
        'Content-Type',    'application/json',
        'x-ecovila-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'ecovila_cron_secret'
          limit 1
        )
      ),
      body     := '{"mode":"send","limit":36}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cron$
);
