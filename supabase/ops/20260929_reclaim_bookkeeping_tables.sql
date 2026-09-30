-- One-off runbook for reclaiming bloated bookkeeping tables.
-- NOT a migration. Do NOT run via supabase db push.
--
-- Run each step or block independently via:
--   supabase db query --linked "<sql>"
--
-- Note: supabase db query --linked prints only the LAST result set of a
-- multi-statement string. Therefore, all read-only inspection and verification
-- queries are separated into their own numbered steps (0a, 0b, 0c, 0d, 0e, 3a, 3b, 3c, 4a, 4b),
-- each a single statement with no begin/commit wrapper.
-- Reclaim operations (Block 1 and Block 2) are each enclosed in their own
-- transaction with explicit lock_timeout guards.
-- No TRUNCATE statement uses RESTART IDENTITY so ID sequences are preserved.
--
-- Operating Rules:
-- 1. Run at a quiet hour (03:00–05:00 Europe/Chisinau).
-- 2. Before truncating, first run read-only Step 0e that lists any pending cash
--    reservations or temporary holds expiring within the next 15 minutes
--    (reservations where payment_status = 'pending' and cancelled_at is null and
--    cash_expires_at between now() and now() + interval '15 minutes').
--    If any exist, wait until they expire or are confirmed.
-- 3. Run read-only preflight Step 0d to count responses older than 7 hours.
--    Note: Step 0d may take up to ~2 minutes because it walks the bloated heap.
--    If it returns > 0, STOP: list those rows' failures (same failure predicate
--    as Step 0c, without the 7-hour bound) for the owner to decide before truncating.
-- 4. Verify Block 1 succeeded (re-run Step 3a size check) BEFORE running Block 2.
-- 5. On a lock/statement timeout: the transaction is already rolled back (each
--    `supabase db query` call is its own session); inspect blockers with the
--    provided read-only query on pg_stat_activity/pg_locks for relation
--    'net._http_response'::regclass:
--
--      select
--        a.pid,
--        a.usename,
--        a.state,
--        now() - a.query_start as query_duration,
--        a.wait_event_type,
--        a.wait_event,
--        l.mode as lock_mode,
--        l.granted,
--        a.query
--      from pg_stat_activity a
--      join pg_locks l on l.pid = a.pid
--      where l.relation = 'net._http_response'::regclass;
--
--    Retry only once the blocker is understood.

-- =============================================================================
-- Step 0a (report, read-only):
-- Sizes of both bookkeeping tables (total, heap, indexes).
-- =============================================================================
select
  c.relname,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
  pg_size_pretty(pg_relation_size(c.oid)) as heap_size,
  pg_size_pretty(pg_indexes_size(c.oid)) as index_size
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where (n.nspname = 'net' and c.relname = '_http_response')
   or (n.nspname = 'cron' and c.relname = 'job_run_details')
order by c.relname;

-- =============================================================================
-- Step 0b (report, read-only):
-- Status code breakdown and time range of live pg_net responses.
-- Returns one row per status code grouped by status_code.
-- =============================================================================
select
  status_code,
  count(*),
  min(created),
  max(created)
from net._http_response
where created > now() - interval '7 hours'
group by status_code
order by status_code;

-- =============================================================================
-- Step 0c (report, read-only):
-- Full list of failed, error, timed out, or unusual responses (to review before truncating).
-- =============================================================================
select
  id,
  status_code,
  error_msg,
  timed_out,
  created
from net._http_response
where created > now() - interval '7 hours'
  and (
    status_code is null
    or status_code >= 300
    or timed_out
    or error_msg is not null
  )
order by created desc;

-- =============================================================================
-- Step 0d (preflight, read-only):
-- Count pg_net responses older than 7 hours.
-- Note: may take up to ~2 minutes because it walks the bloated heap.
-- If it returns > 0, STOP: list those rows' failures (same failure predicate
-- as Step 0c, without the 7-hour bound) for the owner to decide before truncating:
--
-- select
--   id,
--   status_code,
--   error_msg,
--   timed_out,
--   created
-- from net._http_response
-- where status_code is null
--    or status_code >= 300
--    or timed_out
--    or error_msg is not null
-- order by created desc;
-- =============================================================================
select count(*)
from net._http_response
where created <= now() - interval '7 hours';

