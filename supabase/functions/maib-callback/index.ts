import { assertMethod, errorResponse, HttpError, jsonResponse } from '../_shared/http.ts';
import {
  getMaibCallbackAmount,
  getMaibCallbackOrderId,
  getMaibCallbackPayId,
  getMaibCallbackStatus,
  getMaibProviderPaymentId,
  isMaibCallbackTerminalStatus,
  parseMaibCallback,
  verifyMaibCallbackSignature,
} from '../_shared/maib.ts';
import {
  findOnlineReservationsForBookingGroup,
  type PaymentReservationRow,
  settleBookingGroupAsPaid,
} from '../_shared/bookingSettlement.ts';
import {
  findChangeById,
  findChangeByPayId,
  markChangePaymentPaid,
  markChangeStatus,
  type ReservationChangeRow,
  settleChangePaid,
} from '../_shared/reservationChanges.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  single(): Promise<SupabaseQueryResult<T>>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type MaibPaymentRow = {
  pay_id: string;
  provider_payment_id?: string | null;
  booking_group_id: string;
  amount?: number | string | null;
  status: string;
  processed_at?: string | null;
};

type PaymentLookupInput = {
  payId?: string;
  providerPaymentId?: string;
  orderId?: string;
};

type UpsertPaymentCallbackInput = {
  existingPayId?: string | null;
  payId?: string | null;
  providerPaymentId?: string;
  bookingGroupId: string;
  status: string;
  payload: Record<string, unknown>;
  processedAt: string | null;
  updatedAt: string;
  reservations: PaymentReservationRow[];
};

