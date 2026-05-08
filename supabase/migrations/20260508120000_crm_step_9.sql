set search_path = public, extensions;

alter table public.reservations
  drop constraint if exists reservations_created_by_check;

alter table public.reservations
  add constraint reservations_created_by_check
  check (created_by in ('guest', 'diana', 'angela'));

create table if not exists public.crm_photo_sections (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  label text not null,
  display_order integer not null,
  created_at timestamptz not null default now(),
  constraint crm_photo_sections_slug_check check (slug ~ '^[a-z0-9-]+$'),
  constraint crm_photo_sections_display_order_check check (display_order > 0)
);

create table if not exists public.crm_photos (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.crm_photo_sections(id) on delete cascade,
  storage_path text not null,
  alt_text text not null default '',
  sort_order integer not null,
  status text not null default 'draft',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  constraint crm_photos_sort_order_check check (sort_order > 0),
  constraint crm_photos_status_check check (status in ('draft', 'published')),
  constraint crm_photos_published_at_check check (
    (status = 'published' and published_at is not null)
    or (status = 'draft')
  )
);

create table if not exists public.crm_daily_statuses (
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  service_date date not null,
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  checkout_note text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (reservation_id, service_date),
  constraint crm_daily_statuses_has_status_check check (
    checked_in_at is not null
    or checked_out_at is not null
    or checkout_note is not null
  )
);

create index if not exists crm_photo_sections_order_idx
  on public.crm_photo_sections (display_order, slug);

create index if not exists crm_photos_section_status_order_idx
  on public.crm_photos (section_id, status, sort_order);

create index if not exists crm_daily_statuses_service_date_idx
  on public.crm_daily_statuses (service_date);

alter table public.crm_photo_sections enable row level security;
alter table public.crm_photos enable row level security;
alter table public.crm_daily_statuses enable row level security;

grant select on public.crm_photo_sections, public.crm_photos to anon;
grant select on public.crm_photo_sections, public.crm_photos to authenticated;
grant select, insert, update, delete on
  public.crm_photo_sections,
  public.crm_photos,
  public.crm_daily_statuses
to authenticated;

insert into public.crm_photo_sections (slug, label, display_order)
values
  ('landing', 'Landing', 1),
  ('small-villa', 'Căsuță Mică', 2),
  ('large-villa', 'Căsuță Mare', 3),
  ('hotel', 'Hotel', 4),
  ('spa', 'SPA', 5),
  ('territory', 'Teritoriu', 6),
  ('restaurant-food', 'Restaurant/Mâncare', 7),
  ('playground', 'Teren de joacă', 8)
on conflict (slug) do update
set
  label = excluded.label,
  display_order = excluded.display_order;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'ecovila-photos',
  'ecovila-photos',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']::text[]
)
on conflict (id) do update
set
  name = excluded.name,
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

grant select on storage.objects to anon;
grant select, insert, update, delete on storage.objects to authenticated;

drop policy if exists "Public can read EcoVila photos" on storage.objects;
create policy "Public can read EcoVila photos"
on storage.objects
for select
to public
using (bucket_id = 'ecovila-photos');

drop policy if exists "CRM staff can upload EcoVila photos" on storage.objects;
create policy "CRM staff can upload EcoVila photos"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'ecovila-photos'
  and public.ecovila_app_role() in ('diana', 'angela')
);

drop policy if exists "CRM staff can update EcoVila photos" on storage.objects;
create policy "CRM staff can update EcoVila photos"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'ecovila-photos'
  and public.ecovila_app_role() in ('diana', 'angela')
)
with check (
  bucket_id = 'ecovila-photos'
  and public.ecovila_app_role() in ('diana', 'angela')
);

drop policy if exists "CRM staff can delete EcoVila photos" on storage.objects;
create policy "CRM staff can delete EcoVila photos"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'ecovila-photos'
  and public.ecovila_app_role() in ('diana', 'angela')
);

drop policy if exists "Public can read CRM photo sections" on public.crm_photo_sections;
create policy "Public can read CRM photo sections"
on public.crm_photo_sections
for select
to anon, authenticated
using (true);

