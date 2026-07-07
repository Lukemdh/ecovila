import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, requireSharedSecret } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  findOnlineReservationsForBookingGroup,
  markPaymentManualReview,
  markPaymentProcessed,
  settleBookingGroupAsPaid,
} from '../_shared/bookingSettlement.ts';
import { sendStaffAlert } from '../_shared/alerts.ts';
import {
  composeExpiredCashCancellation,
  dispatchScheduledNotificationOnce,
  mapNotificationOwners,
} from '../_shared/notifications.ts';
import { withRoomFields } from '../_shared/reservations.ts';
import type { NotificationReservation } from '../_shared/notifications.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
  lt(column: string, value: unknown): QueryBuilder<T>;
};

// A card hold whose most recent payment attempt began within this window is not
// abandoned — the guest may be mid-payment on the gateway and the capture can
// land a moment after the five-minute hold elapses. Because maib-create-payment
// returns 410 for any attempt after the hold, no attempt timestamp can ever be
// newer than the hold deadline, so this grace is bounded (max ≈ hold + 1min) and
// cannot be chained. See ADR-031.
const ATTEMPT_GRACE_MINUTES = 1;

// Every cancellation below re-asserts `payment_status = 'pending'` inside the
// UPDATE itself: a payment confirmed between this cron's SELECT and UPDATE
// (Maib callback or staff confirmation) must never be flipped to cancelled.
async function cancelPendingReservations(
  client: SupabaseClient,
  ids: string[],
  values: Record<string, unknown>,
) {
  if (!ids.length) {
    return [];
  }

  const { data, error } = await table<ReservationIdRow[]>(client, 'reservations')
    .update(values)
    .in('id', ids)
    .eq('payment_status', 'pending')
    .is('cancelled_at', null)
    .select('id');

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map((reservation) => reservation.id);
}

type RoomJoin = {
  number?: number | string | null;
  type?: string | null;
};

type ExpirableReservationRow = NotificationReservation & {
  booking_group_id: string;
  room_id?: string | null;
  rooms?: RoomJoin | RoomJoin[] | null;
};

type ReservationIdRow = {
  id: string;
};

type CardHoldRow = {
  id: string;
  booking_group_id: string;
};

type PaymentGroupRow = {
  booking_group_id: string;
};

type MaibSessionExpiryResult = {
  expired: number;
  reservationIds: string[];
  orphaned: number;
};

type NotificationDispatchResult = Awaited<ReturnType<typeof dispatchScheduledNotificationOnce>>;

type NotificationResult = {
  reservationId: string;
  sent: boolean;
  skipped_duplicate?: boolean;
  abandoned?: boolean;
  retry_pending?: boolean;
  result?: NotificationDispatchResult['result'];
  error?: string;
};

