-- One live MAIB session per booking group + manual-review flag (ADR-089).
--
-- maib-create-payment was check-then-act: two concurrent requests (double-click,
-- two tabs) could both see "no reusable session" and mint two independently
-- payable MAIB sessions for the same booking. If the guest paid both, the second
-- capture settled silently against the already-paid rows — an undetected double
-- charge. A partial unique index turns the race's loser into a 23505 the
-- function handles by returning the winner's session.
--
-- manual_review marks payment rows that captured money but must not settle
-- (second capture for an already-paid group, unsettleable paid results); the
-- flag is what staff alerts and future CRM surfacing key on.

alter table public.maib_payments
  add column if not exists manual_review boolean not null default false;

-- Retire any historical stale sessions so the unique index can build: first
-- everything past its expiry, then (for safety) all but the newest live row per
-- group. Never touches paid/refunded rows.
update public.maib_payments
set status = 'cancelled', updated_at = now()
where status in ('created', 'pending')
  and expires_at < now();

update public.maib_payments as stale
set status = 'cancelled', updated_at = now()
where stale.status in ('created', 'pending')
  and exists (
    select 1
    from public.maib_payments as newer
    where newer.booking_group_id = stale.booking_group_id
      and newer.status in ('created', 'pending')
      and (
        newer.created_at > stale.created_at
        or (newer.created_at = stale.created_at and newer.pay_id > stale.pay_id)
      )
  );

create unique index if not exists maib_payments_one_live_session_per_group_idx
  on public.maib_payments (booking_group_id)
  where status in ('created', 'pending');
