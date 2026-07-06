-- ADR-087: make the staff "move booking to new dates" reschedule atomic.
--
-- The reservation-reschedule Edge Function (ADR-086) planned the villa for each
-- row, then applied the moves as a per-row UPDATE loop — each a separate PostgREST
-- auto-commit. If a concurrent booking grabbed a planned villa between the plan and
-- a later row's write, earlier rows had already moved: a multi-villa group could be
-- left half-moved (split across old and new dates). This RPC applies all the
-- already-decided per-row patches in ONE transaction, so any such conflict rolls
-- the WHOLE move back and nothing changes. The Edge Function keeps doing the
-- availability planning; the exclusion constraint reservations_no_room_overlap
-- (23P01) stays the concurrency arbiter — it just now aborts the whole move.
--
-- Two phases inside the single transaction:
--   1. Vacate every group row (room_id -> NULL removes it from the no-overlap
--      exclusion constraint, whose predicate is `room_id is not null`) while
--      writing the new dates + edited fields.
--   2. Assign each row its planned room.
-- Vacating first lets a booking relocate INTO a room a sibling row is leaving
-- without the sibling's not-yet-moved row tripping the exclusion constraint
-- mid-transaction (the swap/rotation case). room_id is nullable, so this is safe.
--
-- p_patches is a JSON array of per-row patches built by the Edge Function. Each
-- element always carries { id, room_id, check_in, check_out } and MAY carry the
-- shared guest_first_name / guest_last_name / guest_phone and, for the opened row
-- only, adults / kids_ages / notes. A key's PRESENCE means "set it"; an absent key
-- means "leave the stored value untouched" — mirroring the function's field
-- builders so clearing a field never blanks a NOT NULL column.

create or replace function public.reschedule_reservation_group(p_patches jsonb)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  patch jsonb;
begin
  -- Phase 1 — vacate the villa and apply the new dates + edited fields.
  for patch in select value from jsonb_array_elements(p_patches)
  loop
    update public.reservations r set
      room_id   = null,
      check_in  = coalesce((patch->>'check_in')::date,  r.check_in),
      check_out = coalesce((patch->>'check_out')::date, r.check_out),
      guest_first_name = case when patch ? 'guest_first_name'
                              then patch->>'guest_first_name' else r.guest_first_name end,
      guest_last_name  = case when patch ? 'guest_last_name'
                              then patch->>'guest_last_name'  else r.guest_last_name  end,
      guest_phone      = case when patch ? 'guest_phone'
                              then patch->>'guest_phone'      else r.guest_phone      end,
      adults    = case when patch ? 'adults'
                       then (patch->>'adults')::integer else r.adults end,
      kids_ages = case when patch ? 'kids_ages'
                       then coalesce(
                              (select array_agg(age::integer order by ord)
                                 from jsonb_array_elements_text(patch->'kids_ages')
                                 with ordinality as elems(age, ord)),
                              '{}'::integer[])
                       else r.kids_ages end,
      notes     = case when patch ? 'notes'
                       then nullif(patch->>'notes', '') else r.notes end
    where r.id = (patch->>'id')::uuid
      and r.cancelled_at is null
      and r.payment_status in ('pending', 'paid');
  end loop;

  -- Phase 2 — assign each row its planned room. The only conflicts the exclusion
  -- constraint can now raise are against OTHER bookings (a concurrent grab), which
  -- aborts the statement and rolls back the whole move.
  for patch in select value from jsonb_array_elements(p_patches)
  loop
    update public.reservations r set
      room_id = (patch->>'room_id')::uuid
    where r.id = (patch->>'id')::uuid
      and r.cancelled_at is null
      and r.payment_status in ('pending', 'paid');
  end loop;
end;
$$;

-- Only the Edge runtime (service role) may call this. Revoking from PUBLIC also
-- strips service_role's inherited EXECUTE, so the grant must be explicit (same
-- pattern as public.rate_limit_hit, ADR-060). Keeping it off the anon/authenticated
-- PostgREST surface prevents any logged-in client from bypassing the function's
-- auth + availability planning by calling the raw mover.
revoke all on function public.reschedule_reservation_group(jsonb)
  from public, anon, authenticated;
grant execute on function public.reschedule_reservation_group(jsonb)
  to service_role;
