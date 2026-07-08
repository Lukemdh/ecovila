-- Refund cooldown (ADR-096). A guest self-service refund is no longer executed
-- the instant the booking is cancelled: it is SCHEDULED, and the reconcile-refunds
-- cron pays it out only after a 60-hour cooldown. The cooldown is a safety buffer
-- — staff can cancel a refund they judge fraudulent/mistaken, or release it early,
-- during the window. Staff/CRM-initiated refunds (maib-refund) are unchanged; they
-- still fire immediately.
--
--   * eligible_at — the earliest moment the cron may execute the refund
--     (now + 60h at schedule time). NULL means "execute on the next tick": legacy
--     rows written before this migration, and any refund that already fired once
--     and is being retried, must not be held back.
--   * status 'cancelled' — a scheduled refund a staff member aborted during the
--     window. Terminal: the cron never touches it and no money moves.
--
-- MAIB still allows exactly one refund per payment, so nothing here weakens the
-- idempotency the reconcile loop relies on — it only delays the first attempt.

alter table public.maib_refunds
  add column if not exists eligible_at timestamptz;

alter table public.maib_refunds
  drop constraint if exists maib_refunds_status_check;

alter table public.maib_refunds
  add constraint maib_refunds_status_check
  check (status in ('requested', 'processing', 'succeeded', 'failed', 'cancelled'));

-- The cron picks up unresolved rows whose cooldown has elapsed; index the due-time
-- for the retryable states (mirrors maib_refunds_unresolved_idx on updated_at).
create index if not exists maib_refunds_eligible_idx
  on public.maib_refunds (eligible_at)
  where status in ('requested', 'processing', 'failed');
