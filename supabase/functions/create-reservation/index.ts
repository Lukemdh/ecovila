import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, readJson } from '../_shared/http.ts';
import { getSiteUrl } from '../_shared/env.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import { createReservationsWithTokens, ReservationInput } from '../_shared/reservations.ts';
import {
  composeBookingConfirmation,
  dispatchAndRecordNotification,
} from '../_shared/notifications.ts';

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const reservations = Array.isArray(body?.reservations) ? body.reservations : body;

    const client = createServiceClient();
    const result = await createReservationsWithTokens(client, reservations as ReservationInput[]);
    const notificationResults = await sendBookingConfirmations(client, result);

    return jsonResponse({
      primaryReservationId: result.primaryReservationId,
      bookingGroupId: result.bookingGroupId,
      reservationIds: result.reservations.map((reservation: any) => reservation.id),
      paymentType: result.reservations[0]?.payment_type || '',
      notificationResults,
    });
  } catch (error) {
    return errorResponse(error);
  }
});

async function sendBookingConfirmations(
  client: any,
  result: Awaited<ReturnType<typeof createReservationsWithTokens>>,
) {
  const siteUrl = getSiteUrl();
  const attempts = [];

  for (const reservation of result.reservations) {
    const token = result.cancellationTokens.find((item: any) =>
      item.reservation_id === reservation.id
    );

    if (!token) {
      attempts.push({
        reservationId: reservation.id,
        sent: false,
        error: 'Missing cancellation token.',
      });
      continue;
    }

    try {
      await dispatchAndRecordNotification(
        client,
        reservation.id,
        'booking_confirmation',
        composeBookingConfirmation(reservation, {
          cancellationToken: token.token,
          siteUrl,
        }),
      );
      attempts.push({ reservationId: reservation.id, sent: true });
    } catch (error) {
      console.error('Booking notification failed', error);
      attempts.push({
        reservationId: reservation.id,
        sent: false,
        error: error instanceof Error ? error.message : 'Notification failed.',
      });
    }
  }

  return attempts;
}
