-- ADR-057: guest-initiated "add people" changes to a confirmed reservation.
--
-- A guest who already paid online can add adults/children to a booking (within
-- the capacity of the villas they chose) and pay only the price difference. The
-- extra payment is NOT recorded on public.maib_payments: every reconcile /
-- refund / callback path keys off the *latest* maib_payments row for a booking
-- group, so a second row there would hijack the original booking's settlement.
-- Instead each "add people" request is its own ledger row here.
--
-- The reservation's base total_price is left untouched (it stays the originally
-- charged amount); only adults/kids_ages on the booking's rows are updated when
-- a difference is paid. Finance surfaces each paid difference as its own dated
-- "Online plătit diferență" line, summing difference_amount by paid_at. The
-- snapshot columns (room_type, check_in, check_out, party before/after) let the
-- CRM render those lines without re-joining the reservations table.
--
-- Edge functions write/apply through the service role and bypass RLS; the only
-- policy granted is read access for the CRM (owner + Angela read-only views).

set search_path = public, extensions;

create table if not exists public.reservation_changes (
  id uuid primary key default gen_random_uuid(),
  booking_group_id uuid not null,
  reservation_ids uuid[] not null default '{}'::uuid[],
  room_type text,
  check_in date,
  check_out date,
  prev_adults integer not null,
  prev_kids_ages integer[] not null default '{}'::integer[],
  new_adults integer not null,
  new_kids_ages integer[] not null default '{}'::integer[],
  prev_total integer not null,
  new_total integer not null,
  difference_amount integer not null,
  payment_rail text,
  pay_id text,
  provider_payment_id text,
  status text not null default 'pending',
  checkout_url text not null default '',
  callback_payload jsonb not null default '{}'::jsonb,
  refund_payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  paid_at timestamptz,
  applied_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reservation_changes_party_check check (
    prev_adults >= 0 and new_adults >= 0 and new_adults >= prev_adults
  ),
  constraint reservation_changes_amounts_check check (
    prev_total >= 0
    and new_total >= 0
    and difference_amount >= 0
    and new_total = prev_total + difference_amount
  ),
  constraint reservation_changes_payment_rail_check check (
    payment_rail is null or payment_rail in ('mia', 'card')
  ),
  constraint reservation_changes_status_check check (
    status in ('pending', 'paid', 'failed', 'cancelled', 'expired', 'refunded')
  )
);

create index if not exists reservation_changes_booking_group_id_idx
  on public.reservation_changes (booking_group_id);

-- At most one OPEN (pending) change per booking at a time. supersedeOpenChanges
-- cancels the prior pending row before inserting a new one; this index turns a
-- concurrent double-submit into a retryable unique violation instead of two
-- payable difference sessions (a double-charge risk). Paid/cancelled/refunded
-- rows are unconstrained, so a booking can accumulate many settled changes.
create unique index if not exists reservation_changes_one_open_per_group_idx
  on public.reservation_changes (booking_group_id)
  where status = 'pending';

-- MAIB checkout / MIA QR id, used by the callbacks to route a difference payment
-- back to its change row. Unique only when present (free, zero-difference
-- applies have no payment and leave it null).
create unique index if not exists reservation_changes_pay_id_key
  on public.reservation_changes (pay_id)
  where pay_id is not null;

create index if not exists reservation_changes_paid_at_idx
  on public.reservation_changes (paid_at)
  where status = 'paid' and difference_amount > 0;

-- Open sessions whose window has lapsed, for lazy expiry.
create index if not exists reservation_changes_open_expiry_idx
  on public.reservation_changes (expires_at)
  where status = 'pending';

alter table public.reservation_changes enable row level security;

-- Read-only for the CRM. Diana (owner) and Angela both see finance/dashboard.
-- All inserts, payment updates, and party applies happen via the service role.
drop policy if exists "CRM staff can read reservation changes" on public.reservation_changes;
create policy "CRM staff can read reservation changes"
  on public.reservation_changes
  for select
  to authenticated
  using (public.ecovila_app_role() in ('diana', 'angela'));

-- Surface paid differences to the live finance view. Idempotent so re-running the
-- migration (or running it where the publication is absent) is safe.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'reservation_changes'
    )
  then
    alter publication supabase_realtime add table public.reservation_changes;
  end if;
end $$;
