-- ADR-101: the reschedule RPC must refuse to "succeed" over vanished rows.
--
-- reschedule_reservation_group (ADR-087) applied each patch with an UPDATE
-- guarded by `cancelled_at is null and payment_status in ('pending','paid')`
-- and never checked row counts. If a row was cancelled between the Edge
-- Function's read and the RPC call — a guest cancellation, the CRM delete, or
-- (since ADR-100) the hold-expiry cron or a hold release — the UPDATE silently
-- matched zero rows, the RPC returned void, and the Edge Function reported the
-- move as done. The calendar then showed a move that never happened, and for a
-- partially-cancelled group the surviving rows moved while the dead ones kept
-- the old dates.
--
-- Phase 1 now asserts every patch touched exactly one row; a miss raises
-- P0002 (no_data_found), rolling the whole move back — the same all-or-nothing
-- contract the 23P01 path already has. Phase 2 needs no assert of its own
-- (phase 1's UPDATE row-locks every row inside this same transaction, so they
-- cannot disappear before phase 2) but gets one anyway as a cheap invariant.
create or replace function public.reschedule_reservation_group(p_patches jsonb)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  patch jsonb;
  touched integer;
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
    get diagnostics touched = row_count;

    if touched = 0 then
      raise exception
        'Reservation % is no longer active and cannot be moved', patch->>'id'
        using errcode = 'P0002';
    end if;
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
    get diagnostics touched = row_count;

    if touched = 0 then
      raise exception
        'Reservation % vanished mid-move', patch->>'id'
        using errcode = 'P0002';
    end if;
  end loop;
end;
$$;

-- Same grants as ADR-087: service-role only, off the PostgREST client surface.
revoke all on function public.reschedule_reservation_group(jsonb)
  from public, anon, authenticated;
grant execute on function public.reschedule_reservation_group(jsonb)
  to service_role;
