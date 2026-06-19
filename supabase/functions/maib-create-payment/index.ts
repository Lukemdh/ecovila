import { getCorsHeaders, handleCors } from '../_shared/cors.ts';
import { getSiteUrl } from '../_shared/env.ts';
import { assertMethod, HttpError, readJson } from '../_shared/http.ts';
import {
  cancelMaibMiaQr,
  createMaibCheckout,
  createMaibMiaQr,
  getMaibCallbackUrl,
  getMaibMiaCallbackUrl,
  MAIB_PAYMENT_SESSION_MINUTES,
} from '../_shared/maib.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import { assertRateLimits, RATE_LIMITS, rateLimitIp } from '../_shared/rateLimit.ts';
import { validateManageTokenPhone } from '../_shared/reservationChanges.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): Promise<SupabaseQueryResult>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type PaymentRail = 'mia' | 'card';

type PayableReservationRow = {
  id: string;
  booking_group_id: string;
  guest_first_name: string;
  guest_last_name: string;
  guest_phone: string;
  guest_email: string;
  guest_language?: string | null;
  total_price: number | string;
  payment_type: string;
  payment_status: string;
  cancelled_at?: string | null;
  payment_session_expires_at?: string | null;
};

type ReusablePaymentRow = {
  pay_id: string;
  checkout_url: string;
  amount?: number | string | null;
  expires_at?: string | null;
  status?: string | null;
};

type PaymentSessionInsert = {
  payId: string;
  bookingGroupId: string;
  primaryReservationId: string;
  reservationIds: string[];
  amount: number;
  paymentRail: PaymentRail;
  checkoutUrl: string;
  raw: Record<string, unknown>;
  expiresAt: string;
};

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const bookingGroupId = requiredString(body?.bookingGroupId, 'bookingGroupId is required.');
    const requestedReservationIds = normalizeStringArray(body?.reservationIds);
    const paymentRail = normalizePaymentRail(body?.paymentRail);
    const manageToken = String(body?.manageToken || '').trim();
    const client = createServiceClient();

    // This mints a MAIB session (an outbound provider call). Bound it per IP and
    // per booking group; the manage-token check below is the real gate (ADR-060).
    await assertRateLimits(client, [
      { rule: RATE_LIMITS.createPaymentIp, key: rateLimitIp(request) },
      { rule: RATE_LIMITS.createPaymentGroup, key: bookingGroupId },
    ]);

    // The manage token (issued by create-reservation / the SMS lookup) is the
    // real capability for paying a booking: validate it and bind it to the
    // booking's phone, so a leaked or guessed bookingGroupId can no longer drive
    // MAIB on a stranger's reservation (ADR-060, mirrors reservation-change-create).
    const tokenPhone = await validateManageTokenPhone(client, manageToken);

    const reservations = await findPayableReservations(
      client,
      bookingGroupId,
      requestedReservationIds,
    );
    assertBookingBelongsToPhone(reservations, tokenPhone);
    const primaryReservationId = normalizePrimaryReservationId(
      body?.primaryReservationId,
      reservations,
    );
    const amount = reservations.reduce(
      (total, reservation) => total + Number(reservation.total_price || 0),
      0,
    );
    const responseContext: MiaResponseContext = {
      siteUrl: getSiteUrl(),
      primaryReservationId,
      bookingGroupId,
      manageToken,
    };
    const existingPayment = await findReusablePayment(client, bookingGroupId);

    if (existingPayment?.checkout_url) {
      // Only hand back a previous session when it was created for the exact
      // amount owed now; otherwise the guest would pay a stale total.
      if (Number(existingPayment.amount) === amount) {
        return json(request, reusedResponse(paymentRail, existingPayment, responseContext));
      }

      // A MIA QR for a stale amount is independently payable, so cancel it at
      // MAIB before minting a fresh one; the card checkout is harmless to leave.
      if (paymentRail === 'mia') {
        try {
          await cancelMaibMiaQr(existingPayment.pay_id, 'amount_changed');
        } catch (error) {
          console.error('Could not cancel stale MIA QR', error);
        }
      }

      await expireStalePayment(client, existingPayment.pay_id);
    }

    const now = new Date();
    // The hold is anchored to the guest's first payment attempt: the earliest
    // deadline already stamped on the reservations is reused so retries (a
    // failed charge or a closed gateway) never extend the five-minute window.
    const expiresAt = resolvePaymentDeadline(reservations, now);
    const firstReservation = reservations[0];

    const session = paymentRail === 'mia'
      ? await createMiaSession(bookingGroupId, amount, expiresAt)
      : await createCardSession({
        request,
        manageToken: responseContext.manageToken,
        amount,
        bookingGroupId,
        primaryReservationId,
        reservation: firstReservation,
        createdAt: now.toISOString(),
      });

    await insertPaymentSession(client, {
      payId: session.payId,
      bookingGroupId,
      primaryReservationId,
      reservationIds: reservations.map((reservation) => reservation.id),
      amount,
      paymentRail,
      checkoutUrl: session.url,
      raw: session.raw,
      expiresAt,
    });
    await markReservationsInProgress(
      client,
      reservations.map((reservation) => reservation.id),
      expiresAt,
    );

    return json(request, createdResponse(paymentRail, session, expiresAt, responseContext));
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

