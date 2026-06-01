-- Step 16: remove UUID-only guest confirmation actions.
--
-- The public confirmation page now reads status through the token-backed
-- reservation-manage-details Edge Function and extends/cancels pending cash bookings
-- through token-backed Edge Functions. Remove the legacy anonymous RPC signatures so
-- a leaked confirmare.html?id=<reservation_id> URL is no longer enough to act on a
-- pending reservation.

drop function if exists public.get_pending_reservation_status(uuid);
drop function if exists public.extend_cash_reservation(uuid);
drop function if exists public.cancel_pending_reservation(uuid);

notify pgrst, 'reload schema';
