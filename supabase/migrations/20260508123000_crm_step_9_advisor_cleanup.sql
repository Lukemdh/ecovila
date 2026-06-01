set search_path = public, extensions;

drop policy if exists "Public can read EcoVila photos" on storage.objects;

create index if not exists crm_photos_created_by_idx
  on public.crm_photos (created_by)
  where created_by is not null;

create index if not exists crm_daily_statuses_updated_by_idx
  on public.crm_daily_statuses (updated_by)
  where updated_by is not null;

create index if not exists holidays_created_by_idx
  on public.holidays (created_by)
  where created_by is not null;

drop policy if exists "Diana can manage rooms" on public.rooms;
drop policy if exists "Angela can read rooms" on public.rooms;
drop policy if exists "Public can read rooms" on public.rooms;
create policy "Public can read rooms"
on public.rooms
for select
to anon
using (is_active = true);

drop policy if exists "Diana can manage pricing_tiers" on public.pricing_tiers;
drop policy if exists "Angela can read pricing_tiers" on public.pricing_tiers;
drop policy if exists "Public can read pricing_tiers" on public.pricing_tiers;
create policy "Public can read pricing_tiers"
on public.pricing_tiers
for select
to anon
using (true);

drop policy if exists "Diana can manage holidays" on public.holidays;
drop policy if exists "Angela can read holidays" on public.holidays;
drop policy if exists "Public can read holidays" on public.holidays;
create policy "Public can read holidays"
on public.holidays
for select
to anon
using (true);

drop policy if exists "Diana can manage reservations" on public.reservations;
drop policy if exists "Angela can read reservations" on public.reservations;
drop policy if exists "Public can create guest reservations" on public.reservations;
create policy "Public can create guest reservations"
on public.reservations
for insert
to anon
with check (
  created_by = 'guest'
  and payment_status = 'pending'
  and payment_type in ('cash', 'card')
  and adults >= 1
  and room_id is not null
  and conference_room = false
  and notes is null
  and cancelled_at is null
  and cancellation_reason is null
);

drop policy if exists "Diana can manage cancellation_tokens" on public.cancellation_tokens;
drop policy if exists "Angela can read cancellation_tokens" on public.cancellation_tokens;

drop policy if exists "Diana can manage notification_events" on public.notification_events;
drop policy if exists "Angela can read notification_events" on public.notification_events;

drop policy if exists "Public can read CRM photo sections" on public.crm_photo_sections;
create policy "Public can read CRM photo sections"
on public.crm_photo_sections
for select
to anon
using (true);

drop policy if exists "Public can read published CRM photos" on public.crm_photos;
create policy "Public can read published CRM photos"
on public.crm_photos
for select
to anon
using (status = 'published');
