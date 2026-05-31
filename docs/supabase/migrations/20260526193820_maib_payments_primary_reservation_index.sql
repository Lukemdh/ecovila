set search_path = public, extensions;

create index if not exists maib_payments_primary_reservation_id_idx
  on public.maib_payments (primary_reservation_id)
  where primary_reservation_id is not null;
