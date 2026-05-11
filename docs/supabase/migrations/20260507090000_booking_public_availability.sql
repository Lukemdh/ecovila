set search_path = public, extensions;

create or replace function public.get_public_availability_blocks(range_start date, range_end date)
returns table (
  room_id uuid,
  check_in date,
  check_out date
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    reservations.room_id,
    reservations.check_in,
    reservations.check_out
  from public.reservations
  where range_start is not null
    and range_end is not null
    and range_end > range_start
    and reservations.room_id is not null
    and reservations.payment_status in ('pending', 'paid')
    and reservations.cancelled_at is null
    and daterange(reservations.check_in, reservations.check_out, '[)')
      && daterange(range_start, range_end, '[)');
$$;

revoke all on function public.get_public_availability_blocks(date, date) from public;
grant execute on function public.get_public_availability_blocks(date, date) to anon, authenticated;