const CARD_PAYMENT_START_GRACE_MINUTES = 15;

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST', 'GET']);
    requireSharedSecret(request);

    const client = createServiceClient();
    const now = new Date().toISOString();
    const { data: expiredReservations, error: selectError } = await table<
      ExpirableReservationRow[]
    >(client, 'reservations')
      .select(
        'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, rooms(number, type)',
      )
      .eq('payment_type', 'cash')
      .eq('payment_status', 'pending')
      .is('cancelled_at', null)
      .lt('cash_expires_at', now);

    if (selectError) {
      throw new Error(selectError.message);
    }

    const reservations = (expiredReservations || []).map(withRoomFields);
    const cancelledIds = await cancelPendingReservations(
      client,
      reservations.map((reservation) => reservation.id),
      {
        payment_status: 'cancelled',
        cancelled_at: now,
        cancellation_reason: 'cash_expired',
      },
    );
    const cancelledIdSet = new Set(cancelledIds);
    const cancelledReservations = reservations.filter((reservation) =>
      cancelledIdSet.has(reservation.id)
    );

    const notificationResults = await notifyExpiredReservations(client, cancelledReservations);
    // Backstop BEFORE releasing holds: a payment MAIB confirmed but whose
    // settlement crashed mid-way must settle here, not be expired below.
    const settledBackstop = await settleUnprocessedPaidPayments(client, now);
    const expiredMaibSessions = await expireStaleMaibSessions(client, now);

    return jsonResponse(
      {
        expired: cancelledIds.length,
        reservationIds: cancelledIds,
        notificationResults,
        settledBackstop,
        expiredMaibSessions,
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function expireStaleMaibSessions(
  client: SupabaseClient,
  now: string,
): Promise<MaibSessionExpiryResult> {
  const expiredInFlightIds = await expireInFlightMaibSessions(client, now);
  const orphanedIds = await expireUnstartedCardReservations(client, now);
  await expireStaleMaibPaymentRows(client, now);

  return {
    expired: expiredInFlightIds.length + orphanedIds.length,
    reservationIds: [...expiredInFlightIds, ...orphanedIds],
    orphaned: orphanedIds.length,
  };
}

// Crash-recovery backstop (ADR-089): both rails stamp maib_payments 'paid'
// BEFORE settling and processed_at only AFTER. A row stuck paid-but-unprocessed
// means the settlement died mid-way — finish it here (settlement is idempotent;
// the reinstate path undoes a premature expiry). The 2-minute grace skips rows
// whose settlement is genuinely still in flight.
const UNPROCESSED_PAID_GRACE_MINUTES = 2;

async function settleUnprocessedPaidPayments(client: SupabaseClient, now: string) {
  const threshold = new Date(
    new Date(now).getTime() - UNPROCESSED_PAID_GRACE_MINUTES * 60 * 1000,
  ).toISOString();
  const { data, error } = await table<Array<{ pay_id: string; booking_group_id: string }>>(
    client,
    'maib_payments',
  )
    .select('pay_id, booking_group_id')
    .eq('status', 'paid')
    .eq('manual_review', false)
    .is('processed_at', null)
    .lt('updated_at', threshold);

  if (error) {
    throw new Error(error.message);
  }

  const results: Array<{ payId: string; matched: number; requiresManualReview: boolean }> = [];

  for (const payment of data || []) {
    try {
      const reservations = await findOnlineReservationsForBookingGroup(
        client,
        payment.booking_group_id,
      );
      const settlement = await settleBookingGroupAsPaid(client, {
        bookingGroupId: payment.booking_group_id,
        reservations,
        now: new Date().toISOString(),
        source: 'expire-cron-backstop',
      });

      if (settlement.requiresManualReview) {
        const transitioned = await markPaymentManualReview(client, payment.pay_id);
        if (transitioned) {
          await sendStaffAlert('Plată încasată fără rezervare — restituire manuală', [
            `Plata ${payment.pay_id} (booking group ${payment.booking_group_id}) este`,
            `confirmată de MAIB, dar nicio rezervare nu a putut fi confirmată nici la`,
            `reluarea automată. Oaspetele a plătit fără să aibă cazare — restituie plata`,
            `din CRM și contactează-l.`,
          ]).catch((alertError) => console.error('Backstop alert failed', alertError));
        }
      } else {
        await markPaymentProcessed(client, payment.pay_id, new Date().toISOString());
      }

      results.push({
        payId: payment.pay_id,
        matched: settlement.matched,
        requiresManualReview: settlement.requiresManualReview,
      });
    } catch (settleError) {
      console.error('Backstop settlement failed', {
        payId: payment.pay_id,
        message: settleError instanceof Error ? settleError.message : 'settle failed',
      });
    }
  }

  return results;
}

async function findGroupsWithRecentPaymentAttempt(client: SupabaseClient, now: string) {
  const threshold = new Date(
    new Date(now).getTime() - ATTEMPT_GRACE_MINUTES * 60 * 1000,
  ).toISOString();
  const { data, error } = await table<PaymentGroupRow[]>(client, 'maib_payments')
    .select('booking_group_id')
    .in('status', ['created', 'pending'])
    .gt('created_at', threshold);

  if (error) {
    throw new Error(error.message);
  }

  return new Set((data || []).map((payment) => payment.booking_group_id));
}

async function expireInFlightMaibSessions(client: SupabaseClient, now: string) {
  const { data, error: selectError } = await table<CardHoldRow[]>(client, 'reservations')
    .select('id, booking_group_id')
    .eq('payment_type', 'card')
    .eq('payment_status', 'pending')
    .eq('payment_in_progress', true)
    .is('cancelled_at', null)
    .lt('payment_session_expires_at', now);

  if (selectError) {
    throw new Error(selectError.message);
  }

  const candidates = data || [];
  if (!candidates.length) {
    return [];
  }

  // Spare any booking group whose guest opened a fresh checkout within the grace
  // window — their in-flight payment gets that extra minute to land.
  const protectedGroups = await findGroupsWithRecentPaymentAttempt(client, now);
  const expirableIds = candidates
    .filter((reservation) => !protectedGroups.has(reservation.booking_group_id))
    .map((reservation) => reservation.id);

  return await cancelPendingReservations(client, expirableIds, {
    payment_status: 'cancelled',
    payment_in_progress: false,
    payment_session_expires_at: null,
    cancelled_at: now,
    cancellation_reason: 'maib_session_expired',
  });
}

// Retire expired maib_payments session rows. Runs on every tick (not only when
// a reservation expired the same minute) and spares rows inside the attempt
// grace so a group whose guest is mid-payment isn't shown "expired" a minute
// early. Never touches paid/refunded rows.
async function expireStaleMaibPaymentRows(client: SupabaseClient, now: string) {
  const graceThreshold = new Date(
    new Date(now).getTime() - ATTEMPT_GRACE_MINUTES * 60 * 1000,
  ).toISOString();
  const { error } = await table(client, 'maib_payments')
    .update({
      status: 'cancelled',
      updated_at: now,
    })
    .in('status', ['created', 'pending'])
    .lt('expires_at', now)
    .lt('created_at', graceThreshold);

  if (error) {
    throw new Error(error.message);
  }
}

async function expireUnstartedCardReservations(client: SupabaseClient, now: string) {
  const graceThreshold = new Date(
    new Date(now).getTime() - CARD_PAYMENT_START_GRACE_MINUTES * 60 * 1000,
  ).toISOString();
  const { data, error: selectError } = await table<ReservationIdRow[]>(client, 'reservations')
    .select('id')
    .eq('payment_type', 'card')
    .eq('payment_status', 'pending')
    .eq('payment_in_progress', false)
    .is('cancelled_at', null)
    .lt('created_at', graceThreshold);

  if (selectError) {
    throw new Error(selectError.message);
  }

  return await cancelPendingReservations(
    client,
    (data || []).map((reservation) => reservation.id),
    {
      payment_status: 'cancelled',
      payment_session_expires_at: null,
      cancelled_at: now,
      cancellation_reason: 'maib_payment_not_started',
    },
  );
}

async function notifyExpiredReservations(
  client: SupabaseClient,
  reservations: ExpirableReservationRow[],
) {
  const results: NotificationResult[] = [];
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
      const message = composeExpiredCashCancellation(reservationForNotification(reservation), {
        groupReservations: group.map(reservationForNotification),
      });
      const result = await dispatchScheduledNotificationOnce(
        client,
        reservation.id,
        'cash_expired',
        message,
      );
      results.push({
        reservationId: reservation.id,
        ...result,
        skipped_duplicate: result.skipped_duplicate,
      });
    } catch (error) {
      console.error('Expired cash notification failed', error);
      results.push({
        reservationId: reservation.id,
        sent: false,
        error: error instanceof Error ? error.message : 'Notification failed.',
      });
    }
  }

  return results;
}

function reservationForNotification(reservation: ExpirableReservationRow): NotificationReservation {
  return {
    ...reservation,
    guest_language: reservation.guest_language || undefined,
  };
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
