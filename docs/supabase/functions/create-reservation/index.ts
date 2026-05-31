import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, readJson } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import { createReservationsWithTokens } from '../_shared/reservations.ts';
import type { ReservationInput } from '../_shared/reservations.ts';

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

    return jsonResponse({
      primaryReservationId: result.primaryReservationId,
      bookingGroupId: result.bookingGroupId,
      reservationIds: result.reservations.map((reservation) => reservation.id),
      paymentType: result.reservations[0]?.payment_type || '',
      notificationResults: [],
    });
  } catch (error) {
    return errorResponse(error);
  }
});
