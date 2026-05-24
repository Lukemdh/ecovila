import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, readJson } from '../_shared/http.ts';
import { getSiteUrl } from '../_shared/env.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import { getMaibOrderId, isMaibApproved, verifyMaibSignature } from '../_shared/maib.ts';
import {
  composeBookingConfirmation,
  dispatchAndRecordNotification,
} from '../_shared/notifications.ts';
import { buildCancellationTokenRows, withRoomFields } from '../_shared/reservations.ts';

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    const payload = await readJson(request);
    const signatureValid = await verifyMaibSignature(payload);

    if (!signatureValid) {
      return jsonResponse({ ok: false, error: 'Invalid signature.' }, { status: 401 });
    }

    const orderId = getMaibOrderId(payload);
    if (!orderId) {
      return jsonResponse({ ok: false, error: 'Missing orderId.' }, { status: 400 });
    }

    const client = createServiceClient();
    const reservations = await findReservationsForOrder(client, orderId);
    const now = new Date().toISOString();

    if (!reservations.length) {
      return jsonResponse({ ok: true, matched: 0 });
    }

    if (isMaibApproved(payload)) {
      const { error } = await client
        .from('reservations')
        .update({ payment_status: 'paid', cash_expires_at: null, paid_at: now })
        .in('id', reservations.map((reservation: any) => reservation.id));

      if (error) {
        throw new Error(error.message);
      }

      const notificationResults = await notifyPaidReservations(client, reservations);
      return jsonResponse({
        ok: true,
        status: 'paid',
        matched: reservations.length,
        notificationResults,
      });
    }

    const { error } = await client
      .from('reservations')
      .update({
        payment_status: 'cancelled',
        cancelled_at: now,
        cancellation_reason: `maib_${String(payload.result?.status || 'failed').toLowerCase()}`,
      })
      .in('id', reservations.map((reservation: any) => reservation.id));

    if (error) {
      throw new Error(error.message);
    }

    return jsonResponse({ ok: true, status: 'cancelled', matched: reservations.length });
  } catch (error) {
    return errorResponse(error);
  }
});

async function findReservationsForOrder(client: any, orderId: string) {
  const { data: byGroup, error: groupError } = await client
    .from('reservations')
    .select(
      'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, rooms(number, type)',
    )
    .eq('booking_group_id', orderId)
    .is('cancelled_at', null);

  if (groupError) {
    throw new Error(groupError.message);
  }

  if (byGroup?.length) {
    return byGroup.map(withRoomFields);
  }

  const { data: byReservation, error: reservationError } = await client
    .from('reservations')
    .select(
      'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, rooms(number, type)',
    )
    .eq('id', orderId)
    .is('cancelled_at', null);

  if (reservationError) {
    throw new Error(reservationError.message);
  }

  return (byReservation || []).map(withRoomFields);
}

async function notifyPaidReservations(client: any, reservations: any[]) {
  const results = [];
  const siteUrl = getSiteUrl();

  for (const reservation of reservations) {
    try {
      let token = await findCancellationToken(client, reservation.id);
      if (!token) {
        const tokenRows = buildCancellationTokenRows([reservation]);
        const { data, error } = await client
          .from('cancellation_tokens')
          .insert(tokenRows)
          .select('reservation_id, token')
          .single();

        if (error) {
          throw new Error(error.message);
        }

        token = data?.token || '';
      }

      await dispatchAndRecordNotification(
        client,
        reservation.id,
        'payment_confirmation',
        composeBookingConfirmation(reservation, {
          cancellationToken: token,
          siteUrl,
        }),
      );
      results.push({ reservationId: reservation.id, sent: true });
    } catch (error) {
      console.error('Maib payment notification failed', error);
      results.push({
        reservationId: reservation.id,
        sent: false,
        error: error instanceof Error ? error.message : 'Notification failed.',
      });
    }
  }

  return results;
}

async function findCancellationToken(client: any, reservationId: string) {
  const { data, error } = await client
    .from('cancellation_tokens')
    .select('token')
    .eq('reservation_id', reservationId)
    .eq('used', false)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data?.token || '';
}
