// Shared booking-settlement core used by both online payment rails (card
// Checkout callback and MIA QR confirmation). Once a rail has independently
// established that a booking group is paid, this module performs the identical,
// idempotent follow-up: flip pending reservations to paid, reinstate holds the
// expiry cron released while the guest was mid-payment, then send the
// confirmation notification and fire purchase tracking exactly once.
import { getSiteUrl } from './env.ts';
import { sendEmail, sendSms } from './providers.ts';
import { buildManageTokenRow } from './reservationManage.ts';
import {
  bookingConfirmationSms,
  buildConfirmationEmail,
  mapNotificationOwners,
  normalizeEmailLang,
  titleCaseName,
} from './notifications.ts';
import { dispatchPurchaseTrackingOnce } from './tracking.ts';
import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  single(): Promise<SupabaseQueryResult<T>>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type ReservationRoomJoin = {
  number?: number | string | null;
  type?: string | null;
};

type RawPaymentReservationRow = {
  id: string;
  booking_group_id: string;
  room_id?: string | null;
  guest_first_name: string;
  guest_last_name: string;
  guest_phone: string;
  guest_email: string;
  guest_language?: string | null;
  check_in: string;
  check_out: string;
  total_price: number | string;
  payment_type: string;
  payment_status: string;
  rooms?: ReservationRoomJoin | ReservationRoomJoin[] | null;
  room_number?: number | string | null;
  room_type?: string | null;
  tracking_event_id?: string | null;
  tracking_fbp?: string | null;
  tracking_fbc?: string | null;
  tracking_user_agent?: string | null;
  tracking_source_url?: string | null;
};

export type PaymentReservationRow = Omit<RawPaymentReservationRow, 'rooms'> & {
  room_number?: number;
  room_type?: string | null;
};

type CancellationTokenRow = {
  reservation_id?: string;
  token?: string | null;
};

type NotificationEventRow = {
  id: string;
};

type ReservationIdRow = {
  id: string;
};

type PaymentConfirmationDispatchResult = {
  sent: boolean;
  skipped_duplicate?: boolean;
  error?: string;
};

export type PaymentConfirmationNotificationResult = PaymentConfirmationDispatchResult & {
  reservationId: string;
};

export type BookingSettlementResult = {
  matched: number;
  reinstated: number;
  requiresManualReview: boolean;
  notificationResults: PaymentConfirmationNotificationResult[];
  trackingResult: unknown;
};

const RESERVATION_COLUMNS =
  'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, payment_status, tracking_event_id, tracking_fbp, tracking_fbc, tracking_user_agent, tracking_source_url, rooms(number, type)';

// Cancellation reasons stamped by the expiry cron. Only these may be undone by
// a late paid result — guest- or staff-cancelled bookings stay cancelled.
const REINSTATABLE_CANCELLATION_REASONS = ['maib_session_expired', 'maib_payment_not_started'];

export async function findOnlineReservationsForBookingGroup(
  client: SupabaseClient,
  bookingGroupId: string,
): Promise<PaymentReservationRow[]> {
  // Both rails create reservations with payment_type 'card' (the rail itself is
  // tracked only on maib_payments), so this lookup serves card and MIA alike.
  const { data, error } = await table<RawPaymentReservationRow[]>(client, 'reservations')
    .select(RESERVATION_COLUMNS)
    .eq('booking_group_id', bookingGroupId)
    .eq('payment_type', 'card')
    .in('payment_status', ['pending', 'paid'])
    .is('cancelled_at', null);

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map(withRoomFields);
}

/**
 * Flip a paid booking group's reservations to settled, reinstate any holds the
 * expiry cron released while the guest was paying, then notify + track once.
 * The caller is responsible for proving the booking is actually paid first.
 */
export async function settleBookingGroupAsPaid(
  client: SupabaseClient,
  input: {
    bookingGroupId: string;
    reservations: PaymentReservationRow[];
    now: string;
    source: string;
  },
): Promise<BookingSettlementResult> {
  const { bookingGroupId, reservations, now, source } = input;

  const settledIds = new Set(
    reservations
      .filter((reservation) => reservation.payment_status === 'paid')
      .map((reservation) => reservation.id),
  );
  const pendingIds = reservations
    .filter((reservation) => reservation.payment_status === 'pending')
    .map((reservation) => reservation.id);

  if (pendingIds.length) {
    const { data: updatedRows, error } = await table<ReservationIdRow[]>(client, 'reservations')
      .update({
        payment_status: 'paid',
        cash_expires_at: null,
        payment_in_progress: false,
        payment_session_expires_at: null,
        paid_at: now,
      })
      .in('id', pendingIds)
      .eq('payment_status', 'pending')
      .is('cancelled_at', null)
      .select('id');

    if (error) {
      throw new Error(error.message);
    }

    for (const row of updatedRows || []) {
      settledIds.add(row.id);
    }
  }

  // The expiry cron may have released the hold while the guest was still paying.
  // The money is captured, so the booking is reinstated when the room is still
  // free; otherwise it stays cancelled and the failure is logged for a manual
  // refund.
  const reinstated = await reinstateExpiredOnlineReservations(client, bookingGroupId, now);
  const paidReservations = [
    ...reservations.filter((reservation) => settledIds.has(reservation.id)),
    ...reinstated,
  ];

  if (!paidReservations.length) {
    return {
      matched: 0,
      reinstated: reinstated.length,
      requiresManualReview: true,
      notificationResults: [],
      trackingResult: null,
    };
  }

  const [notificationResults, trackingResult] = await Promise.all([
    notifyPaidReservations(client, paidReservations, source),
    dispatchPurchaseTrackingOnce(client, paidReservations, { source }),
  ]);

  return {
    matched: paidReservations.length,
    reinstated: reinstated.length,
    requiresManualReview: false,
    notificationResults,
    trackingResult,
  };
}

