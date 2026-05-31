import { getCorsHeaders, handleCors } from '../_shared/cors.ts';
import { getSiteUrl } from '../_shared/env.ts';
import { assertMethod, HttpError, readJson } from '../_shared/http.ts';
import {
  createMaibCheckout,
  getMaibCallbackUrl,
  MAIB_PAYMENT_SESSION_MINUTES,
} from '../_shared/maib.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';

const ALLOWED_ORIGINS = [
  'https://ecovila.md',
  'https://www.ecovila.md',
  'https://admin.ecovila.md',
  'null',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

Deno.serve(async (request) => {
  const cors = handleCors(request, { allowedOrigins: ALLOWED_ORIGINS });
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const bookingGroupId = requiredString(body?.bookingGroupId, 'bookingGroupId is required.');
    const requestedReservationIds = normalizeStringArray(body?.reservationIds);
    const paymentRail = normalizePaymentRail(body?.paymentRail);
    const client = createServiceClient();
    const reservations = await findPayableReservations(
      client,
      bookingGroupId,
      requestedReservationIds,
    );
    const primaryReservationId = normalizePrimaryReservationId(
      body?.primaryReservationId,
      reservations,
    );
    const existingPayment = await findReusablePayment(client, bookingGroupId);

    if (existingPayment?.checkout_url) {
      return json(request, {
        payUrl: existingPayment.checkout_url,
        payId: existingPayment.pay_id,
        reused: true,
      });
    }

    const amount = reservations.reduce(
      (total: number, reservation: any) => total + Number(reservation.total_price || 0),
      0,
    );
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + MAIB_PAYMENT_SESSION_MINUTES * 60 * 1000,
    ).toISOString();
    const firstReservation = reservations[0];
    const siteUrl = getSiteUrl();
    const successUrl = `${siteUrl}/confirmare.html?id=${
      encodeURIComponent(primaryReservationId)
    }&payment=success`;
    const failUrl = `${siteUrl}/confirmare.html?id=${
      encodeURIComponent(primaryReservationId)
    }&payment=failed`;
    const checkout = await createMaibCheckout({
      amount,
      bookingGroupId,
      description: `EcoVila reservation ${bookingGroupId}`,
      guestEmail: firstReservation.guest_email,
      guestName: `${firstReservation.guest_first_name} ${firstReservation.guest_last_name}`,
      guestPhone: firstReservation.guest_phone,
      language: firstReservation.guest_language,
      createdAt: now.toISOString(),
      callbackUrl: getMaibCallbackUrl(),
      successUrl,
      failUrl,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent') || '',
    });

    await insertPaymentSession(client, {
      payId: checkout.payId,
      bookingGroupId,
      primaryReservationId,
      reservationIds: reservations.map((reservation: any) => reservation.id),
      amount,
      paymentRail,
      checkoutUrl: checkout.payUrl,
      raw: checkout.raw,
      expiresAt,
    });
    await markReservationsInProgress(
      client,
      reservations.map((reservation: any) => reservation.id),
      expiresAt,
    );

    return json(request, { payUrl: checkout.payUrl, payId: checkout.payId });
  } catch (error) {
    console.error('Maib create payment failed', {
      message: error instanceof Error ? error.message : 'Unexpected server error.',
      status: error instanceof HttpError ? error.status : 500,
    });

    return json(
      request,
      { error: error instanceof Error ? error.message : 'Unexpected server error.' },
      { status: error instanceof HttpError ? error.status : 500 },
    );
  }
});

async function findPayableReservations(
  client: any,
  bookingGroupId: string,
  requestedReservationIds: string[],
) {
  const { data, error } = await client
    .from('reservations')
    .select(
      'id, booking_group_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, total_price, payment_type, payment_status, cancelled_at',
    )
    .eq('booking_group_id', bookingGroupId)
    .eq('payment_type', 'card')
    .eq('payment_status', 'pending')
    .is('cancelled_at', null);

  if (error) {
    throw new Error(error.message);
  }

  const reservations = data || [];
  if (!reservations.length) {
    throw new HttpError(404, 'No pending card reservation was found for this booking group.');
  }

  const actualIds = new Set(reservations.map((reservation: any) => String(reservation.id)));
  const requestedIds = new Set(requestedReservationIds);
  if (requestedIds.size && [...requestedIds].some((id) => !actualIds.has(id))) {
    throw new HttpError(400, 'Reservation ids do not match the booking group.');
  }

  return reservations;
}

async function findReusablePayment(client: any, bookingGroupId: string) {
  const { data, error } = await client
    .from('maib_payments')
    .select('pay_id, checkout_url, expires_at, status')
    .eq('booking_group_id', bookingGroupId)
    .in('status', ['created', 'pending'])
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function insertPaymentSession(client: any, session: any) {
  const { error } = await client
    .from('maib_payments')
    .insert({
      pay_id: session.payId,
      booking_group_id: session.bookingGroupId,
      primary_reservation_id: session.primaryReservationId,
      reservation_ids: session.reservationIds,
      amount: session.amount,
      currency: 'MDL',
      payment_rail: session.paymentRail,
      status: 'pending',
      checkout_url: session.checkoutUrl,
      callback_payload: { checkout: session.raw },
      expires_at: session.expiresAt,
    });

  if (error) {
    throw new Error(error.message);
  }
}

async function markReservationsInProgress(
  client: any,
  reservationIds: string[],
  expiresAt: string,
) {
  const { error } = await client
    .from('reservations')
    .update({
      payment_in_progress: true,
      payment_session_expires_at: expiresAt,
    })
    .in('id', reservationIds);

  if (error) {
    throw new Error(error.message);
  }
}

function normalizePrimaryReservationId(value: unknown, reservations: any[]) {
  const requested = String(value || '').trim();
  const ids = reservations.map((reservation: any) => String(reservation.id));
  return ids.includes(requested) ? requested : ids[0];
}

function requiredString(value: unknown, message: string) {
  const text = String(value || '').trim();
  if (!text) {
    throw new HttpError(400, message);
  }
  return text;
}

function normalizeStringArray(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizePaymentRail(value: unknown) {
  const rail = String(value || '').trim().toLowerCase();
  if (rail !== 'mia' && rail !== 'card') {
    throw new HttpError(400, 'paymentRail must be mia or card.');
  }
  return rail;
}

function getClientIp(request: Request) {
  return (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
}

function json(request: Request, body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...getCorsHeaders(request, { allowedOrigins: ALLOWED_ORIGINS }),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}
