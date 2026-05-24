set search_path = public, extensions;

alter table public.reservations
  add column if not exists towel_cards_issued integer;

alter table public.reservations
  drop constraint if exists reservations_towel_cards_issued_check;

alter table public.reservations
  add constraint reservations_towel_cards_issued_check
  check (towel_cards_issued is null or towel_cards_issued >= 0);

create table if not exists public.crm_towel_counts (
  room_id uuid not null references public.rooms(id) on delete cascade,
  service_date date not null,
  towel_count integer not null default 0,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (room_id, service_date),
  constraint crm_towel_counts_towel_count_check check (towel_count >= 0)
);

create index if not exists crm_towel_counts_service_date_idx
  on public.crm_towel_counts (service_date);

alter table public.crm_towel_counts enable row level security;

grant select, insert, update, delete on
  public.crm_towel_counts
to authenticated;

drop policy if exists "CRM staff can manage towel counts" on public.crm_towel_counts;
create policy "CRM staff can manage towel counts"
on public.crm_towel_counts
for all
to authenticated
using (public.ecovila_app_role() in ('diana', 'angela'))
with check (public.ecovila_app_role() in ('diana', 'angela'));

do $$
begin
  alter publication supabase_realtime add table public.crm_towel_counts;
exception
  when duplicate_object or undefined_object then null;
end $$;