async function reinstateExpiredOnlineReservations(
  client: SupabaseClient,
  bookingGroupId: string,
  now: string,
): Promise<PaymentReservationRow[]> {
  const { data, error } = await table<RawPaymentReservationRow[]>(client, 'reservations')
    .select(RESERVATION_COLUMNS)
    .eq('booking_group_id', bookingGroupId)
    .eq('payment_type', 'card')
    .eq('payment_status', 'cancelled')
    .in('cancellation_reason', REINSTATABLE_CANCELLATION_REASONS);

  if (error) {
    throw new Error(error.message);
  }

  const cancelled = data || [];
  if (!cancelled.length) {
    return [];
  }

  const ids = cancelled.map((reservation) => reservation.id);
  const { data: reinstatedRows, error: updateError } = await table<ReservationIdRow[]>(
    client,
    'reservations',
  )
    .update({
      payment_status: 'paid',
      cancelled_at: null,
      cancellation_reason: null,
      cash_expires_at: null,
      payment_in_progress: false,
      payment_session_expires_at: null,
      paid_at: now,
    })
    .in('id', ids)
    .eq('payment_status', 'cancelled')
    .in('cancellation_reason', REINSTATABLE_CANCELLATION_REASONS)
    .select('id');

  if (updateError) {
    // Most likely the room was rebooked after the hold expired, so the overlap
    // exclusion constraint rejected the reinstate. The guest's charge has no
    // booking behind it and must be refunded by hand.
    console.error(
      'Paid result could not reinstate expired reservations — manual refund required',
      { bookingGroupId, reservationIds: ids, message: updateError.message },
    );
    return [];
  }

  const reinstatedIds = new Set((reinstatedRows || []).map((row) => row.id));
  return cancelled
    .filter((reservation) => reinstatedIds.has(reservation.id))
    .map((reservation) => withRoomFields({ ...reservation, payment_status: 'paid' }));
}

async function notifyPaidReservations(
  client: SupabaseClient,
  reservations: PaymentReservationRow[],
  source: string,
) {
  const results: PaymentConfirmationNotificationResult[] = [];
  const siteUrl = getSiteUrl();
  // One notification per booking group: the owner reservation sends the SMS and
  // an email that lists every villa; the rest of the group is skipped.
  const ownerGroups = mapNotificationOwners(reservations);

  for (const reservation of reservations) {
    const group = ownerGroups.get(reservation.id);
    if (!group) {
      results.push({ reservationId: reservation.id, sent: false, skipped_duplicate: true });
      continue;
    }

    try {
      let token = await findCancellationToken(client, reservation.id);
      if (!token) {
        const { data, error } = await table<CancellationTokenRow>(client, 'cancellation_tokens')
          .insert([{ reservation_id: reservation.id, token: createSecureToken() }])
          .select('reservation_id, token')
          .single();

        if (error) {
          throw new Error(error.message);
        }

        token = data?.token || '';
      }

      const result = await dispatchPaymentConfirmationOnce(
        client,
        reservation,
        group,
        token,
        siteUrl,
        source,
      );
      results.push({ reservationId: reservation.id, ...result });
    } catch (error) {
      console.error('Payment confirmation notification failed', error);
      results.push({
        reservationId: reservation.id,
        sent: false,
        error: error instanceof Error ? error.message : 'Notification failed.',
      });
    }
  }

  return results;
}

