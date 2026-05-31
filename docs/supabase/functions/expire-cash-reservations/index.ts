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
  lt(column: string, value: unknown): QueryBuilder<T>;
};

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
    const ids = reservations.map((reservation) => reservation.id);

    if (ids.length) {
      const { error: updateError } = await table(client, 'reservations')
        .update({
          payment_status: 'cancelled',
          cancelled_at: now,
          cancellation_reason: 'cash_expired',
        })
        .in('id', ids);

      if (updateError) {
        throw new Error(updateError.message);
      }
    }

    const notificationResults = await notifyExpiredReservations(client, reservations);
    const expiredMaibSessions = await expireStaleMaibSessions(client, now);

    return jsonResponse({
      expired: ids.length,
      reservationIds: ids,
      notificationResults,
      expiredMaibSessions,
    });
  } catch (error) {
    return errorResponse(error);
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

async function expireInFlightMaibSessions(client: SupabaseClient, now: string) {
  const { data, error: selectError } = await table<ReservationIdRow[]>(client, 'reservations')
    .select('id')
    .eq('payment_type', 'card')
    .eq('payment_status', 'pending')
    .eq('payment_in_progress', true)
    .is('cancelled_at', null)
    .lt('payment_session_expires_at', now);

  if (selectError) {
    throw new Error(selectError.message);
  }

  const ids = (data || []).map((reservation) => reservation.id);

  if (!ids.length) {
    return [];
  }

  const { error: updateError } = await table(client, 'reservations')
    .update({
      payment_status: 'cancelled',
      payment_in_progress: false,
      payment_session_expires_at: null,
      cancelled_at: now,
      cancellation_reason: 'maib_session_expired',
    })
    .in('id', ids);

  if (updateError) {
    throw new Error(updateError.message);
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

  const ids = (data || []).map((reservation) => reservation.id);

  if (!ids.length) {
    return [];
  }

  const { error: updateError } = await table(client, 'reservations')
    .update({
      payment_status: 'cancelled',
      payment_session_expires_at: null,
      cancelled_at: now,
      cancellation_reason: 'maib_payment_not_started',
    })
    .in('id', ids);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return ids;
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
