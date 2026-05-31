import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import { groupReservations, hashManageToken } from '../_shared/reservationManage.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const token = String(body?.manageToken || '').trim();
    const reservationId = String(body?.reservationId || '').trim();

    if (!token || !reservationId) {
      throw new HttpError(400, 'manageToken and reservationId are required.');
    }

    const client = createServiceClient();
    const manageToken = await validateManageToken(client, token);
    const reservations = await findReservationGroup(client, reservationId, manageToken.phone);

    if (!reservations.length) {
      throw new HttpError(404, 'Reservation was not found.');
    }

    const payment = await findMaibPayment(client, reservations[0].booking_group_id);

    return jsonResponse({
      ok: true,
      reservation: groupReservations(reservations)[0],
      reservations,
      payment,
    });
  } catch (error) {
    return errorResponse(error);
  }
});

async function validateManageToken(client: any, token: string) {
  const tokenHash = await hashManageToken(token);
  const { data, error } = await client
    .from('reservation_manage_tokens')
    .select('phone, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data || new Date(data.expires_at).getTime() < Date.now()) {
    throw new HttpError(401, 'Invalid or expired manage token.');
  }

  await client
    .from('reservation_manage_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('token_hash', tokenHash);

  return data;
}

async function findReservationGroup(client: any, reservationId: string, phone: string) {
  const { data: primary, error: primaryError } = await client
    .from('reservations')
    .select('booking_group_id')
    .eq('id', reservationId)
    .eq('guest_phone', phone)
    .maybeSingle();

  if (primaryError) throw new Error(primaryError.message);
  if (!primary) return [];

  const { data, error } = await client
    .from('reservations')
    .select(
      'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, adults, kids_ages, total_price, payment_type, payment_status, created_at, cancelled_at, cancellation_reason, rooms(number, type)',
    )
    .eq('booking_group_id', primary.booking_group_id)
    .eq('guest_phone', phone)
    .order('check_in', { ascending: true });

  if (error) throw new Error(error.message);
  return data || [];
}

async function findMaibPayment(client: any, bookingGroupId: string) {
  const { data, error } = await client
    .from('maib_payments')
    .select('pay_id, provider_payment_id, amount, currency, payment_rail, status, refunded_at')
    .eq('booking_group_id', bookingGroupId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}
