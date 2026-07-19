set search_path = public, extensions;

-- Rate-limit allowlist + per-bucket overrides (ADR-102).
--
-- Two operational controls added WITHOUT touching supabase/functions/_shared/
-- rateLimit.ts, so no edge function has to be redeployed. Both are read inside
-- `rate_limit_hit`, which already receives the bucket/limit as parameters:
--
--   1. rate_limit_allowlist — exact (bucket, key) exemptions. Used for the
--      office egress IP, whose staff share one address on the PUBLIC booking
--      flow and therefore collide on the per-IP buckets.
--   2. rate_limit_overrides — absolute per-bucket limits that win over the
--      value the TypeScript passes in.
--
-- Deliberately ABSOLUTE limits, not a multiplier. A multiplier would make
-- RATE_LIMITS in rateLimit.ts silently understate the real limit, and raising
-- the TS constants later without first dropping the multiplier would compound
-- (1.2 x 1.2 = 1.44). An absolute override converges instead: once the TS value
-- matches the row, deleting the row is a no-op.
--
-- REMOVAL CHOREOGRAPHY: when the raised limits are eventually baked into
-- RATE_LIMITS and deployed, delete the matching rate_limit_overrides rows in
-- the same change. Overrides are the source of truth only while they exist.

create table if not exists public.rate_limit_allowlist (
  bucket text not null,
  key text not null,
  note text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (bucket, key)
);

