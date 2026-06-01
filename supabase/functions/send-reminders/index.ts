import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, requireSharedSecret } from '../_shared/http.ts';
import { getSiteUrl } from '../_shared/env.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  composeArrivalReminder,
  composeCashExpiryReminder,
  dispatchScheduledNotificationOnce,
} from '../_shared/notifications.ts';
import { withRoomFields } from '../_shared/reservations.ts';
import type { NotificationMessage, NotificationReservation } from '../_shared/notifications.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  gte(column: string, value: unknown): QueryBuilder<T>;
  lte(column: string, value: unknown): QueryBuilder<T>;
};

type RoomJoin = {
  number?: number | string | null;
  type?: string | null;
};

type ReminderReservationRow = NotificationReservation & {
  room_id?: string | null;
  rooms?: RoomJoin | RoomJoin[] | null;
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

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST', 'GET']);
    requireSharedSecret(request);

    const client = createServiceClient();
    const now = new Date();
    const [cashWarnings, arrivalReminders] = await Promise.all([
      sendCashExpiryWarnings(client, now),
      sendArrivalReminders(client, now),
    ]);

    return jsonResponse(
      {
        cashWarnings,
        arrivalReminders,
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function sendCashExpiryWarnings(client: SupabaseClient, now: Date) {
  const windowStart = new Date(now.getTime() + 4 * 60 * 1000).toISOString();
  const windowEnd = new Date(now.getTime() + 6 * 60 * 1000).toISOString();
  const { data, error } = await table<ReminderReservationRow[]>(client, 'reservations')
    .select(
      'id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, rooms(number, type)',
    )
    .eq('payment_type', 'cash')
    .eq('payment_status', 'pending')
    .is('cancelled_at', null)
    .gte('cash_expires_at', windowStart)
    .lte('cash_expires_at', windowEnd);

  if (error) {
    throw new Error(error.message);
  }

  return notifyEach(
    client,
    (data || []).map(withRoomFields),
    'cash_expiry_warning',
    (reservation) =>
      composeCashExpiryReminder(reservationForNotification(reservation), { siteUrl: getSiteUrl() }),
  );
}

async function sendArrivalReminders(client: SupabaseClient, now: Date) {
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  )).toISOString().slice(0, 10);
  const { data, error } = await table<ReminderReservationRow[]>(client, 'reservations')
    .select(
      'id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, rooms(number, type)',
    )
    .eq('payment_status', 'paid')
    .is('cancelled_at', null)
    .eq('check_in', tomorrow);

  if (error) {
    throw new Error(error.message);
  }

  return notifyEach(
    client,
    (data || []).map(withRoomFields),
    'arrival_24h',
    composeArrivalReminder,
  );
}

async function notifyEach(
  client: SupabaseClient,
  reservations: ReminderReservationRow[],
  eventType: string,
  createMessage: (reservation: ReminderReservationRow) => NotificationMessage,
) {
  const results: NotificationResult[] = [];

  for (const reservation of reservations) {
    try {
      const result = await dispatchScheduledNotificationOnce(
        client,
        reservation.id,
        eventType,
        createMessage(reservation),
      );
      results.push({
        reservationId: reservation.id,
        ...result,
        skipped_duplicate: result.skipped_duplicate,
      });
    } catch (error) {
      console.error(`${eventType} notification failed`, error);
      results.push({
        reservationId: reservation.id,
        sent: false,
        error: error instanceof Error ? error.message : 'Notification failed.',
      });
    }
  }

  return results;
}

function reservationForNotification(reservation: ReminderReservationRow): NotificationReservation {
  return {
    ...reservation,
    guest_language: reservation.guest_language || undefined,
  };
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
