import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, requireSharedSecret } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  composeExpiredCashCancellation,
  dispatchScheduledNotificationOnce,
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
    const expiredMaibSessions = await expireStaleMaibSessions(client, now);

    return jsonResponse(
      {
        expired: cancelledIds.length,
        reservationIds: cancelledIds,
        notificationResults,
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

  return {
    expired: expiredInFlightIds.length + orphanedIds.length,
    reservationIds: [...expiredInFlightIds, ...orphanedIds],
    orphaned: orphanedIds.length,
  };
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

  const ids = await cancelPendingReservations(client, expirableIds, {
    payment_status: 'cancelled',
    payment_in_progress: false,
    payment_session_expires_at: null,
    cancelled_at: now,
    cancellation_reason: 'maib_session_expired',
  });

  if (!ids.length) {
    return [];
  }

  const { error: paymentUpdateError } = await table(client, 'maib_payments')
    .update({
      status: 'cancelled',
      updated_at: now,
    })
    .in('status', ['created', 'pending'])
    .lt('expires_at', now);

  if (paymentUpdateError) {
    throw new Error(paymentUpdateError.message);
  }

  return ids;
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

  for (const reservation of reservations) {
    try {
      const result = await dispatchScheduledNotificationOnce(
        client,
        reservation.id,
        'cash_expired',
        composeExpiredCashCancellation(reservationForNotification(reservation)),
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
