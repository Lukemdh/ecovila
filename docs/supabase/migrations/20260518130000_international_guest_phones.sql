alter table public.reservations
  drop constraint if exists reservations_guest_phone_check;

alter table public.reservations
  add constraint reservations_guest_phone_check
  check (guest_phone ~ '^\+[0-9]{8,15}$');
