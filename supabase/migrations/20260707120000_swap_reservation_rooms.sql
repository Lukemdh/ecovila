-- Make the CRM dashboard drag-to-swap atomic.
--
-- The dashboard swapped two reservations' rooms as two independent PostgREST
-- UPDATEs whose { error } results were discarded. Because of the exclusion
-- constraint reservations_no_room_overlap, a swap of two date-overlapping stays
-- can NEVER succeed that way — the first UPDATE always collides with the row
-- that has not moved yet (23P01), and both failures were silent. Worse, a
-- conflict with a third booking could half-apply the swap (one row moved, the
-- other not). This RPC performs the whole swap in ONE transaction using the
-- same vacate-then-assign pattern as reschedule_reservation_group (ADR-087):
--   1. Vacate both rows (room_id -> NULL removes them from the no-overlap
--      exclusion constraint, whose predicate is `room_id is not null`).
--   2. Assign each row the other's room. The only conflicts the constraint can
--      still raise are against OTHER bookings (a concurrent grab), which aborts
--      the statement and rolls back the whole swap — nothing half-applies.
--
-- Access model: unlike reschedule_reservation_group (service-role only, called
-- from an Edge Function), this RPC is called directly by the logged-in CRM as
-- an `authenticated` user. SECURITY DEFINER bypasses RLS, so the function must
-- gate itself: only the writer role ('diana') may swap — the same check the
-- "Diana can manage reservations" policy performs (public.ecovila_app_role()
-- reads auth.jwt().app_metadata.role; Angela stays read-only, 20260618150000).

create or replace function public.swap_reservation_rooms(left_id uuid, right_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  left_room uuid;
  right_room uuid;
begin
  if public.ecovila_app_role() <> 'diana' then
    raise exception 'Only the diana staff role may swap reservation rooms'
      using errcode = '42501';
  end if;

  if left_id is null or right_id is null or left_id = right_id then
    raise exception 'A swap needs two distinct reservations';
  end if;

  -- Lock both rows so a concurrent edit cannot slip between the reads and the
  -- writes. Refuse cancelled rows and anything outside pending/paid.
  select r.room_id into left_room
    from public.reservations r
   where r.id = left_id
     and r.cancelled_at is null
     and r.payment_status in ('pending', 'paid')
     for update;
  if not found then
    raise exception 'Reservation % no longer exists or can no longer be moved', left_id;
  end if;

  select r.room_id into right_room
    from public.reservations r
   where r.id = right_id
     and r.cancelled_at is null
     and r.payment_status in ('pending', 'paid')
     for update;
  if not found then
    raise exception 'Reservation % no longer exists or can no longer be moved', right_id;
  end if;

  if left_room is null or right_room is null then
    raise exception 'Both reservations must have a room assigned before swapping';
  end if;

  -- Phase 1 — vacate both rooms.
  update public.reservations set room_id = null where id in (left_id, right_id);

  -- Phase 2 — assign each reservation the other's room. A 23P01 here (third
  -- booking occupies the target room for those dates) rolls the whole swap back.
  update public.reservations set room_id = right_room where id = left_id;
  update public.reservations set room_id = left_room  where id = right_id;
end;
$$;

-- Revoking from PUBLIC also strips the implicit EXECUTE every role inherits, so
-- the grants must be explicit (same pattern as public.rate_limit_hit, ADR-060).
-- `authenticated` is deliberate: the CRM calls this RPC directly; the in-function
-- role check above (diana only) is the real gate, and anon stays locked out.
revoke all on function public.swap_reservation_rooms(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.swap_reservation_rooms(uuid, uuid)
  to authenticated, service_role;
