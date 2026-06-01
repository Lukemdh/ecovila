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
      with expired_reservations as (
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
