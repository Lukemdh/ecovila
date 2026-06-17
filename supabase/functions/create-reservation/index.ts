import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, readJson } from '../_shared/http.ts';
import { buildManageTokenRow } from '../_shared/reservationManage.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import { createReservationsWithTokens } from '../_shared/reservations.ts';
import { assignAutomaticRooms } from '../_shared/roomAssignment.ts';
import { verifyReservationGroupPricing } from '../_shared/pricingGuard.ts';
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
    const result = await createReservationsWithTokens(client, reservations as ReservationInput[], {
      // Best-effort optimization: if auto-assignment fails for any reason, keep
      // the client-supplied room ids so a booking is never lost to it (ADR-054).
      assignRooms: async (rows) => {
        try {
          return await assignAutomaticRooms(client, rows);
        } catch (error) {
          console.error('Room auto-assignment failed; using client room ids', error);
          return rows;
        }
      },
      priceGuard: (rows) => verifyReservationGroupPricing(client, rows),
    });
    const primaryPhone = result.reservations[0]?.guest_phone || '';
    const manageToken = await buildManageTokenRow(primaryPhone);
    const { error: manageTokenError } = await client
      .from('reservation_manage_tokens')
      .insert(manageToken.row);

    if (manageTokenError) {
      throw new Error(manageTokenError.message || 'Could not create reservation manage token.');
    }

    return jsonResponse(
      {
        primaryReservationId: result.primaryReservationId,
        bookingGroupId: result.bookingGroupId,
        reservationIds: result.reservations.map((reservation) => reservation.id),
        manageToken: manageToken.token,
        paymentType: result.reservations[0]?.payment_type || '',
        notificationResults: [],
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});
