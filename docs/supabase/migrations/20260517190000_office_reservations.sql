alter table public.reservations
  drop constraint if exists reservations_payment_type_check;

alter table public.reservations
  add constraint reservations_payment_type_check
  check (payment_type in ('cash', 'card', 'office'));