drop policy if exists "CRM staff can manage photo sections" on public.crm_photo_sections;
create policy "CRM staff can manage photo sections"
on public.crm_photo_sections
for all
to authenticated
using (public.ecovila_app_role() in ('diana', 'angela'))
with check (public.ecovila_app_role() in ('diana', 'angela'));

drop policy if exists "Public can read published CRM photos" on public.crm_photos;
create policy "Public can read published CRM photos"
on public.crm_photos
for select
to anon, authenticated
using (status = 'published');

drop policy if exists "CRM staff can manage CRM photos" on public.crm_photos;
create policy "CRM staff can manage CRM photos"
on public.crm_photos
for all
to authenticated
using (public.ecovila_app_role() in ('diana', 'angela'))
with check (public.ecovila_app_role() in ('diana', 'angela'));

drop policy if exists "CRM staff can manage daily statuses" on public.crm_daily_statuses;
create policy "CRM staff can manage daily statuses"
on public.crm_daily_statuses
for all
to authenticated
using (public.ecovila_app_role() in ('diana', 'angela'))
with check (public.ecovila_app_role() in ('diana', 'angela'));

drop policy if exists "CRM staff can manage rooms" on public.rooms;
create policy "CRM staff can manage rooms"
on public.rooms
for all
to authenticated
using (public.ecovila_app_role() in ('diana', 'angela'))
with check (public.ecovila_app_role() in ('diana', 'angela'));

drop policy if exists "CRM staff can manage pricing_tiers" on public.pricing_tiers;
create policy "CRM staff can manage pricing_tiers"
on public.pricing_tiers
for all
to authenticated
using (public.ecovila_app_role() in ('diana', 'angela'))
with check (public.ecovila_app_role() in ('diana', 'angela'));

drop policy if exists "CRM staff can manage holidays" on public.holidays;
create policy "CRM staff can manage holidays"
on public.holidays
for all
to authenticated
using (public.ecovila_app_role() in ('diana', 'angela'))
with check (public.ecovila_app_role() in ('diana', 'angela'));

drop policy if exists "CRM staff can manage reservations" on public.reservations;
create policy "CRM staff can manage reservations"
on public.reservations
for all
to authenticated
using (public.ecovila_app_role() in ('diana', 'angela'))
with check (public.ecovila_app_role() in ('diana', 'angela'));

drop policy if exists "CRM staff can manage cancellation_tokens" on public.cancellation_tokens;
create policy "CRM staff can manage cancellation_tokens"
on public.cancellation_tokens
for all
to authenticated
using (public.ecovila_app_role() in ('diana', 'angela'))
with check (public.ecovila_app_role() in ('diana', 'angela'));

drop policy if exists "CRM staff can manage notification_events" on public.notification_events;
create policy "CRM staff can manage notification_events"
on public.notification_events
for all
to authenticated
using (public.ecovila_app_role() in ('diana', 'angela'))
with check (public.ecovila_app_role() in ('diana', 'angela'));

create or replace function public.publish_crm_photos()
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if public.ecovila_app_role() not in ('diana', 'angela') then
    raise exception 'Only CRM staff can publish photos.';
  end if;

  delete from public.crm_photos
  where status = 'published';

  insert into public.crm_photos (
    section_id,
    storage_path,
    alt_text,
    sort_order,
    status,
    created_by,
    created_at,
    updated_at,
    published_at
  )
  select
    section_id,
    storage_path,
    alt_text,
    sort_order,
    'published',
    auth.uid(),
    now(),
    now(),
    now()
  from public.crm_photos
  where status = 'draft'
  order by section_id, sort_order, created_at;
end;
$$;

revoke all on function public.publish_crm_photos() from public;
grant execute on function public.publish_crm_photos() to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.reservations;
exception
  when duplicate_object or undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.crm_daily_statuses;
exception
  when duplicate_object or undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.crm_photos;
exception
  when duplicate_object or undefined_object then null;
end $$;
