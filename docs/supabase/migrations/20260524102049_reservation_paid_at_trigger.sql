create or replace function public.set_reservation_paid_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.payment_status = 'paid'
    and new.paid_at is null
    and (tg_op = 'INSERT' or old.payment_status is distinct from 'paid')
  then
    new.paid_at = now();
  end if;

  return new;
end;
$$;

drop trigger if exists set_reservation_paid_at_before_write on public.reservations;

create trigger set_reservation_paid_at_before_write
before insert or update of payment_status, paid_at on public.reservations
for each row
execute function public.set_reservation_paid_at();
