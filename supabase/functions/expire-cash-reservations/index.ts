import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, requireSharedSecret } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  composeExpiredCashCancellation,
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
    const now = new Date().toISOString();
    const { data: expiredReservations, error: selectError } = await client
      .from('reservations')
      .select(
        'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, check_in, check_out, total_price, payment_type, rooms(number, type)',
      )
      .eq('payment_type', 'cash')
      .eq('payment_status', 'pending')
      .is('cancelled_at', null)
      .lt('cash_expires_at', now);

    if (selectError) {
      throw new Error(selectError.message);
    }

    const reservations = (expiredReservations || []).map(withRoomFields);
    const ids = reservations.map((reservation: any) => reservation.id);

    if (ids.length) {
      const { error: updateError } = await client
        .from('reservations')
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

    return jsonResponse({
      expired: ids.length,
      reservationIds: ids,
      notificationResults,
    });
  } catch (error) {
    return errorResponse(error);
  }
});

async function notifyExpiredReservations(client: any, reservations: any[]) {
  const results = [];

  for (const reservation of reservations) {
    try {
      await dispatchAndRecordNotification(
        client,
        reservation.id,
        'cash_expired',
        composeExpiredCashCancellation(reservation),
      );
      results.push({ reservationId: reservation.id, sent: true });
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