create table if not exists public.rate_limit_overrides (
  bucket text primary key,
  effective_limit integer not null check (effective_limit > 0),
  note text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- Same stance as rate_limit_events: only the migration/DBA writes these, and
-- only the SECURITY DEFINER function reads them. RLS does not constrain the
-- service role (it bypasses RLS), so revoke the table grants explicitly too.
alter table public.rate_limit_allowlist enable row level security;
alter table public.rate_limit_overrides enable row level security;

revoke all on table public.rate_limit_allowlist from public, anon, authenticated, service_role;
revoke all on table public.rate_limit_overrides from public, anon, authenticated, service_role;

-- Office egress IP (ADR-102) -------------------------------------------------
--
-- Scoped to the exact buckets the office actually transits on the public site.
-- Staff adding bookings through the CRM are NOT covered and do not need to be:
-- that path inserts straight into `reservations` over PostgREST
-- (js/supabase.js insertStaffReservations) and never calls a rate-limited edge
-- function at all.
--
-- complaint-submit:ip is deliberately EXCLUDED. Since ADR-080 stripped the OTP
-- login from /complaints, that bucket is the only spam gate left in front of a
-- fully public form, and the office has no reason to submit complaints.
insert into public.rate_limit_allowlist (bucket, key, note) values
  ('create-reservation:ip', '89.149.88.177', 'Office egress IP (ADR-102)'),
  ('create-payment:ip',     '89.149.88.177', 'Office egress IP (ADR-102)'),
  ('lookup-start:ip',       '89.149.88.177', 'Office egress IP (ADR-102)'),
  ('lookup-verify:ip',      '89.149.88.177', 'Office egress IP (ADR-102)'),
  ('manage-action:ip',      '89.149.88.177', 'Office egress IP (ADR-102)'),
  ('change-create:ip',      '89.149.88.177', 'Office egress IP (ADR-102)'),
  ('change-status:ip',      '89.149.88.177', 'Office egress IP (ADR-102)'),
  ('mia-status:ip',         '89.149.88.177', 'Office egress IP (ADR-102)'),
  ('track-event:ip',        '89.149.88.177', 'Office egress IP (ADR-102)')
on conflict (bucket, key) do nothing;

-- +20% across every bucket (ADR-102) ----------------------------------------
--
-- Exact values, since "+20%" is not expressible as an integer on the two small
-- buckets: 6 -> 7.2 and 12 -> 14.4 are rounded to nearest (7 and 14, i.e. +17%).
-- Rounding up instead would have made those +33% and +17% respectively.
--
-- Per-resource buckets (phone/group/change) are included for parity with the
-- request, but note they are NOT what a shared office IP collides on.
insert into public.rate_limit_overrides (bucket, effective_limit, note) values
  ('lookup-start:ip',            24, '+20% (ADR-102), was 20'),
  ('lookup-verify:ip',           48, '+20% (ADR-102), was 40'),
  ('create-reservation:ip',      12, '+20% (ADR-102), was 10'),
  ('create-reservation:phone',    7, '+17% (ADR-102), was 6 - 7.2 rounded'),
  ('track-event:ip',            144, '+20% (ADR-102), was 120'),
  ('complaint-submit:ip',        12, '+20% (ADR-102), was 10'),
  ('mia-status:ip',             180, '+20% (ADR-102), was 150'),
  ('mia-status:group',           48, '+20% (ADR-102), was 40'),
  ('change-status:ip',          180, '+20% (ADR-102), was 150'),
  ('change-status:change',       48, '+20% (ADR-102), was 40'),
  ('mia-callback:ip',            72, '+20% (ADR-102), was 60'),
  ('create-payment:ip',          36, '+20% (ADR-102), was 30'),
  ('create-payment:group',       14, '+17% (ADR-102), was 12 - 14.4 rounded'),
  ('change-create:ip',           24, '+20% (ADR-102), was 20'),
  ('manage-action:ip',           72, '+20% (ADR-102), was 60')
on conflict (bucket) do update
  set effective_limit = excluded.effective_limit,
      note = excluded.note;

-- rate_limit_hit, now allowlist- and override-aware --------------------------
--
-- Unchanged from 20260619140000 apart from the two lookups and the input
-- validation. `search_path = ''` (rather than the previous `public,
-- extensions`) removes a writable schema from a SECURITY DEFINER function's
-- path per PostgreSQL guidance, so every object below is fully qualified.
--
-- The count-then-insert below is still deliberately lock-free and therefore
-- still racy: concurrent callers can all observe the same pre-insert count and
-- pass together. That is a pre-existing accepted weakness (see the original
-- migration), unchanged here — it is not made worse by this change.
create or replace function public.rate_limit_hit(
  p_bucket text,
  p_key text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_limit integer;
begin
  -- No usable bucket/key, or a nonsensical window, means we cannot meaningfully
  -- limit: fail open, exactly as before. The TS wrapper also fails open on an
  -- RPC error, so malformed input must return rather than raise.
  if p_bucket is null or p_bucket = '' or p_key is null or p_key = '' then
    return true;
  end if;

  if p_window_seconds is null or p_window_seconds <= 0 then
    return true;
  end if;

  -- Exemption is matched on the EXACT (bucket, key) pair, never on the key
  -- alone: `key` is an untyped namespace holding IPs, phone numbers and caller-
  -- supplied resource UUIDs, so a key-only match would let any caller pass the
  -- office IP as a group/change id and bypass that bucket.
  if exists (
    select 1
    from public.rate_limit_allowlist a
    where a.bucket = p_bucket
      and a.key = p_key
      and (a.expires_at is null or a.expires_at > pg_catalog.now())
  ) then
    return true;
  end if;

  select o.effective_limit
    into v_limit
  from public.rate_limit_overrides o
  where o.bucket = p_bucket
    and (o.expires_at is null or o.expires_at > pg_catalog.now());

  v_limit := coalesce(v_limit, p_limit);

  if v_limit is null or v_limit <= 0 then
    return true;
  end if;

  select pg_catalog.count(*)
    into v_count
  from public.rate_limit_events e
  where e.bucket = p_bucket
    and e.key = p_key
    and e.created_at >= pg_catalog.now() - pg_catalog.make_interval(secs => p_window_seconds);

  if v_count >= v_limit then
    -- Blocked. Do not record the attempt: a flood that is already over the
    -- limit must not keep extending its own window or growing the table.
    return false;
  end if;

  insert into public.rate_limit_events (bucket, key) values (p_bucket, p_key);
  return true;
end;
$$;

-- CREATE OR REPLACE on an identical signature preserves ownership and ACLs, but
-- re-assert them so a fresh install and a replayed migration end up identical.
revoke all on function public.rate_limit_hit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, text, integer, integer)
  to service_role;
