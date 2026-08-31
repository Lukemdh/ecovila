create table public.guest_flag_exclusions (
  value text primary key,
  kind text not null check (kind in ('phone', 'email')),
  label text,
  created_at timestamptz not null default now()
);

insert into public.guest_flag_exclusions (value, kind, label)
values
  ('+37360120220', 'phone', 'Număr de birou EcoVila'),
  ('office@ecovila.md', 'email', 'Adresa de birou EcoVila')
on conflict do nothing;

alter table public.guest_flag_exclusions enable row level security;

revoke all on table public.guest_flag_exclusions from anon, authenticated, public;
grant select on table public.guest_flag_exclusions to authenticated;
grant all on table public.guest_flag_exclusions to service_role;

create policy "Diana can read guest flag exclusions"
  on public.guest_flag_exclusions
  for select
  to authenticated
  using (public.ecovila_app_role() = 'diana');

create policy "Angela can read guest flag exclusions"
  on public.guest_flag_exclusions
  for select
  to authenticated
  using (public.ecovila_app_role() = 'angela');

create table public.guest_notes (
  id uuid primary key default gen_random_uuid(),
  guest_phone text,
  guest_email text,
  severity text not null default 'info',
  body text not null,
  source_reservation_id uuid references public.reservations(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_by_role text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null,
  constraint guest_notes_contact_check check (
    guest_phone is not null or guest_email is not null
  ),
  constraint guest_notes_phone_check check (
    guest_phone is null or guest_phone ~ '^\+[0-9]{8,15}$'
  ),
  constraint guest_notes_email_check check (
    guest_email is null
    or (position('@' in guest_email) > 1 and guest_email = lower(guest_email))
  ),
  constraint guest_notes_severity_check check (
    severity in ('info', 'attention', 'vip')
  ),
  constraint guest_notes_created_by_role_check check (
    created_by_role in ('diana', 'angela')
  ),
  constraint guest_notes_body_check check (
    char_length(btrim(body)) between 1 and 2000
  ),
  -- archived_by carries ON DELETE SET NULL, so a both-or-neither pair check would
  -- abort the deletion of any staff user who had ever archived a note. The real
  -- invariant is one-directional: an archiver without an archive time is nonsense,
  -- an archive whose author was since deleted is not.
  constraint guest_notes_archived_pair_check check (
    archived_by is null or archived_at is not null
  )
);

create index guest_notes_phone_idx
  on public.guest_notes (guest_phone)
  where archived_at is null and guest_phone is not null;

create index guest_notes_email_idx
  on public.guest_notes (guest_email)
  where archived_at is null and guest_email is not null;

create index guest_notes_source_idx
  on public.guest_notes (source_reservation_id);

create index reservations_guest_phone_history_idx
  on public.reservations (guest_phone, check_in desc);

create index reservations_guest_email_history_idx
  on public.reservations (lower(guest_email), check_in desc)
  where guest_email is not null;

create function public.prepare_guest_note_insert()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.ecovila_app_role();
begin
  new.created_by := actor_id;

  if actor_id is null and btrim(coalesce(actor_role, '')) = '' then
    actor_role := 'diana';
  end if;

  new.created_by_role := actor_role;

  if new.created_by_role not in ('diana', 'angela') then
    raise exception 'Only Diana or Angela may create guest notes.'
      using errcode = '42501';
  end if;

  if new.archived_at is not null or new.archived_by is not null then
    raise exception 'Guest notes cannot be archived when inserted.'
      using errcode = '23514';
  end if;

  new.guest_email := nullif(lower(btrim(new.guest_email)), '');
  new.guest_phone := nullif(btrim(new.guest_phone), '');

  if exists (
    select 1
    from public.guest_flag_exclusions exclusions
    where (exclusions.kind = 'phone' and exclusions.value = new.guest_phone)
       or (exclusions.kind = 'email' and exclusions.value = new.guest_email)
  ) then
    raise exception 'Guest notes cannot be attached to an excluded contact.'
      using errcode = '23514';
  end if;

  if new.source_reservation_id is not null
    and not exists (
      select 1
      from public.reservations reservations
      where reservations.id = new.source_reservation_id
        and (
          reservations.guest_phone = new.guest_phone
          or lower(reservations.guest_email) = new.guest_email
        )
    ) then
    raise exception 'The source reservation does not belong to the note contact.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger prepare_guest_note_insert
  before insert on public.guest_notes
  for each row
  execute function public.prepare_guest_note_insert();

create function public.enforce_guest_note_update_columns()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public
as $$
declare
  allowed_columns constant text[] := array['archived_at', 'archived_by', 'updated_at'];
  old_row jsonb;
  new_row jsonb;
  column_name text;
  changed_columns text[];
begin
  old_row := to_jsonb(old);

  -- Archiving and un-archiving are the only mutations, and the trigger — not the
  -- caller — decides who did it and when. Without this, Diana could post any
  -- archived_by uuid and any archived_at timestamp she liked.
  if old.archived_at is null and new.archived_at is not null then
    new.archived_at := now();
    new.archived_by := auth.uid();
  elsif old.archived_at is not null and new.archived_at is null then
    new.archived_by := null;
  end if;

  new.updated_at := now();
  new_row := to_jsonb(new);

  -- ON DELETE SET NULL on source_reservation_id / created_by performs an UPDATE on
  -- this row, so blocking it outright would make deleting a reservation or a staff
  -- user fail with 42501. A referential action changes exactly one column, so the
  -- exemption is granted only when nothing else moved — a client UPDATE cannot
  -- launder an immutable-column wipe through it.
  select coalesce(array_agg(key), '{}'::text[])
    into changed_columns
    from jsonb_object_keys(new_row) as key
    where key <> 'updated_at'
      and (new_row -> key) is distinct from (old_row -> key);

  for column_name in select jsonb_object_keys(new_row) loop
    continue when column_name = 'updated_at';

    if column_name in ('source_reservation_id', 'created_by')
      and (new_row -> column_name) = 'null'::jsonb
      and changed_columns = array[column_name] then
      continue;
    end if;

    if not (column_name = any (allowed_columns))
      and (new_row -> column_name) is distinct from (old_row -> column_name) then
      raise exception 'Guest notes are immutable (blocked column: %)', column_name
        using errcode = '42501';
    end if;
  end loop;

  return new;
end;
$$;

create trigger enforce_guest_note_update_columns
  before update on public.guest_notes
  for each row
  execute function public.enforce_guest_note_update_columns();

alter table public.guest_notes enable row level security;

revoke all on table public.guest_notes from anon, authenticated, public;
grant select, insert, update on table public.guest_notes to authenticated;
grant select, insert, update on table public.guest_notes to service_role;

create policy "Diana can read guest notes"
  on public.guest_notes
  for select
  to authenticated
  using (public.ecovila_app_role() = 'diana');

create policy "Diana can create guest notes"
  on public.guest_notes
  for insert
  to authenticated
  with check (public.ecovila_app_role() = 'diana');

create policy "Diana can archive guest notes"
  on public.guest_notes
  for update
  to authenticated
  using (public.ecovila_app_role() = 'diana')
  with check (public.ecovila_app_role() = 'diana');

create policy "Angela can read guest notes"
  on public.guest_notes
  for select
  to authenticated
  using (public.ecovila_app_role() = 'angela');

create policy "Angela can create guest notes"
  on public.guest_notes
  for insert
  to authenticated
  with check (public.ecovila_app_role() = 'angela');

create view public.guest_flag_markers as
select
  notes.id,
  notes.guest_phone,
  notes.guest_email,
  notes.severity,
  notes.created_at,
  left(notes.body, 180) as body_preview
from public.guest_notes notes
where notes.archived_at is null
  and notes.severity <> 'info'
  and not exists (
    select 1
    from public.guest_flag_exclusions exclusions
    where (exclusions.kind = 'phone' and exclusions.value = notes.guest_phone)
       or (exclusions.kind = 'email' and exclusions.value = notes.guest_email)
  );

alter view public.guest_flag_markers set (security_invoker = true);

revoke all on table public.guest_flag_markers from anon, public;
grant select on table public.guest_flag_markers to authenticated, service_role;

-- review_request was missing from the repository's latest constraint copy and is
-- restored here deliberately alongside the complete production allowlist.
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
      'checkin_welcome',
      'review_request',
      'guest_flag_alert'
    )
  );

do $$
begin
  alter publication supabase_realtime add table public.guest_notes;
exception
  when duplicate_object or undefined_object then null;
end $$;
