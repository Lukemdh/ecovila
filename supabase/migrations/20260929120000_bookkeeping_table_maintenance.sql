-- Scheduled maintenance for pg_cron and pg_net bookkeeping tables.
--
-- Facts established on production:
-- Both cron.job_run_details (1.4 GB, ~740k rows) and net._http_response (290 MB heap,
-- ~1,050 live rows) have frozen pg_stat counters (n_ins_since_vacuum = 0) because their
-- background writers (pg_cron launcher since 2026-06-20, pg_net worker since 2026-08-05)
-- last started months ago without reporting stats, so autovacuum never runs on them.
-- pg_net's cleanup DELETE re-reads the entire 290 MB heap every ~77 s (~100% of data-disk
-- reads, ~68 ms per read).
--
-- pg_cron runs jobs over libpq as postgres (cron.use_background_workers = off), so a
-- scheduled plain VACUUM is supported. Scheduling an existing job name updates it
-- (idempotent under pg_cron 1.6 jobname_username_uniq).
--
-- This migration:
-- 1. Unschedules the completed 'ecovila-review-backfill' job so its 0 10 1-4 9 *
--    schedule does not fire again every September.
-- 2. Schedules daily pruning of cron.job_run_details at 03:17 UTC for runs older than 7 days
--    (coalescing end_time and start_time so interrupted runs with null end_time are pruned).
-- 3. Schedules daily vacuum (analyze) on cron.job_run_details at 03:27 UTC.
-- 4. Schedules hourly vacuum (analyze) on net._http_response at :07 past every hour.

select cron.unschedule('ecovila-review-backfill')
where exists (
  select 1 from cron.job where jobname = 'ecovila-review-backfill'
);

select cron.schedule(
  'ecovila-prune-cron-history',
  '17 3 * * *',
  $cron$
    delete from cron.job_run_details where coalesce(end_time, start_time) < now() - interval '7 days'
  $cron$
);

select cron.schedule(
  'ecovila-vacuum-cron-history',
  '27 3 * * *',
  $cron$
    vacuum (analyze) cron.job_run_details
  $cron$
);

select cron.schedule(
  'ecovila-vacuum-pgnet-responses',
  '7 * * * *',
  $cron$
    vacuum (analyze) net._http_response
  $cron$
);
