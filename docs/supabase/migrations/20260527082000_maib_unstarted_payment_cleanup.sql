set search_path = public, extensions;

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'ecovila-expire-maib-sessions'
  ) then
    perform cron.unschedule('ecovila-expire-maib-sessions');
  end if;

  perform cron.schedule(
    'ecovila-expire-maib-sessions',
    '* * * * *',
    $cron$
      with expired_in_flight_reservations as (
        update public.reservations
        set
          payment_status = 'cancelled',
          payment_in_progress = false,
          payment_session_expires_at = null,
          cancelled_at = now(),
          cancellation_reason = 'maib_session_expired'
        where payment_type = 'card'
          and payment_status = 'pending'
          and payment_in_progress = true
          and cancelled_at is null
          and payment_session_expires_at < now()
        returning id
      ),
      unstarted_card_reservations as (
        update public.reservations reservations
        set
          payment_status = 'cancelled',
          payment_session_expires_at = null,
          cancelled_at = now(),
          cancellation_reason = 'maib_payment_not_started'
        where reservations.payment_type = 'card'
          and reservations.payment_status = 'pending'
          and reservations.payment_in_progress = false
          and reservations.cancelled_at is null
          and reservations.created_at < now() - interval '15 minutes'
          and not exists (
            select 1
            from public.maib_payments payments
            where payments.booking_group_id = reservations.booking_group_id
              and payments.status in ('created', 'pending')
              and payments.expires_at > now()
          )
        returning id
      )
      update public.maib_payments
      set
        status = 'cancelled',
        updated_at = now()
      where status in ('created', 'pending')
        and expires_at < now();
    $cron$
  );
end $$;