type PaymentSession = { payId: string; url: string; raw: Record<string, unknown> };

async function createMiaSession(
  bookingGroupId: string,
  amount: number,
  expiresAt: string,
): Promise<PaymentSession> {
  const qr = await createMaibMiaQr({
    amount,
    orderId: bookingGroupId,
    description: `EcoVila reservation ${bookingGroupId}`,
    callbackUrl: getMaibMiaCallbackUrl(),
    expiresAt,
  });

  return { payId: qr.qrId, url: qr.url, raw: qr.raw };
}

async function createCardSession(input: {
  request: Request;
  manageToken: string;
  amount: number;
  bookingGroupId: string;
  primaryReservationId: string;
  reservation: PayableReservationRow;
  createdAt: string;
}): Promise<PaymentSession> {
  const siteUrl = getSiteUrl();
  const successUrl = confirmationUrl(
    siteUrl,
    input.primaryReservationId,
    input.manageToken,
    'success',
  );
  const failUrl = confirmationUrl(siteUrl, input.primaryReservationId, input.manageToken, 'failed');
  const checkout = await createMaibCheckout({
    amount: input.amount,
    bookingGroupId: input.bookingGroupId,
    description: `EcoVila reservation ${input.bookingGroupId}`,
    guestEmail: input.reservation.guest_email,
    guestName: `${input.reservation.guest_first_name} ${input.reservation.guest_last_name}`,
    guestPhone: input.reservation.guest_phone,
    language: input.reservation.guest_language || undefined,
    createdAt: input.createdAt,
    callbackUrl: getMaibCallbackUrl(),
    successUrl,
    failUrl,
    ip: getClientIp(input.request),
    userAgent: input.request.headers.get('user-agent') || '',
  });

  return { payId: checkout.payId, url: checkout.payUrl, raw: checkout.raw };
}

type MiaResponseContext = {
  siteUrl: string;
  primaryReservationId: string;
  bookingGroupId: string;
  manageToken: string;
};

// The MIA QR lives on our own page. `payUrl` points there too so any browser
// still running a cached, pre-MIA checkout.js (which only knows `payUrl`) is
// carried to the QR page instead of being stranded after this deploy.
function miaPageUrl(ctx: MiaResponseContext) {
  const params = new URLSearchParams();
  params.set('id', ctx.primaryReservationId);
  params.set('group', ctx.bookingGroupId);

  if (ctx.manageToken) {
    params.set('manage', ctx.manageToken);
  }

  return `${ctx.siteUrl}/plata-mia.html?${params.toString()}`;
}

function reusedResponse(
  paymentRail: PaymentRail,
  existing: ReusablePaymentRow,
  ctx: MiaResponseContext,
) {
  if (paymentRail === 'mia') {
    return {
      rail: 'mia',
      qrUrl: existing.checkout_url,
      qrId: existing.pay_id,
      expiresAt: existing.expires_at,
      payUrl: miaPageUrl(ctx),
      reused: true,
    };
  }

  return { payUrl: existing.checkout_url, payId: existing.pay_id, reused: true };
}

