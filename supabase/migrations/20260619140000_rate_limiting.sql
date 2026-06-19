set search_path = public, extensions;

-- Site-wide rate limiting (ADR-060).
--
-- A single generic sliding-window store backs every public Edge Function. Each
-- protected call records one row keyed by (bucket, key) — e.g. an IP, a guest
-- phone, or a booking group id — and is allowed only while fewer than `limit`
-- rows exist inside the trailing window. The decision is taken inside
-- `rate_limit_hit` so the count + insert are one DB round trip; Edge isolates do
-- not share memory, so the database is the only correct shared counter.

create table if not exists public.rate_limit_events (
  id bigint generated always as identity primary key,
  bucket text not null,
  key text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_events_bucket_key_created_at_idx
  on public.rate_limit_events (bucket, key, created_at desc);

-- Only the service role (which bypasses RLS) and the SECURITY DEFINER function
-- below ever touch this table. RLS on with no policies = no anon/authenticated
-- access, matching the other internal tables (reservation_lookup_codes, etc).
alter table public.rate_limit_events enable row level security;

create or replace function public.rate_limit_hit(
  p_bucket text,
  p_key text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count integer;
begin
  -- No usable key (e.g. a stripped client IP) or a non-positive limit means we
  -- cannot meaningfully limit: fail open so a missing header never locks out a
  -- real guest.
  if p_key is null or p_key = '' or p_limit is null or p_limit <= 0 then
    return true;
  end if;

  -- Count-then-insert is intentionally lock-free. Under burst concurrency a
  -- handful of requests may slip one over the limit; that is irrelevant for
  -- abuse protection and avoids serializing every caller of a hot bucket. This
  -- matches the pre-existing per-phone lookup limiter, which is racy by the same
  -- reasoning.
  select count(*) into v_count
  from public.rate_limit_events
  where bucket = p_bucket
    and key = p_key
    and created_at >= now() - make_interval(secs => p_window_seconds);

  if v_count >= p_limit then
    -- Blocked. Do not record the attempt: a flood that is already over the
    -- limit must not keep extending its own window or growing the table.
    return false;
  end if;

  insert into public.rate_limit_events (bucket, key) values (p_bucket, p_key);
  return true;
end;
$$;

-- Keep it off the anon/authenticated PostgREST surface, but the Edge runtime
-- calls it with the service role, so that grant must be explicit: revoking from
-- PUBLIC removes service_role's inherited EXECUTE, and without it every call
-- would error and (by design) fail open — silently disabling rate limiting.
revoke all on function public.rate_limit_hit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, text, integer, integer)
  to service_role;

-- Housekeeping crons -------------------------------------------------------
-- The longest window is 10 minutes, so an hour of retention is ample; prune
-- every 30 minutes to keep the table (and every count query) tiny. The lookup
-- codes table has never had a cleanup and the limiter reads it on the lookup
-- path, so prune it here too (codes expire in 10 minutes; keep 24h for review).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'ecovila-prune-rate-limit-events') then
    perform cron.unschedule('ecovila-prune-rate-limit-events');
  end if;
  perform cron.schedule(
    'ecovila-prune-rate-limit-events',
    '*/30 * * * *',
    $cron$
      delete from public.rate_limit_events
      where created_at < now() - interval '1 hour';
    $cron$
  );

  if exists (select 1 from cron.job where jobname = 'ecovila-prune-lookup-codes') then
    perform cron.unschedule('ecovila-prune-lookup-codes');
  end if;
  perform cron.schedule(
    'ecovila-prune-lookup-codes',
    '15 3 * * *',
    $cron$
      delete from public.reservation_lookup_codes
      where created_at < now() - interval '24 hours';
    $cron$
  );
end $$;