Deno.serve(async (request) => {
  try {
    assertMethod(request, ['POST']);
    const rawBody = await request.text();
    const signatureValid = await verifyMaibCallbackSignature(rawBody, request.headers);

    if (!signatureValid) {
      throw new HttpError(401, 'Invalid Maib signature.');
    }

    const payload = parseMaibCallback(rawBody) as Record<string, unknown>;
    const orderId = getMaibCallbackOrderId(payload);
    const payId = getMaibCallbackPayId(payload);
    const providerPaymentId = getMaibProviderPaymentId(payload);

    if (!orderId && !payId) {
      throw new HttpError(400, 'Missing Maib order or payment id.');
    }

    const client = createServiceClient();
    const payment = await findPayment(client, { payId, providerPaymentId, orderId });

    if (payment?.processed_at && ['paid', 'failed', 'cancelled'].includes(payment.status)) {
      return jsonResponse({ ok: true, duplicate: true, status: payment.status }, {}, request);
    }

    // A "add guests" difference payment is tracked in reservation_changes, not
    // maib_payments. Its MAIB order id is the change id, so when no maib_payments
    // row matches we look it up by checkout id / order id and settle the change
    // instead of a booking. Normal bookings always have a maib_payments row, so
    // this branch never intercepts them.
    if (!payment) {
      const change = await findChangePaymentForCallback(client, payId, orderId);
      if (change) {
        return await handleChangeCallback(client, change, payload, request);
      }
    }

    const bookingGroupId = payment?.booking_group_id || orderId;
    const reservations = await findOnlineReservationsForBookingGroup(client, bookingGroupId);
    const now = new Date().toISOString();
    const reportedStatus = getMaibCallbackStatus(payload);
    const amountMismatch = reportedStatus === 'paid' &&
      hasCallbackAmountMismatch(payload, payment, reservations);
    // A "paid" callback whose captured amount differs from the amount we asked
    // MAIB to charge must never confirm the booking. It is kept pending for
    // manual review instead of being trusted.
    const status = amountMismatch ? 'pending' : reportedStatus;
    const terminal = isMaibCallbackTerminalStatus(status);

    await upsertPaymentCallback(client, {
      existingPayId: payment?.pay_id,
      payId: payId || payment?.pay_id || providerPaymentId,
      providerPaymentId,
      bookingGroupId,
      status,
      payload,
      processedAt: terminal ? now : null,
      updatedAt: now,
      reservations,
    });

    const callbackContext = {
      checkoutId: payId || null,
      paymentId: providerPaymentId || null,
      orderId: orderId || null,
      status,
      matched: reservations.length,
    };

    if (amountMismatch) {
      console.error('Maib callback amount mismatch — booking left pending for manual review', {
        ...callbackContext,
        callbackAmount: getMaibCallbackAmount(payload),
        expectedAmount: expectedPaymentAmount(payment, reservations),
      });
      return jsonResponse(
        { ok: true, status: 'amount_mismatch', matched: reservations.length },
        {},
        request,
      );
    }

    if (!reservations.length && status !== 'paid') {
      console.info('Maib callback processed', {
        ...callbackContext,
        decision: 'no_matching_reservation',
      });
      return jsonResponse({ ok: true, matched: 0, status }, {}, request);
    }

    if (status === 'paid') {
      const settlement = await settleBookingGroupAsPaid(client, {
        bookingGroupId,
        reservations,
        now,
        source: 'maib-callback',
      });

      if (settlement.requiresManualReview) {
        console.error(
          'Maib paid callback settled no reservation — guest was charged, manual refund review required',
          callbackContext,
        );
        return jsonResponse(
          { ok: true, status: 'paid', matched: 0, requiresManualReview: true },
          {},
          request,
        );
      }

      console.info('Maib callback processed', {
        ...callbackContext,
        decision: 'paid',
        reinstated: settlement.reinstated,
      });
      return jsonResponse(
        {
          ok: true,
          status: 'paid',
          matched: settlement.matched,
          reinstated: settlement.reinstated,
          notificationResults: settlement.notificationResults,
          trackingResult: settlement.trackingResult,
        },
        {},
        request,
      );
    }

    if (status === 'pending') {
      console.info('Maib callback processed', { ...callbackContext, decision: 'left_pending' });
      return jsonResponse({ ok: true, status, matched: reservations.length }, {}, request);
    }

    // A failed or cancelled gateway result does NOT release the reservation. The
    // payment session row is already marked terminal above, which forces a fresh
    // checkout on retry, but the reservation stays pending and
    // payment_in_progress until its five-minute hold elapses. The per-minute
    // expiry cron is the sole authority that finally cancels the room, so the
    // guest can re-attempt payment (or return after closing the gateway) for the
    // remainder of the window.
    console.info('Maib callback processed', {
      ...callbackContext,
      decision: status === 'cancelled' ? 'cancelled_retryable' : 'failed_retryable',
    });

    return jsonResponse({ ok: true, status, matched: reservations.length }, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});

const CHANGE_ORDER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findChangePaymentForCallback(
  client: SupabaseClient,
  payId: string | undefined,
  orderId: string | undefined,
): Promise<ReservationChangeRow | null> {
  if (payId) {
    const byPayId = await findChangeByPayId(client, payId);
    if (byPayId) return byPayId;
  }
  if (orderId && CHANGE_ORDER_ID_RE.test(orderId)) {
    const byId = await findChangeById(client, orderId);
    if (byId) return byId;
  }
  return null;
}

async function handleChangeCallback(
  client: SupabaseClient,
  change: ReservationChangeRow,
  payload: Record<string, unknown>,
  request: Request,
) {
  if (change.applied_at) {
    return jsonResponse({ ok: true, duplicate: true, status: 'paid' }, {}, request);
  }

  const reportedStatus = getMaibCallbackStatus(payload);
  const now = new Date().toISOString();
  const context = {
    changeId: change.id,
    bookingGroupId: change.booking_group_id,
    status: reportedStatus,
  };

  if (reportedStatus === 'paid') {
    // Only a still-pending change may be applied. A card checkout cannot be
    // cancelled at MAIB, so a superseded/failed change could be paid late — its
    // new_adults/new_kids_ages is a stale snapshot, and applying it would
    // overwrite a newer change's party. Capture it for manual refund instead.
    if (change.status !== 'pending') {
      console.error('Paid card callback for a non-pending change — not applied, manual refund review', {
        ...context,
        changeStatus: change.status,
      });
      return jsonResponse({ ok: true, status: 'stale', changeId: change.id }, {}, request);
    }

    const callbackAmount = getMaibCallbackAmount(payload);
    if (
      callbackAmount !== null &&
      Math.round(callbackAmount * 100) !== Math.round(Number(change.difference_amount) * 100)
    ) {
      console.error('Maib change callback amount mismatch — left pending for manual review', {
        ...context,
        callbackAmount,
        expected: change.difference_amount,
      });
      await markChangeStatus(client, change.id, 'pending', payload);
      return jsonResponse({ ok: true, status: 'amount_mismatch' }, {}, request);
    }

    await markChangePaymentPaid(client, change.id, getMaibProviderPaymentId(payload), payload);
    const settlement = await settleChangePaid(client, change, now, 'maib-callback-change');
    console.info('Maib change callback processed', {
      ...context,
      decision: 'paid',
      applied: settlement.applied,
    });
    return jsonResponse({ ok: true, status: 'paid', applied: settlement.applied }, {}, request);
  }

  if (reportedStatus === 'pending') {
    console.info('Maib change callback processed', { ...context, decision: 'left_pending' });
    return jsonResponse({ ok: true, status: 'pending' }, {}, request);
  }

  // failed / cancelled: a difference payment holds no inventory, so mark it
  // terminal and let the guest re-initiate from the manage page if they wish.
  await markChangeStatus(
    client,
    change.id,
    reportedStatus === 'cancelled' ? 'cancelled' : 'failed',
    payload,
  );
  console.info('Maib change callback processed', { ...context, decision: reportedStatus });
  return jsonResponse({ ok: true, status: reportedStatus }, {}, request);
}

function expectedPaymentAmount(
  payment: MaibPaymentRow | null | undefined,
  reservations: PaymentReservationRow[],
) {
  const storedAmount = Number(payment?.amount ?? NaN);

  if (Number.isFinite(storedAmount)) {
    return storedAmount;
  }

  return reservations.reduce(
    (total, reservation) => total + Number(reservation.total_price || 0),
    0,
  );
}

function hasCallbackAmountMismatch(
  payload: Record<string, unknown>,
  payment: MaibPaymentRow | null | undefined,
  reservations: PaymentReservationRow[],
) {
  if (!payment && !reservations.length) {
    return false;
  }

  const callbackAmount = getMaibCallbackAmount(payload);

  if (callbackAmount === null) {
    // MAIB did not report an amount; the signature already proves the callback
    // is authentic, so the booking proceeds, but the gap is logged for review.
    console.warn('Maib paid callback did not include an amount field');
    return false;
  }

  const expected = expectedPaymentAmount(payment, reservations);
  return Math.round(callbackAmount * 100) !== Math.round(expected * 100);
}

async function findPayment(
  client: SupabaseClient,
  input: PaymentLookupInput,
) {
  if (input.payId) {
    const byPayId = await maybeSinglePayment(
      table<MaibPaymentRow>(client, 'maib_payments').select('*').eq('pay_id', input.payId),
    );
    if (byPayId) {
      return byPayId;
    }
  }

  if (input.providerPaymentId) {
    const byProviderPaymentId = await maybeSinglePayment(
      table<MaibPaymentRow>(client, 'maib_payments')
        .select('*')
        .eq('provider_payment_id', input.providerPaymentId),
    );
    if (byProviderPaymentId) {
      return byProviderPaymentId;
    }
  }

  if (input.orderId) {
    return await maybeSinglePayment(
      table<MaibPaymentRow>(client, 'maib_payments')
        .select('*')
        .eq('booking_group_id', input.orderId)
        .order('created_at', { ascending: false })
        .limit(1),
    );
  }

  return null;
}

async function maybeSinglePayment(query: QueryBuilder<MaibPaymentRow>) {
  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function upsertPaymentCallback(client: SupabaseClient, input: UpsertPaymentCallbackInput) {
  const values = {
    provider_payment_id: input.providerPaymentId || null,
    status: input.status,
    callback_payload: input.payload,
    processed_at: input.processedAt,
    updated_at: input.updatedAt,
  };

  if (input.existingPayId) {
    const { error } = await table(client, 'maib_payments')
      .update(values)
      .eq('pay_id', input.existingPayId);

    if (error) {
      throw new Error(error.message);
    }
    return;
  }

  if (!input.payId || !input.bookingGroupId) {
    return;
  }

  const { error } = await table(client, 'maib_payments')
    .insert({
      pay_id: input.payId,
      provider_payment_id: input.providerPaymentId || null,
      booking_group_id: input.bookingGroupId,
      primary_reservation_id: input.reservations[0]?.id || null,
      reservation_ids: input.reservations.map((reservation) => reservation.id),
      amount: input.reservations.reduce(
        (total, reservation) => total + Number(reservation.total_price || 0),
        0,
      ),
      currency: 'MDL',
      payment_rail: 'card',
      status: input.status,
      checkout_url: '',
      callback_payload: input.payload,
      expires_at: input.updatedAt,
      processed_at: input.processedAt,
      updated_at: input.updatedAt,
    });

  if (error && error.code !== '23505') {
    throw new Error(error.message);
  }
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
