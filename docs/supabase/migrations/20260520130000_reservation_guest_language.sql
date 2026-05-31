alter table public.reservations
  add column if not exists guest_language text not null default 'ro';

alter table public.reservations
  drop constraint if exists reservations_guest_language_check;

alter table public.reservations
  add constraint reservations_guest_language_check
  check (guest_language in ('ro', 'ru', 'en'));
