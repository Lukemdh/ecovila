-- ADR-107: bind accommodation-difference payment links to the moved reservation.

alter table public.payment_links
  add column purpose text not null default 'standalone'
    check (purpose in ('standalone', 'accommodation_difference')),
  add column reservation_id uuid references public.reservations(id) on delete restrict,
  add column booking_group_id uuid,
  add column room_type text
    check (room_type is null or room_type in ('small', 'large', 'hotel')),
  add constraint payment_links_reservation_binding_shape_check check (
    (
      purpose = 'standalone'
      and reservation_id is null
      and booking_group_id is null
      and room_type is null
    )
    or (
      purpose = 'accommodation_difference'
      and reservation_id is not null
      and room_type is not null
    )
  );

create unique index payment_links_one_open_accommodation_difference_per_reservation_idx
  on public.payment_links (reservation_id)
  where purpose = 'accommodation_difference' and status = 'active';

create index payment_links_accommodation_difference_reservation_id_idx
  on public.payment_links (reservation_id)
  where purpose = 'accommodation_difference';

create index payment_links_accommodation_difference_booking_group_id_idx
  on public.payment_links (booking_group_id)
  where purpose = 'accommodation_difference';

create policy "Angela can read accommodation difference payment links"
  on public.payment_links
  for select
  to authenticated
  using (
    public.ecovila_app_role() = 'angela'
    and purpose = 'accommodation_difference'
  );

-- The cumulative recorded refund may advance or stay equal for note correction,
-- but a stale CRM session must never lower it and make refunded money reappear.
create or replace function public.mark_payment_link_refunded(
  p_link_id uuid,
  p_amount integer,
  p_note text,
  p_now timestamptz
)
returns public.payment_links
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_link public.payment_links%rowtype;
begin
  select l.*
    into v_link
  from public.payment_links l
  where l.id = p_link_id
  for update;

  if not found then
    raise exception 'Payment link not found' using errcode = 'P0002';
  end if;
  if v_link.status <> 'paid' then
    raise exception 'Only a paid payment link can be marked refunded' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount < 1 then
    raise exception 'Refund amount must be a positive integer' using errcode = 'P0001';
  end if;
  if v_link.paid_amount is null or p_amount > v_link.paid_amount then
    raise exception 'Refund amount cannot exceed the paid amount' using errcode = 'P0001';
  end if;
  if v_link.refunded_amount is not null and p_amount < v_link.refunded_amount then
    raise exception 'Refund amount cannot be lower than the recorded cumulative refund'
      using errcode = 'P0001';
  end if;

  update public.payment_links l set
    refunded_at = p_now,
    refunded_amount = p_amount,
    refund_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
    updated_at = p_now
  where l.id = v_link.id
  returning l.* into v_link;

  return v_link;
end;
$$;

-- Surface payment-link changes to the CRM subscriptions. Safe when realtime is
-- absent and idempotent when the table was already published manually.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'payment_links'
    )
  then
    alter publication supabase_realtime add table public.payment_links;
  end if;
end $$;

-- Reservations are updated directly by Diana as well as through service-role
-- functions. This narrowly scoped trigger must therefore bypass payment_links
-- RLS so every cancellation path atomically revokes the dead row's open link.
create or replace function public.revoke_cancelled_reservation_payment_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payment_links l set
    status = 'revoked',
    revoked_at = coalesce(l.revoked_at, pg_catalog.now()),
    updated_at = pg_catalog.now()
  where l.purpose = 'accommodation_difference'
    and l.reservation_id = new.id
    and l.status = 'active';

  return new;
end;
$$;

revoke all on function public.revoke_cancelled_reservation_payment_links()
  from public, anon, authenticated;

drop trigger if exists revoke_cancelled_reservation_payment_links on public.reservations;
create trigger revoke_cancelled_reservation_payment_links
  after update of payment_status on public.reservations
  for each row
  when (old.payment_status is distinct from 'cancelled' and new.payment_status = 'cancelled')
  execute function public.revoke_cancelled_reservation_payment_links();

-- The separately billed difference is intentionally not folded into
-- reservations.total_price. Once such a link exists, changing the base total
-- would make later settlement/refund arithmetic ambiguous. This must bypass
-- payment_links RLS because reservations are also updated directly by staff.
create or replace function public.prevent_repricing_with_accommodation_difference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.payment_links l
    where l.purpose = 'accommodation_difference'
      and l.reservation_id = old.id
  ) then
    raise exception 'Reservation total price cannot change after an accommodation difference payment link exists'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_repricing_with_accommodation_difference()
  from public, anon, authenticated;

drop trigger if exists prevent_repricing_with_accommodation_difference on public.reservations;
create trigger prevent_repricing_with_accommodation_difference
  before update of total_price on public.reservations
  for each row
  when (new.total_price is distinct from old.total_price)
  execute function public.prevent_repricing_with_accommodation_difference();

