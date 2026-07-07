-- Refund reconciliation (ADR-088). A MAIB refund request being accepted is not
-- the same as the money reaching the guest: the provider models refunds as their
-- own object with a status (OK / REVERSED / other), and a refund can fail after
-- acceptance — e.g. when the merchant settlement account lacks funds. Until now
-- a 2xx response was recorded as final success and a failed refund row was never
-- read again by anything, so a guest could be told "refunded" without ever
-- receiving the money.
--
-- This migration prepares maib_refunds for a reconcile-and-retry loop:
--   * 'processing' — MAIB acknowledged the request but did not confirm status OK;
--     the reconcile cron keeps re-checking until it resolves.
--   * attempts / last_attempt_at — retry bookkeeping for the cron.
--   * confirmed_at — when status OK (or REVERSED on retry) was observed.
--   * alerted_at — last staff alert for this row, so alerts repeat on a slow
--     cadence instead of every cron tick.
-- The reconcile-refunds Edge Function re-attempts every unresolved refund; MAIB
-- allows a single refund per payment, so a retry of an already-executed refund
-- comes back REVERSED and resolves the row instead of double-refunding.

alter table public.maib_refunds
  drop constraint if exists maib_refunds_status_check;

alter table public.maib_refunds
  add constraint maib_refunds_status_check
  check (status in ('requested', 'processing', 'succeeded', 'failed'));

alter table public.maib_refunds
  add column if not exists provider_status text,
  add column if not exists attempts integer not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists confirmed_at timestamptz,
  add column if not exists alerted_at timestamptz;

create index if not exists maib_refunds_unresolved_idx
  on public.maib_refunds (updated_at)
  where status in ('requested', 'processing', 'failed');

-- Retry every unresolved refund twice an hour. The function is cheap when there
-- is nothing to do (a single indexed select), and refunds are rare enough that
-- the MAIB call volume is negligible. Idempotent re-schedule.
do $$
begin
  perform cron.unschedule('ecovila-reconcile-refunds');
exception
  when others then null;
end $$;

select cron.schedule(
  'ecovila-reconcile-refunds',
  '*/30 * * * *',
  $cron$
    select net.http_post(
      url      := 'https://mckchrviaawdxtsfytut.supabase.co/functions/v1/reconcile-refunds',
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
