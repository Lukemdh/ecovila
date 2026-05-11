with recurring_holiday_duplicates as (
  select
    id,
    row_number() over (
      partition by extract(month from date), extract(day from date)
      order by created_at asc, id asc
    ) as duplicate_rank
  from public.holidays
)
delete from public.holidays
using recurring_holiday_duplicates
where public.holidays.id = recurring_holiday_duplicates.id
  and recurring_holiday_duplicates.duplicate_rank > 1;

create unique index if not exists holidays_recurring_month_day_unique_idx
  on public.holidays (
    (extract(month from date)),
    (extract(day from date))
  );