-- =============================================================================
-- Step 0e (preflight, read-only):
-- List pending cash reservations or temporary holds expiring within the next 15 minutes.
-- If any exist, WAIT until they expire or are confirmed before truncating.
-- =============================================================================
select
  id,
  payment_status,
  cash_expires_at,
  created_at
from public.reservations
where payment_status = 'pending'
  and cancelled_at is null
  and cash_expires_at between now() and now() + interval '15 minutes'
order by cash_expires_at asc;

-- =============================================================================
-- Block 1:
-- Truncate net._http_response.
-- Full lock effect: while TRUNCATE waits for its ACCESS EXCLUSIVE lock, pg_net's
-- worker is also blocked, so the per-minute cron HTTP calls (expire-cash,
-- send-reminders, guest-flag-alerts) can be delayed by up to ~2 minutes.
-- Waits for pg_net's running cleanup (which holds RowExclusiveLock for ~80s) at most once.
-- Lock timeout is set to 110s and statement_timeout to 115s because production's
-- server-side statement_timeout is 120s and includes lock waiting, so 150s can never
-- be reached. If it times out, the transaction is already rolled back (each
-- `supabase db query` call is its own session); inspect blockers with the
-- provided read-only query on pg_stat_activity/pg_locks for relation
-- 'net._http_response'::regclass, and retry only once the blocker is understood.
-- If it times out because pg_net's cleanup was mid-run — simply run the block again.
-- RESTART IDENTITY is omitted so response IDs are never reused.
-- Verify Block 1 succeeded (re-run Step 3a size check) BEFORE running Block 2.
-- =============================================================================
begin;
set local lock_timeout = '110s';
set local statement_timeout = '115s';
truncate net._http_response;
commit;

-- =============================================================================
-- Block 2:
-- Truncate cron.job_run_details.
-- Recommended execution time: ~:30s past a minute, between per-minute cron job starts.
-- RESTART IDENTITY is omitted.
-- =============================================================================
begin;
set local lock_timeout = '10s';
truncate cron.job_run_details;
commit;

-- =============================================================================
-- Step 3a (verify, read-only):
-- Table sizes after truncation.
-- =============================================================================
select
  c.relname,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
  pg_size_pretty(pg_relation_size(c.oid)) as heap_size,
  pg_size_pretty(pg_indexes_size(c.oid)) as index_size
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where (n.nspname = 'net' and c.relname = '_http_response')
   or (n.nspname = 'cron' and c.relname = 'job_run_details')
order by c.relname;

-- =============================================================================
-- Step 3b (verify, read-only):
-- Verify cron logging (rows will appear after the next minute's cron executions).
-- =============================================================================
select
  jobid,
  runid,
  job_pid,
  database,
  username,
  command,
  status,
  return_message,
  start_time,
  end_time
from cron.job_run_details
order by start_time desc
limit 10;

-- =============================================================================
-- Step 3c (verify, read-only):
-- Confirm pg_net is writing fresh responses after the truncate.
-- =============================================================================
select
  count(*),
  max(created)
from net._http_response
where created > now() - interval '10 minutes';

-- =============================================================================
-- Step 4 — after applying 20260929120000_bookkeeping_table_maintenance.sql:
-- =============================================================================

-- =============================================================================
-- Step 4a (verify, read-only):
-- List the four maintenance-related jobs from cron.job.
-- The three new ones present and active; ecovila-review-backfill absent.
-- =============================================================================
select
  jobid,
  jobname,
  schedule,
  active,
  command
from cron.job
where jobname in (
  'ecovila-review-backfill',
  'ecovila-prune-cron-history',
  'ecovila-vacuum-cron-history',
  'ecovila-vacuum-pgnet-responses'
)
order by jobname;

-- =============================================================================
-- Step 4b (verify, read-only):
-- After the first scheduled runs, verify maintenance execution history.
-- Every run must be 'succeeded'.
-- =============================================================================
select
  j.jobname,
  d.status,
  d.return_message,
  d.start_time
from cron.job_run_details d
join cron.job j using (jobid)
where j.jobname in (
  'ecovila-prune-cron-history',
  'ecovila-vacuum-cron-history',
  'ecovila-vacuum-pgnet-responses'
)
order by d.start_time desc
limit 10;
