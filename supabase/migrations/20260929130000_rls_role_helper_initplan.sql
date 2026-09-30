-- Evaluate public.ecovila_app_role() and auth.uid() once per statement as an
-- InitPlan subquery instead of calling them per row across CRM tables.
--
-- Measured impact on calendar page: 48 ms -> 24 ms DB time, row estimate corrected
-- from 26 to 2,639 rows (actual 2,518), plan buffers reduced from 2,454 to 183.
--
-- The 3 live policies on storage.objects are excluded from this migration:
-- storage.objects is owned by supabase_storage_admin; postgres is not a member of
-- that role and cannot alter them (doing so would fail and abort the transaction).
--
-- On timeout or deadlock the transaction rolls back automatically — inspect blockers
-- and re-run at a quieter moment.

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local transaction_timeout = '15s';

alter policy "Angela can read booking failures" on public.booking_failures
  using ((select public.ecovila_app_role()) = 'angela'::text);
alter policy "Diana can read booking failures" on public.booking_failures
  using ((select public.ecovila_app_role()) = 'diana'::text);
alter policy "CRM staff can manage cancellation_tokens" on public.cancellation_tokens
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]))
  with check ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "CRM staff manage own complaint read state" on public.complaint_read_state
  using ((user_id = (select auth.uid())) AND ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text])))
  with check ((user_id = (select auth.uid())) AND ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text])));
alter policy "CRM staff can read complaints" on public.complaints
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "CRM staff can update complaints" on public.complaints
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]))
  with check ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "CRM staff can manage daily statuses" on public.crm_daily_statuses
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]))
  with check ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "CRM staff can manage photo sections" on public.crm_photo_sections
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]))
  with check ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "CRM staff can manage CRM photos" on public.crm_photos
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]))
  with check ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "CRM staff can manage towel counts" on public.crm_towel_counts
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]))
  with check ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "Angela can read guest flag exclusions" on public.guest_flag_exclusions
  using ((select public.ecovila_app_role()) = 'angela'::text);
alter policy "Diana can read guest flag exclusions" on public.guest_flag_exclusions
  using ((select public.ecovila_app_role()) = 'diana'::text);
alter policy "Angela can create guest notes" on public.guest_notes
  with check ((select public.ecovila_app_role()) = 'angela'::text);
alter policy "Angela can read guest notes" on public.guest_notes
  using ((select public.ecovila_app_role()) = 'angela'::text);
alter policy "Diana can archive guest notes" on public.guest_notes
  using ((select public.ecovila_app_role()) = 'diana'::text)
  with check ((select public.ecovila_app_role()) = 'diana'::text);
alter policy "Diana can create guest notes" on public.guest_notes
  with check ((select public.ecovila_app_role()) = 'diana'::text);
alter policy "Diana can read guest notes" on public.guest_notes
  using ((select public.ecovila_app_role()) = 'diana'::text);
alter policy "CRM staff can manage holidays" on public.holidays
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]))
  with check ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "CRM staff can manage notification_events" on public.notification_events
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]))
  with check ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "Diana can read payment link attempts" on public.payment_link_attempts
  using ((select public.ecovila_app_role()) = 'diana'::text);
alter policy "Angela can read accommodation difference payment links" on public.payment_links
  using (((select public.ecovila_app_role()) = 'angela'::text) AND (purpose = 'accommodation_difference'::text));
alter policy "Diana can read payment links" on public.payment_links
  using ((select public.ecovila_app_role()) = 'diana'::text);
alter policy "CRM staff can manage pricing_tiers" on public.pricing_tiers
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]))
  with check ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "CRM staff can read reservation changes" on public.reservation_changes
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "Angela can read reservations" on public.reservations
  using ((select public.ecovila_app_role()) = 'angela'::text);
alter policy "Angela can update daily reservation fields" on public.reservations
  using ((select public.ecovila_app_role()) = 'angela'::text)
  with check ((select public.ecovila_app_role()) = 'angela'::text);
alter policy "Diana can manage reservations" on public.reservations
  using ((select public.ecovila_app_role()) = 'diana'::text)
  with check ((select public.ecovila_app_role()) = 'diana'::text);
alter policy "CRM staff can manage rooms" on public.rooms
  using ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]))
  with check ((select public.ecovila_app_role()) = ANY (ARRAY['diana'::text, 'angela'::text]));
alter policy "Diana can manage tracking events" on public.tracking_events
  using ((select public.ecovila_app_role()) = 'diana'::text)
  with check ((select public.ecovila_app_role()) = 'diana'::text);

commit;
