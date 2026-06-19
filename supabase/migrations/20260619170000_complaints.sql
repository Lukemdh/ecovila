-- ADR-068: Guest complaints + admin "Probleme" + check-in welcome SMS.
--
-- Guests open ecovila.md/complaints, authenticate with the existing phone-OTP
-- flow (reused reservation_lookup_codes storage; see complaint-login-* edge
-- functions), pick a category, write a description and optionally submit
-- anonymously. Staff (diana + angela) triage the complaints in a new CRM tab.
-- A welcome SMS pointing at the page is sent when staff mark a guest checked-in.
--
-- This migration adds the complaint tables, a per-staff "last seen" cursor for
-- the unread badge, the post-OTP session-token store, the new notification
-- event type, RLS, and realtime.

set search_path = public, extensions;

-- 1. Complaints. Inserts happen only through the service-role edge function
--    (no insert policy below), so RLS keeps the public anon/authenticated keys
--    out of the table entirely.
create table if not exists public.complaints (
  id uuid primary key default gen_random_uuid(),
  category text not null
    constraint complaints_category_check
    check (category in ('casuta', 'facilitati', 'personal', 'altceva')),
  description text not null
    constraint complaints_description_length_check
    check (char_length(btrim(description)) between 1 and 2000),
  is_anonymous boolean not null default false,
  -- Identity columns are null for anonymous complaints (enforced below), so an
  -- anonymous report is genuinely unlinkable rather than merely hidden in the UI.
  guest_phone text,
  guest_first_name text,
  reservation_id uuid references public.reservations(id) on delete set null,
  language text
    constraint complaints_language_check
    check (language is null or language in ('ro', 'ru', 'en')),
  status text not null default 'new'
    constraint complaints_status_check
    check (status in ('new', 'solved')),
  created_at timestamptz not null default now(),
  solved_at timestamptz,
  solved_by uuid references auth.users(id) on delete set null,
  constraint complaints_anonymous_identity_check check (
    not is_anonymous
    or (guest_phone is null and guest_first_name is null and reservation_id is null)
  ),
  constraint complaints_solved_state_check check (
    (status = 'solved' and solved_at is not null)
    or (status = 'new' and solved_at is null and solved_by is null)
  )
);

create index if not exists complaints_status_created_idx
  on public.complaints (status, created_at desc);

create index if not exists complaints_created_idx
  on public.complaints (created_at desc);

alter table public.complaints enable row level security;

grant select, update on public.complaints to authenticated;

drop policy if exists "CRM staff can read complaints" on public.complaints;
create policy "CRM staff can read complaints"
  on public.complaints
  for select
  to authenticated
  using (public.ecovila_app_role() in ('diana', 'angela'));

-- Both roles may flip a complaint to solved. The admin UI never edits complaint
-- content, so no column guard is added (internal-staff trust model, the same one
-- under which diana already has full reservation management).
drop policy if exists "CRM staff can update complaints" on public.complaints;
create policy "CRM staff can update complaints"
  on public.complaints
  for update
  to authenticated
  using (public.ecovila_app_role() in ('diana', 'angela'))
  with check (public.ecovila_app_role() in ('diana', 'angela'));

-- 2. Per-staff "last seen" cursor. The unread badge counts complaints created
--    after the viewer's own last_seen_at, so Diana and Angela each clear their
--    badge independently when they open the tab.
create table if not exists public.complaint_read_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.complaint_read_state enable row level security;

grant select, insert, update on public.complaint_read_state to authenticated;

drop policy if exists "CRM staff manage own complaint read state"
  on public.complaint_read_state;
create policy "CRM staff manage own complaint read state"
  on public.complaint_read_state
  for all
  to authenticated
  using (
    user_id = auth.uid()
    and public.ecovila_app_role() in ('diana', 'angela')
  )
  with check (
    user_id = auth.uid()
    and public.ecovila_app_role() in ('diana', 'angela')
  );

-- 3. Post-OTP session token (mirrors reservation_manage_tokens but isolated from
--    the reservation-management surface). RLS on with no policies => only the
--    service role (which bypasses RLS) can read or write it.
create table if not exists public.complaint_sessions (
  token_hash text primary key,
  phone text not null check (phone ~ '^\+[0-9]{8,15}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists complaint_sessions_expires_at_idx
  on public.complaint_sessions (expires_at);

alter table public.complaint_sessions enable row level security;

-- 4. New notification event type for the check-in welcome SMS. dispatch dedups
--    on (reservation_id, event_type), so this keeps the welcome exactly-once.
alter table public.notification_events
  drop constraint if exists notification_events_event_type_check;

alter table public.notification_events
  add constraint notification_events_event_type_check check (
    event_type in (
      'booking_confirmation',
      'payment_confirmation',
      'cash_expiry_warning',
      'cash_expired',
      'reservation_cancelled',
      'guest_cancellation',
      'arrival_24h',
      'checkin_welcome'
    )
  );

-- 5. Realtime so the admin list + unread badge update live.
do $$
begin
  alter publication supabase_realtime add table public.complaints;
exception
  when duplicate_object or undefined_object then null;
end $$;
