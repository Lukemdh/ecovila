import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, readJson } from '../_shared/http.ts';
import { buildManageTokenRow } from '../_shared/reservationManage.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import { createReservationsWithTokens } from '../_shared/reservations.ts';
import { assignAutomaticRooms } from '../_shared/roomAssignment.ts';
import { verifyReservationGroupPricing } from '../_shared/pricingGuard.ts';
import { assertRateLimits, RATE_LIMITS, rateLimitIp } from '../_shared/rateLimit.ts';
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

    // A pending reservation holds inventory, so an unauthenticated flood here is
    // an inventory-denial vector. Bound it per IP and per guest phone (ADR-060).
    const guestPhone = String(
      (Array.isArray(reservations) ? reservations[0]?.guest_phone : reservations?.guest_phone) ||
        '',
    ).trim();
    await assertRateLimits(client, [
      { rule: RATE_LIMITS.createReservationIp, key: rateLimitIp(request) },
      { rule: RATE_LIMITS.createReservationPhone, key: guestPhone },
    ]);

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