create or replace function public.move_reservation_accommodation(
  p_reservation_id uuid,
  p_expected_source_room_id uuid,
  p_target_room_id uuid,
  p_amount integer,
  p_payment_rail text,
  p_expires_at timestamptz,
  p_label text,
  p_now timestamptz
)
returns table (
  room_number integer,
  room_type text,
  payment_link_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_booking_group_id uuid;
  v_payment_status text;
  v_cancelled_at timestamptz;
  v_source_room_id uuid;
  v_source_room_type text;
  v_target_room_number integer;
  v_target_room_type text;
  v_target_room_active boolean;
  v_payment_link_id uuid;
  v_previous_payment_link_id uuid;
  v_billing boolean := p_amount is not null;
begin
  -- 1. Validate scalars before acquiring row locks.
  if p_reservation_id is null
    or p_expected_source_room_id is null
    or p_target_room_id is null
    or p_expected_source_room_id = p_target_room_id
    or p_now is null
  then
    raise exception 'Reservation, distinct source/target rooms, and current time are required'
      using errcode = '22023';
  end if;

  if v_billing then
    if p_amount < 1 or p_amount > 1000000 then
      raise exception 'Amount must be an integer between 1 and 1000000'
        using errcode = '22023';
    end if;
    if p_payment_rail is null or p_payment_rail not in ('mia', 'card') then
      raise exception 'Payment rail must be mia or card' using errcode = '22023';
    end if;
    if p_expires_at is not null and p_expires_at <= p_now then
      raise exception 'Payment-link expiry must be in the future' using errcode = '22023';
    end if;
    if p_label is not null and pg_catalog.char_length(p_label) > 120 then
      raise exception 'Payment-link label must be at most 120 characters'
        using errcode = '22023';
    end if;
  elsif p_payment_rail is not null or p_expires_at is not null or p_label is not null then
    raise exception 'Payment-link fields require an amount' using errcode = '22023';
  end if;

  -- 2. Lock the reservation row and derive its group/source type server-side.
  select
    r.booking_group_id,
    r.payment_status,
    r.cancelled_at,
    r.room_id,
    source_room.type
  into
    v_booking_group_id,
    v_payment_status,
    v_cancelled_at,
    v_source_room_id,
    v_source_room_type
  from public.reservations r
  left join public.rooms source_room on source_room.id = r.room_id
  where r.id = p_reservation_id
  for update of r;

  if not found then
    raise exception 'Reservation no longer exists' using errcode = 'P0002';
  end if;

  -- 3. Refuse dead or stale rows after the reservation lock is held.
  if v_cancelled_at is not null
    or v_payment_status not in ('pending', 'paid')
    or v_source_room_id is null
    or v_source_room_id <> p_expected_source_room_id
    or v_source_room_type is null
  then
    raise exception 'Reservation is no longer live in the expected source room'
      using errcode = 'P0002';
  end if;

  -- 4. A new difference may only be billed against an already-paid row.
  if v_billing and v_payment_status <> 'paid' then
    raise exception 'Accommodation difference billing requires a paid reservation'
      using errcode = 'P0001';
  end if;

  -- 5. Lock the target and derive its mutable number/type/active state server-side.
  select room.number, room.type, room.is_active
    into v_target_room_number, v_target_room_type, v_target_room_active
  from public.rooms room
  where room.id = p_target_room_id
  for update;

  if not found or not coalesce(v_target_room_active, false) then
    raise exception 'Target accommodation is inactive' using errcode = 'P0001';
  end if;
  if v_billing and v_target_room_type = v_source_room_type then
    raise exception 'Accommodation difference billing requires a different room type'
      using errcode = 'P0001';
  end if;

  -- 6. A pending guest-change settlement would apply a stale party snapshot.
  if v_booking_group_id is not null and exists (
    select 1
    from public.reservation_changes change_row
    where change_row.booking_group_id = v_booking_group_id
      and change_row.status = 'pending'
  ) then
    raise exception 'A pending reservation change must be resolved before moving accommodation'
      using errcode = 'P0001';
  end if;

  -- claim_payment_link_attempt and settle_payment_link_attempt both lock the
  -- link row first. Remember the active link before taking that same lock so a
  -- capture already in flight cannot make the row disappear from an
  -- "status = active" locking query. A later claim blocks behind this lock and
  -- observes the revocation; an earlier claim/capture finishes first and is
  -- detected below.
  if v_billing then
    select l.id
      into v_previous_payment_link_id
    from public.payment_links l
    where l.purpose = 'accommodation_difference'
      and l.reservation_id = p_reservation_id
      and l.status = 'active';

    if v_previous_payment_link_id is not null then
      perform 1
      from public.payment_links l
      where l.id = v_previous_payment_link_id
      for update;

      if exists (
        select 1
        from public.payment_link_attempts a
        where a.payment_link_id = v_previous_payment_link_id
          and a.status in ('creating', 'pending')
      ) or not exists (
        select 1
        from public.payment_links l
        where l.id = v_previous_payment_link_id
          and l.status = 'active'
      ) then
        raise exception 'Outstanding accommodation difference payment link is being processed; wait for it to finish or revoke it before issuing a replacement'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  update public.payment_links l set
    status = 'revoked',
    revoked_at = coalesce(l.revoked_at, p_now),
    updated_at = p_now
  where l.purpose = 'accommodation_difference'
    and l.reservation_id = p_reservation_id
    and l.status = 'active';

  -- 7. Vacate before assigning so only conflicts with other bookings can raise 23P01.
  update public.reservations r
  set room_id = null
  where r.id = p_reservation_id;

  update public.reservations r
  set room_id = p_target_room_id
  where r.id = p_reservation_id;

  if v_billing then
    insert into public.payment_links (
      amount,
      currency,
      payment_rail,
      label,
      expires_at,
      purpose,
      reservation_id,
      booking_group_id,
      room_type,
      created_at,
      updated_at
    ) values (
      p_amount,
      'MDL',
      p_payment_rail,
      nullif(pg_catalog.btrim(coalesce(p_label, '')), ''),
      p_expires_at,
      'accommodation_difference',
      p_reservation_id,
      v_booking_group_id,
      v_target_room_type,
      p_now,
      p_now
    )
    returning id into v_payment_link_id;
  end if;

  -- 8. Return the authoritative target and optional link identity.
  return query
  select v_target_room_number, v_target_room_type, v_payment_link_id;
end;
$$;

revoke all on function public.move_reservation_accommodation(
  uuid, uuid, uuid, integer, text, timestamptz, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.move_reservation_accommodation(
  uuid, uuid, uuid, integer, text, timestamptz, text, timestamptz
) to service_role;
