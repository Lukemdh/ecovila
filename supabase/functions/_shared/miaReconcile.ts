// MIA QR payment confirmation. Both the MIA callback (push) and the browser
// status poll (pull) call reconcileMiaBookingGroup. It never trusts the caller:
// it re-reads the authoritative payment state from MAIB with our OAuth token,
// so the callback signature key is not needed and a forged callback cannot
// settle a booking. Confirmed payments flow into the shared settlement core.
import { getMaibMiaPaymentByOrderId, normalizeMaibMiaPaymentStatus } from './maib.ts';
import {
  findOnlineReservationsForBookingGroup,
  findOtherPaidPayment,
  markPaymentManualReview,
  markPaymentProcessed,
  settleBookingGroupAsPaid,
} from './bookingSettlement.ts';
import { sendStaffAlert } from './alerts.ts';
import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type MiaPaymentRow = {
  pay_id: string;
  booking_group_id: string;
  amount?: number | string | null;
  currency?: string | null;
  status: string;
  checkout_url?: string | null;
  expires_at?: string | null;
  processed_at?: string | null;
};

export type MiaPublicStatus = 'paid' | 'pending' | 'failed' | 'expired' | 'not_found';

export type MiaReconcileResult = {
  status: MiaPublicStatus;
  qrUrl?: string;
  expiresAt?: string | null;
  amount?: number | null;
  currency?: string;
  matched?: number;
  requiresManualReview?: boolean;
  amountMismatch?: boolean;
};

export async function reconcileMiaBookingGroup(
  client: SupabaseClient,
  bookingGroupId: string,
  source: string,
): Promise<MiaReconcileResult> {
  const row = await findMiaPaymentRow(client, bookingGroupId);
  if (!row) {
    return { status: 'not_found' };
  }

  const base = {
    qrUrl: row.checkout_url || undefined,
    expiresAt: row.expires_at ?? null,
    amount: toAmount(row.amount),
    currency: row.currency || 'MDL',
  };

  // Fully settled (processed_at is stamped only AFTER settlement): nothing to
  // re-check. A paid-but-unprocessed row means the process died between the
  // MAIB confirmation and the reservations update — finish the settlement now
  // instead of short-circuiting, or the booking would be silently lost to the
  // expiry cron while the guest holds a "paid" screen (ADR-089).
  if (row.status === 'paid' || row.status === 'refunded') {
    if (row.processed_at) {
      return { status: 'paid', ...base };
    }
    return await settleConfirmedMiaPayment(client, row, bookingGroupId, source, base);
  }

  // Authoritative check against MAIB. A lookup failure must not flip the booking
  // to a terminal state — keep the stored status so the poller retries.
  let miaPayment;
  try {
    miaPayment = await getMaibMiaPaymentByOrderId(bookingGroupId);
  } catch (error) {
    console.error('MIA payment lookup failed', {
      bookingGroupId,
      message: error instanceof Error ? error.message : 'lookup failed',
    });
    return { status: storedToPublicStatus(row), ...base };
  }

  const executed = miaPayment && normalizeMaibMiaPaymentStatus(miaPayment.raw) === 'paid';
  if (!miaPayment || !executed) {
    return { status: storedToPublicStatus(row), ...base };
  }

  // Never settle a capture for the wrong amount — leave it pending for manual
  // review, mirroring the card callback's guard.
  const expected = toAmount(row.amount);
  if (
    miaPayment.amount !== null &&
    expected !== null &&
    Math.round(miaPayment.amount * 100) !== Math.round(expected * 100)
  ) {
    console.error('MIA paid amount mismatch — booking left pending for manual review', {
      bookingGroupId,
      captured: miaPayment.amount,
      expected,
    });
    return { status: 'pending', amountMismatch: true, ...base };
  }

  // Suspected double charge: another payment of this group already captured
  // money (e.g. the guest paid by card in a second tab). Flag for manual
  // review instead of settling on top of it (ADR-089).
  const otherPaid = await findOtherPaidPayment(client, bookingGroupId, row.pay_id);
  if (otherPaid) {
    const now = new Date().toISOString();
    await markMiaPaymentPaid(client, row.pay_id, miaPayment.payId, miaPayment.raw, now);
    const transitioned = await markPaymentManualReview(client, row.pay_id);
    console.error('MIA capture for a group with another paid payment — not settled', {
      bookingGroupId,
      payId: row.pay_id,
      otherPayId: otherPaid.pay_id,
    });
    if (transitioned) {
      await sendStaffAlert('Posibilă plată dublă (MIA) — verifică și restituie', [
        `Booking group ${bookingGroupId} are deja plata ${otherPaid.pay_id} (${otherPaid.status}),`,
        `dar MAIB confirmă și o încasare MIA pe ${row.pay_id}.`,
        `Oaspetele a plătit probabil de două ori — verifică în panoul maibmerchants`,
        `și restituie încasarea suplimentară din CRM.`,
      ]).catch((alertError) => console.error('Double-capture alert failed', alertError));
      await markPaymentProcessed(client, row.pay_id, new Date().toISOString());
    }
    return { status: 'paid', requiresManualReview: true, matched: 0, ...base };
  }

  const now = new Date().toISOString();
  // Record the executed payId in provider_payment_id so the existing refund flow
  // (which calls /v2/payments/{payId}/refund) targets the right payment.
  // processed_at is NOT stamped here — only after the settlement succeeds.
  await markMiaPaymentPaid(client, row.pay_id, miaPayment.payId, miaPayment.raw, now);

  return await settleConfirmedMiaPayment(client, row, bookingGroupId, source, base);
}

