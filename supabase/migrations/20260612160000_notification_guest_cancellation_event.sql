-- reservation-cancel records guest-initiated cancellations as 'guest_cancellation',
-- which the original check constraint did not allow, so those notification inserts
-- failed and guest cancellation SMS/emails were never sent.
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
      'arrival_24h'
    )
  );