function createdResponse(
  paymentRail: PaymentRail,
  session: PaymentSession,
  expiresAt: string,
  ctx: MiaResponseContext,
) {
  if (paymentRail === 'mia') {
    return {
      rail: 'mia',
      qrUrl: session.url,
      qrId: session.payId,
      expiresAt,
      payUrl: miaPageUrl(ctx),
    };
  }

  return { payUrl: session.url, payId: session.payId };
}

async function findPayableReservations(
  client: SupabaseClient,
  bookingGroupId: string,
  requestedReservationIds: string[],
) {
  const { data, error } = await table<PayableReservationRow[]>(client, 'reservations')
    .select(
      'id, booking_group_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, total_price, payment_type, payment_status, cancelled_at, payment_session_expires_at',
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

  const actualIds = new Set(reservations.map((reservation) => String(reservation.id)));
  const requestedIds = new Set(requestedReservationIds);
  if (requestedIds.size && [...requestedIds].some((id) => !actualIds.has(id))) {
    throw new HttpError(400, 'Reservation ids do not match the booking group.');
  }

  return reservations;
}

// The manage token's phone must own every reservation being paid. A booking
// group is created from a single guest form, so all rows share one phone;
// requiring an exact match means a valid token for booking A can never start a
// payment for booking B.
function assertBookingBelongsToPhone(
  reservations: PayableReservationRow[],
  tokenPhone: string,
) {
  if (!tokenPhone || reservations.some((reservation) => reservation.guest_phone !== tokenPhone)) {
    throw new HttpError(403, 'This manage token does not match the booking.');
  }
}

function resolvePaymentDeadline(reservations: PayableReservationRow[], now: Date) {
  const anchors = reservations
    .map((reservation) => reservation.payment_session_expires_at)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((time) => Number.isFinite(time));

  if (anchors.length) {
    const earliest = Math.min(...anchors);
    // A guest returning after the window has lapsed cannot restart payment; the
    // expiry cron has either already released the room or is about to.
    if (earliest <= now.getTime()) {
      throw new HttpError(410, 'The payment window for this reservation has expired.');
    }
    return new Date(earliest).toISOString();
  }

  return new Date(now.getTime() + MAIB_PAYMENT_SESSION_MINUTES * 60 * 1000).toISOString();
}

async function expireStalePayment(client: SupabaseClient, payId: string) {
  const { error } = await table(client, 'maib_payments')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('pay_id', payId);

  if (error) {
    throw new Error(error.message);
  }
}

async function findReusablePayment(client: SupabaseClient, bookingGroupId: string) {
  const { data, error } = await table<ReusablePaymentRow>(client, 'maib_payments')
    .select('pay_id, checkout_url, amount, expires_at, status')
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

async function insertPaymentSession(client: SupabaseClient, session: PaymentSessionInsert) {
  const { error } = await table(client, 'maib_payments')
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
  client: SupabaseClient,
  reservationIds: string[],
  expiresAt: string,
) {
  const { error } = await table(client, 'reservations')
    .update({
      payment_in_progress: true,
      payment_session_expires_at: expiresAt,
    })
    .in('id', reservationIds);

  if (error) {
    throw new Error(error.message);
  }
}

function normalizePrimaryReservationId(value: unknown, reservations: PayableReservationRow[]) {
  const requested = String(value || '').trim();
  const ids = reservations.map((reservation) => String(reservation.id));
  return ids.includes(requested) ? requested : ids[0];
}

function confirmationUrl(
  siteUrl: string,
  reservationId: string,
  manageToken: string,
  payment: 'success' | 'failed',
) {
  const params = new URLSearchParams();
  params.set('id', reservationId);

  if (manageToken) {
    params.set('manage', manageToken);
  }

  params.set('payment', payment);

  return `${siteUrl}/confirmare.html?${params.toString()}`;
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

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}

function json(request: Request, body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...getCorsHeaders(request),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}