// The MAIB side is already proven paid; flip the reservations, then stamp the
// payment row processed. Shared by the fresh-confirmation path and the
// paid-but-unprocessed recovery path.
async function settleConfirmedMiaPayment(
  client: SupabaseClient,
  row: MiaPaymentRow,
  bookingGroupId: string,
  source: string,
  base: Omit<MiaReconcileResult, 'status'>,
): Promise<MiaReconcileResult> {
  const now = new Date().toISOString();
  const reservations = await findOnlineReservationsForBookingGroup(client, bookingGroupId);
  const settlement = await settleBookingGroupAsPaid(client, {
    bookingGroupId,
    reservations,
    now,
    source,
  });

  if (settlement.requiresManualReview) {
    console.error(
      'MIA paid settled no reservation — guest was charged, manual refund review required',
      { bookingGroupId, payId: row.pay_id },
    );
    const transitioned = await markPaymentManualReview(client, row.pay_id);
    if (transitioned) {
      await sendStaffAlert('Plată MIA încasată fără rezervare — restituire manuală', [
        `MAIB a confirmat plata MIA pentru booking group ${bookingGroupId} (pay ${row.pay_id}),`,
        `dar nicio rezervare nu a putut fi confirmată (camera a fost re-rezervată după`,
        `expirarea hold-ului). Oaspetele a plătit fără să aibă cazare — restituie plata`,
        `din CRM și contactează-l.`,
      ]).catch((alertError) => console.error('Manual-review alert failed', alertError));
    }
    return { status: 'paid', requiresManualReview: true, matched: 0, ...base };
  }

  await markPaymentProcessed(client, row.pay_id, new Date().toISOString());
  return { status: 'paid', matched: settlement.matched, ...base };
}

function storedToPublicStatus(row: MiaPaymentRow): MiaPublicStatus {
  if (row.status === 'paid' || row.status === 'refunded') {
    return 'paid';
  }
  if (row.status === 'failed') {
    return 'failed';
  }
  // 'cancelled' rows were retired by the expiry cron (or a stale-amount reset);
  // an open session whose window has lapsed reads the same to the guest.
  if (row.status === 'cancelled') {
    return 'expired';
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return 'expired';
  }
  return 'pending';
}

async function findMiaPaymentRow(
  client: SupabaseClient,
  bookingGroupId: string,
): Promise<MiaPaymentRow | null> {
  const { data, error } = await table<MiaPaymentRow>(client, 'maib_payments')
    .select(
      'pay_id, booking_group_id, amount, currency, status, checkout_url, expires_at, processed_at',
    )
    .eq('booking_group_id', bookingGroupId)
    .eq('payment_rail', 'mia')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function markMiaPaymentPaid(
  client: SupabaseClient,
  payId: string,
  miaPayId: string,
  raw: Record<string, unknown>,
  now: string,
) {
  // Deliberately leaves processed_at null: "paid but unprocessed" is the
  // crash-recovery marker that makes reconciliation re-run the settlement.
  const { error } = await table(client, 'maib_payments')
    .update({
      status: 'paid',
      provider_payment_id: miaPayId || null,
      callback_payload: { mia_payment: raw },
      updated_at: now,
    })
    .eq('pay_id', payId);

  if (error) {
    throw new Error(error.message);
  }
}

function toAmount(value: number | string | null | undefined): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
