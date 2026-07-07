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
  findOtherPaidPayment,
  markPaymentManualReview,
  markPaymentProcessed,
  type PaymentReservationRow,
  settleBookingGroupAsPaid,
} from '../_shared/bookingSettlement.ts';
import { sendStaffAlert } from '../_shared/alerts.ts';
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
    // No rate limit here by design: this endpoint is gated by the MAIB HMAC
    // signature below, and a per-IP cap could throttle the provider while a
    // global ceiling (rejected for the site) could drop legitimate callbacks.
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

    // Short-circuit ONLY a fully processed paid payment (settlement included —
    // processed_at is stamped after settling, see below). A failed/cancelled
    // record deliberately does NOT short-circuit: if MAIB ever delivers a later
    // "paid" result for the same checkout (a retry on the hosted page), the
    // capture must supersede the failure, not be dropped (ADR-089).
    if (payment?.processed_at && payment.status === 'paid') {
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
    const paymentRowId = payment?.pay_id || payId || providerPaymentId || '';

    // A paid result is only stamped processed_at AFTER the settlement below
    // succeeds. If the process dies between "row says paid" and "reservations
    // settled", the provider's retry (or the per-minute cron backstop) passes
    // the duplicate guard and finishes the settlement instead of dropping it —
    // previously the booking was silently lost to the expiry cron (ADR-089).
    await upsertPaymentCallback(client, {
      existingPayId: payment?.pay_id,
      payId: payId || payment?.pay_id || providerPaymentId,
      providerPaymentId,
      bookingGroupId,
      status,
      payload,
      processedAt: terminal && status !== 'paid' ? now : null,
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
      // Suspected double charge: a DIFFERENT payment of this group already
      // captured money. Never settle silently on top of it — flag for manual
      // review (refund of the extra capture) and alert staff (ADR-089).
      const otherPaid = paymentRowId
        ? await findOtherPaidPayment(client, bookingGroupId, paymentRowId)
        : null;
      if (otherPaid) {
        const transitioned = paymentRowId
          ? await markPaymentManualReview(client, paymentRowId)
          : false;
        console.error('Maib paid callback for a group with another paid payment — not settled', {
          ...callbackContext,
          otherPayId: otherPaid.pay_id,
        });
        if (transitioned) {
          await sendStaffAlert('Posibilă plată dublă — verifică și restituie', [
            `Booking group ${bookingGroupId} are deja plata ${otherPaid.pay_id} (${otherPaid.status}),`,
            `dar MAIB a confirmat încă o încasare pe ${paymentRowId}.`,
            `Oaspetele a plătit probabil de două ori — verifică în panoul maibmerchants`,
            `și restituie încasarea suplimentară din CRM.`,
          ]).catch((alertError) => console.error('Double-capture alert failed', alertError));
          await markPaymentProcessed(client, paymentRowId, new Date().toISOString());
        }
        return jsonResponse(
          { ok: true, status: 'duplicate_capture', requiresManualReview: true },
          {},
          request,
        );
      }

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
        const transitioned = paymentRowId
          ? await markPaymentManualReview(client, paymentRowId)
          : false;
        if (transitioned) {
          await sendStaffAlert('Plată încasată fără rezervare — restituire manuală', [
            `MAIB a confirmat plata pentru booking group ${bookingGroupId} (pay ${paymentRowId}),`,
            `dar nicio rezervare nu a putut fi confirmată (camera a fost re-rezervată după`,
            `expirarea hold-ului). Oaspetele a plătit fără să aibă cazare — restituie plata`,
            `din CRM și contactează-l.`,
          ]).catch((alertError) => console.error('Manual-review alert failed', alertError));
        }
        return jsonResponse(
          { ok: true, status: 'paid', matched: 0, requiresManualReview: true },
          {},
          request,
        );
      }

      if (paymentRowId) {
        await markPaymentProcessed(client, paymentRowId, new Date().toISOString());
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
    // The original failure used to vanish into a bare 500 — if it happened
    // after the payment row was written, nobody could tell why a paid booking
    // never settled.
    console.error('Maib callback failed', {
      message: error instanceof Error ? error.message : 'Unexpected error.',
    });
    return errorResponse(error, request);
  }
});

const CHANGE_ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      console.error(
        'Paid card callback for a non-pending change — not applied, manual refund review',
        {
          ...context,
          changeStatus: change.status,
        },
      );
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
