import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, requireSharedSecret } from '../_shared/http.ts';
import { getSiteUrl } from '../_shared/env.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  composeArrivalReminder,
  composeCashExpiryReminder,
  dispatchAndRecordNotification,
} from '../_shared/notifications.ts';
import { withRoomFields } from '../_shared/reservations.ts';

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

    return jsonResponse({
      cashWarnings,
      arrivalReminders,
    });
  } catch (error) {
    return errorResponse(error);
  }
});

async function sendCashExpiryWarnings(client: any, now: Date) {
  const windowStart = new Date(now.getTime() + 4 * 60 * 1000).toISOString();
  const windowEnd = new Date(now.getTime() + 6 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from('reservations')
    .select(
      'id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, check_in, check_out, total_price, payment_type, rooms(number, type)',
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
    (reservation) => composeCashExpiryReminder(reservation, { siteUrl: getSiteUrl() }),
  );
}

async function sendArrivalReminders(client: any, now: Date) {
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  )).toISOString().slice(0, 10);
  const { data, error } = await client
    .from('reservations')
    .select(
      'id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, check_in, check_out, total_price, payment_type, rooms(number, type)',
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
  client: any,
  reservations: any[],
  eventType: string,
  createMessage: (reservation: any) => ReturnType<typeof composeArrivalReminder>,
) {
  const results = [];

  for (const reservation of reservations) {
    try {
      await dispatchAndRecordNotification(
        client,
        reservation.id,
        eventType,
        createMessage(reservation),
      );
      results.push({ reservationId: reservation.id, sent: true });
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