async function dispatchPaymentConfirmationOnce(
  client: SupabaseClient,
  reservation: PaymentReservationRow,
  groupReservations: PaymentReservationRow[],
  cancellationToken: string,
  siteUrl: string,
  source: string,
): Promise<PaymentConfirmationDispatchResult> {
  const now = new Date().toISOString();
  const { data, error } = await table<NotificationEventRow>(client, 'notification_events')
    .insert({
      reservation_id: reservation.id,
      event_type: 'payment_confirmation',
      provider: 'edge',
      delivery_status: 'reserved',
      attempt_count: 1,
      attempted_at: now,
      metadata: { source },
    })
    .select('id')
    .single();

  if (error?.code === '23505') {
    return { sent: false, skipped_duplicate: true };
  }

  if (error) {
    throw new Error(error.message);
  }
  if (!data?.id) {
    throw new Error('Notification event reservation did not return an id.');
  }

  const manageToken = await createManageTokenForNotification(client, reservation.guest_phone);
  const message = composePaymentConfirmation(
    reservation,
    groupReservations,
    cancellationToken,
    siteUrl,
    manageToken,
  );
  const providerResponse: Record<string, unknown> = {};
  const errors = [];

  try {
    providerResponse.sms = await sendSms({ to: reservation.guest_phone, message: message.sms });
  } catch (error) {
    errors.push(`SMS: ${error instanceof Error ? error.message : 'failed'}`);
  }

  try {
    providerResponse.email = await sendEmail({
      to: reservation.guest_email,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  } catch (error) {
    errors.push(`Email: ${error instanceof Error ? error.message : 'failed'}`);
  }

  const smsSent = !errors.some((entry) => entry.startsWith('SMS:'));
  const completedAt = new Date().toISOString();
  const { error: updateError } = await table(client, 'notification_events')
    .update({
      delivery_status: smsSent ? 'sent' : 'failed',
      sent_at: smsSent ? completedAt : null,
      completed_at: completedAt,
      last_error: errors.length ? errors.join(' | ') : null,
      provider_response: providerResponse,
    })
    .eq('id', data.id);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return {
    sent: smsSent,
    skipped_duplicate: false,
    error: errors.length ? errors.join(' | ') : undefined,
  };
}

async function createManageTokenForNotification(client: SupabaseClient, phone: string) {
  const manageToken = await buildManageTokenRow(phone);
  const { error } = await table(client, 'reservation_manage_tokens')
    .insert(manageToken.row);

  if (error) {
    throw new Error(error.message || 'Could not create reservation manage token.');
  }

  return manageToken.token;
}

async function findCancellationToken(client: SupabaseClient, reservationId: string) {
  const { data, error } = await table<CancellationTokenRow>(client, 'cancellation_tokens')
    .select('token')
    .eq('reservation_id', reservationId)
    .eq('used', false)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data?.token || '';
}

function withRoomFields(reservation: RawPaymentReservationRow): PaymentReservationRow {
  const room = Array.isArray(reservation.rooms) ? reservation.rooms[0] : reservation.rooms;

  return {
    ...reservation,
    room_number: Number(room?.number || reservation.room_number || 0) || undefined,
    room_type: room?.type || reservation.room_type,
  };
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}

function createSecureToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function composePaymentConfirmation(
  reservation: PaymentReservationRow,
  groupReservations: PaymentReservationRow[],
  cancellationToken: string,
  siteUrl: string,
  manageToken: string,
) {
  const lang = normalizeEmailLang(reservation.guest_language);
  // The owner reservation's email represents the whole booking group: every
  // villa is listed and the per-villa prices are summed back to the full total.
  const group = groupReservations.length ? groupReservations : [reservation];
  const roomCopy = aggregateGroupRoomLabel(group, lang);
  const totalPrice = group.reduce((sum, row) => sum + Number(row.total_price || 0), 0);
  const confirmationLink = confirmationUrl(siteUrl, reservation.id, manageToken);
  const cancelLink = `${siteUrl}/anulare.html?token=${encodeURIComponent(cancellationToken)}`;
  const firstName = titleCaseName(reservation.guest_first_name || '');
  const fullName = titleCaseName(
    `${reservation.guest_first_name || ''} ${reservation.guest_last_name || ''}`,
  );
  const sms = bookingConfirmationSms({
    language: lang,
    checkIn: reservation.check_in,
    checkOut: reservation.check_out,
  });

  const email = buildConfirmationEmail({
    lang,
    firstName,
    fullName,
    roomCopy,
    checkIn: reservation.check_in,
    checkOut: reservation.check_out,
    totalPrice,
    confirmationUrl: confirmationLink,
    cancellationUrl: cancelLink,
    siteUrl,
  });

  return {
    sms,
    subject: email.subject,
    text: email.text,
    html: email.html,
  };
}

function confirmationUrl(siteUrl: string, reservationId: string, manageToken: string) {
  const params = new URLSearchParams();
  params.set('id', reservationId);

  if (manageToken) {
    params.set('manage', manageToken);
  }

  return `${siteUrl}/confirmare.html?${params.toString()}`;
}

function roomLabel(reservation: PaymentReservationRow, language: string) {
  if (!reservation.room_number) return 'EcoVila';
  if (language === 'ru') return `Домик #${reservation.room_number}`;
  if (language === 'en') return `Villa #${reservation.room_number}`;
  return `Căsuța #${reservation.room_number}`;
}

// One accommodation line for the whole booking group, e.g. "Căsuța #3, Căsuța #5".
function aggregateGroupRoomLabel(reservations: PaymentReservationRow[], language: string): string {
  const labels = reservations
    .map((reservation) => roomLabel(reservation, language))
    .filter((label) => label !== 'EcoVila');

  if (!labels.length) {
    return 'EcoVila';
  }

  return [...new Set(labels)].join(', ');
}
