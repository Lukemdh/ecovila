alter table public.reservations
  add column if not exists paid_at timestamptz;

update public.reservations
set paid_at = coalesce(paid_at, created_at)
where payment_status = 'paid'
  and paid_at is null;

create index if not exists reservations_paid_at_idx
  on public.reservations (paid_at)
  where payment_status = 'paid'
    and cancelled_at is null;
