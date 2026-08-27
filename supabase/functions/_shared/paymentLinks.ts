import { sendStaffAlert } from './alerts.ts';
import {
  cancelMaibCheckout,
  cancelMaibMiaQr,
  getMaibCheckout,
  getMaibMiaPaymentByOrderId,
  normalizeMaibCheckoutStatus,
  normalizeMaibMiaPaymentStatus,
} from './maib.ts';
import type { MaibCallbackStatus } from './maib.ts';
import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CARD_CHECKOUT_LIFETIME_MS = 30 * 60 * 1000;
const TERMINAL_RECONCILE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type RpcClient = SupabaseClient & {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<SupabaseQueryResult<unknown>>;
};

export type PaymentLinkRail = 'mia' | 'card';
export type PaymentLinkPurpose = 'standalone' | 'accommodation_difference';

export type PaymentLinkRow = {
  id: string;
  amount: number | string;
  currency: string;
  payment_rail: PaymentLinkRail;
  label?: string | null;
  purpose: PaymentLinkPurpose;
  reservation_id: string | null;
  booking_group_id: string | null;
  room_type: string | null;
  status: 'active' | 'paid' | 'revoked';
  expires_at?: string | null;
  paid_at?: string | null;
  paid_amount?: number | string | null;
  revoked_at?: string | null;
  settled_attempt_id?: string | null;
  refunded_at?: string | null;
  refunded_amount?: number | string | null;
  refund_note?: string | null;
  manual_review: boolean;
  created_at: string;
  updated_at: string;
};

export type PaymentLinkAttemptRow = {
  id: string;
  payment_link_id: string;
  amount: number | string;
  currency: string;
  payment_rail: PaymentLinkRail;
  pay_id?: string | null;
  provider_payment_id?: string | null;
  status: 'creating' | 'pending' | 'paid' | 'failed' | 'cancelled';
  checkout_url?: string | null;
  provider_payload?: Record<string, unknown> | null;
  expires_at?: string | null;
  processed_at?: string | null;
  manual_review: boolean;
  created_at: string;
  updated_at: string;
};

export type PaymentLinkSettlementOutcome =
  | 'settled'
  | 'already'
  | 'duplicate_capture'
  | 'late_capture'
  | 'amount_mismatch';

export type PaymentLinkSettlementResult = {
  outcome: PaymentLinkSettlementOutcome;
  linkId?: string;
  attemptId?: string;
  settledAttemptId?: string;
  expectedAmount?: number;
  expectedCurrency?: string;
  providerAmount?: number;
  providerCurrency?: string;
  manualReview?: boolean;
  alert?: boolean;
  cancelPayId?: string;
  cancelRail?: PaymentLinkRail;
};

export type PaymentLinkReconcileResult = {
  status: 'paid' | 'pending' | 'failed' | 'cancelled' | 'review' | 'not_found';
  attempt?: PaymentLinkAttemptRow;
  outcome?: PaymentLinkSettlementOutcome;
  lookupFailed?: boolean;
};

export type PaymentLinkReconcileOptions = {
  sendAlert?: typeof sendStaffAlert;
  checkoutId?: string;
};

export async function reconcilePaymentLinkAttempt(
  client: SupabaseClient,
  attemptInput: string | PaymentLinkAttemptRow,
  source: string,
  options: PaymentLinkReconcileOptions = {},
): Promise<PaymentLinkReconcileResult> {
  let attempt = typeof attemptInput === 'string'
    ? await findPaymentLinkAttempt(client, attemptInput)
    : attemptInput;

  if (!attempt) {
    return { status: 'not_found' };
  }
  if (
    attempt.payment_rail === 'card' &&
    !String(attempt.pay_id || '').trim() &&
    String(options.checkoutId || '').trim()
  ) {
    attempt = await adoptCardCheckoutId(client, attempt, String(options.checkoutId).trim());
  }
  if (attempt.status === 'paid') {
    return {
      status: attempt.manual_review ? 'review' : 'paid',
      attempt,
      outcome: 'already',
    };
  }

  let provider: AuthoritativePayment | null;
  try {
    provider = await readAuthoritativePayment(attempt, source);
  } catch (error) {
    console.error('Payment-link MAIB lookup failed', {
      attemptId: attempt.id,
      rail: attempt.payment_rail,
      source,
      message: error instanceof Error ? error.message : 'lookup failed',
    });
    return { status: storedReconcileStatus(attempt), attempt, lookupFailed: true };
  }

  if (!provider || provider.status !== 'paid') {
    if (provider && (provider.status === 'failed' || provider.status === 'cancelled')) {
      const updated = await markAttemptTerminal(client, attempt, provider, source);
      return {
        status: updated.status === 'cancelled' ? 'cancelled' : 'failed',
        attempt: updated,
      };
    }
    if (provider?.status === 'pending') {
      return { status: 'pending', attempt };
    }
    return { status: storedReconcileStatus(attempt), attempt };
  }

  const providerAmount = provider.amount !== null && Number.isInteger(provider.amount)
    ? provider.amount
    : -1;
  const settlement = await settlePaymentLinkAttempt(client, {
    attemptId: attempt.id,
    providerPaymentId: provider.paymentId,
    providerAmount,
    providerCurrency: provider.currency,
    providerPayload: provider.payload,
    now: new Date().toISOString(),
  });

  if (
    settlement.alert !== false &&
    ['duplicate_capture', 'late_capture', 'amount_mismatch'].includes(settlement.outcome)
  ) {
    await alertSettlementProblem(
      settlement,
      attempt,
      provider,
      source,
      options.sendAlert || sendStaffAlert,
    );
  }

  if (settlement.cancelPayId && settlement.cancelRail) {
    await cancelSiblingAttempt(
      client,
      settlement.cancelPayId,
      settlement.cancelRail,
      attempt.id,
      source,
    );
  }

  return {
    status: settlement.manualReview ? 'review' : 'paid',
    attempt: {
      ...attempt,
      provider_payment_id: provider.paymentId || attempt.provider_payment_id || null,
      provider_payload: provider.payload,
      status: settlement.outcome === 'amount_mismatch' ? attempt.status : 'paid',
      processed_at: settlement.outcome === 'amount_mismatch'
        ? attempt.processed_at
        : new Date().toISOString(),
      manual_review: Boolean(settlement.manualReview),
    },
    outcome: settlement.outcome,
  };
}

export async function findPaymentLinkAttempt(
  client: SupabaseClient,
  attemptId: string,
): Promise<PaymentLinkAttemptRow | null> {
  if (!UUID_PATTERN.test(attemptId)) {
    return null;
  }

  const { data, error } = await table<PaymentLinkAttemptRow>(client, 'payment_link_attempts')
    .select('*')
    .eq('id', attemptId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  return data ?? null;
}

export async function findPaymentLinkAttemptForCallback(
  client: SupabaseClient,
  input: { payId?: string; orderId?: string; providerPaymentId?: string },
): Promise<PaymentLinkAttemptRow | null> {
  const payId = String(input.payId || '').trim();
  if (payId) {
    const byPayId = await findAttemptByColumn(client, 'pay_id', payId);
    if (byPayId) return byPayId;
  }

  const providerPaymentId = String(input.providerPaymentId || '').trim();
  if (providerPaymentId) {
    const byProviderPaymentId = await findAttemptByColumn(
      client,
      'provider_payment_id',
      providerPaymentId,
    );
    if (byProviderPaymentId) return byProviderPaymentId;
  }

  const orderId = String(input.orderId || '').trim();
  return orderId ? await findPaymentLinkAttempt(client, orderId) : null;
}

export async function findPaymentLinkAttemptForCallbackFailOpen(
  client: SupabaseClient,
  input: { payId?: string; orderId?: string; providerPaymentId?: string },
  source: string,
): Promise<PaymentLinkAttemptRow | null> {
  try {
    return await findPaymentLinkAttemptForCallback(client, input);
  } catch (error) {
    // Payment links are additive to the older booking/change callback paths.
    // A missing migration, stale schema cache, or transient PostgREST failure
    // must therefore behave exactly like an unmatched payment-link callback.
    console.error('Payment-link callback lookup failed; continuing with reservation routing', {
      source,
      orderId: String(input.orderId || '').trim() || null,
      payId: String(input.payId || '').trim() || null,
      message: error instanceof Error ? error.message : 'lookup failed',
    });
    return null;
  }
}

export function isPaymentLinkAttemptAuthoritativelyResolved(
  attempt: PaymentLinkAttemptRow,
) {
  if (attempt.status === 'paid') return true;

  const payload = attempt.provider_payload;
  if (!isRecord(payload)) return false;
  if (isRecord(payload.checkout)) {
    return normalizeMaibCheckoutStatus(payload.checkout) !== 'pending';
  }
  if (isRecord(payload.miaPayment)) {
    return normalizeMaibMiaPaymentStatus(payload.miaPayment) !== 'pending';
  }
  return false;
}

export function shouldReconcilePaymentLinkAttempt(
  attempt: PaymentLinkAttemptRow | null,
  now: Date,
) {
  if (!attempt?.pay_id || isPaymentLinkAttemptAuthoritativelyResolved(attempt)) return false;

  const checkoutDeadline = attempt.expires_at
    ? new Date(attempt.expires_at).getTime()
    : new Date(attempt.created_at).getTime() + CARD_CHECKOUT_LIFETIME_MS;
  if (!Number.isFinite(checkoutDeadline)) return false;

  // Provider sessions live for at most 30 minutes. Re-read unresolved attempts
  // for seven more days: enough for delayed callbacks/returns and operational
  // recovery, while ensuring a dead attempt is not queried on every poll forever.
  return now.getTime() <= checkoutDeadline + TERMINAL_RECONCILE_GRACE_MS;
}

export async function settlePaymentLinkAttempt(
  client: SupabaseClient,
  input: {
    attemptId: string;
    providerPaymentId: string;
    providerAmount: number;
    providerCurrency: string;
    providerPayload: Record<string, unknown>;
    now: string;
  },
): Promise<PaymentLinkSettlementResult> {
  const { data, error } = await (client as RpcClient).rpc('settle_payment_link_attempt', {
    p_attempt_id: input.attemptId,
    p_provider_payment_id: input.providerPaymentId || null,
    p_provider_amount: input.providerAmount,
    p_provider_currency: input.providerCurrency,
    p_provider_payload: input.providerPayload,
    p_now: input.now,
  });

  if (error) {
    throw new Error(error.message);
  }
  if (!isRecord(data) || !isSettlementOutcome(data.outcome)) {
    throw new Error('Payment-link settlement returned an invalid result.');
  }

  return data as PaymentLinkSettlementResult;
}

type AuthoritativePayment = {
  status: MaibCallbackStatus;
  amount: number | null;
  currency: string;
  paymentId: string;
  payload: Record<string, unknown>;
};

async function adoptCardCheckoutId(
  client: SupabaseClient,
  attempt: PaymentLinkAttemptRow,
  checkoutId: string,
): Promise<PaymentLinkAttemptRow> {
  const now = new Date().toISOString();
  const { error } = await table(client, 'payment_link_attempts')
    .update({ pay_id: checkoutId, updated_at: now })
    .eq('id', attempt.id)
    .is('pay_id', null);

  if (error) {
    throw new Error(error.message);
  }

  const current = await findPaymentLinkAttempt(client, attempt.id);
  if (!current) {
    throw new Error('Payment-link attempt disappeared while adopting the MAIB checkout id.');
  }
  if (String(current.pay_id || '').trim() !== checkoutId) {
    throw new Error('Payment-link attempt already has a different MAIB checkout id.');
  }
  return current;
}

async function readAuthoritativePayment(
  attempt: PaymentLinkAttemptRow,
  source: string,
): Promise<AuthoritativePayment | null> {
  if (attempt.payment_rail === 'card') {
    const checkoutId = String(attempt.pay_id || '').trim();
    if (!checkoutId) return null;

    const checkout = await getMaibCheckout(checkoutId);
    return {
      status: normalizeMaibCheckoutStatus(checkout),
      amount: checkout.amount,
      currency: checkout.currency,
      paymentId: checkout.paymentId,
      payload: {
        source,
        checkout: {
          checkoutId,
          status: checkout.status,
          amount: checkout.amount,
          currency: checkout.currency,
          orderId: checkout.orderId,
          paymentId: checkout.paymentId,
          paymentStatus: checkout.paymentStatus,
        },
      },
    };
  }

  const payment = await getMaibMiaPaymentByOrderId(attempt.id);
  if (!payment) return null;
  // The MIA adapter supplies provider defaults (notably MDL when the item omits
  // currency). Settlement must use that normalized contract, not the raw item.
  const currency = String(payment.currency || 'MDL').trim() || 'MDL';

  return {
    status: normalizeMaibMiaPaymentStatus(payment.raw),
    amount: payment.amount,
    currency,
    paymentId: payment.payId,
    payload: {
      source,
      miaPayment: {
        payId: payment.payId,
        qrId: payment.qrId,
        orderId: payment.orderId,
        status: payment.status,
        amount: payment.amount,
        currency,
      },
    },
  };
}

async function markAttemptTerminal(
  client: SupabaseClient,
  attempt: PaymentLinkAttemptRow,
  provider: AuthoritativePayment,
  source: string,
): Promise<PaymentLinkAttemptRow> {
  const now = new Date().toISOString();
  const status = provider.status === 'cancelled' ? 'cancelled' : 'failed';
  const payload = { ...provider.payload, source };
  const { error } = await table(client, 'payment_link_attempts')
    .update({
      status,
      provider_payment_id: provider.paymentId || null,
      provider_payload: payload,
      processed_at: now,
      updated_at: now,
    })
    .eq('id', attempt.id)
    .in('status', ['creating', 'pending', 'failed', 'cancelled']);

  if (error) {
    throw new Error(error.message);
  }

  const current = await findPaymentLinkAttempt(client, attempt.id);
  return current || {
    ...attempt,
    status,
    provider_payment_id: provider.paymentId || attempt.provider_payment_id || null,
    provider_payload: payload,
    processed_at: now,
    updated_at: now,
  };
}

async function findAttemptByColumn(
  client: SupabaseClient,
  column: 'pay_id' | 'provider_payment_id',
  value: string,
) {
  const { data, error } = await table<PaymentLinkAttemptRow>(client, 'payment_link_attempts')
    .select('*')
    .eq(column, value)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  return data ?? null;
}

function storedReconcileStatus(
  attempt: PaymentLinkAttemptRow,
): PaymentLinkReconcileResult['status'] {
  if (attempt.manual_review) return 'review';
  if (attempt.status === 'failed') return 'failed';
  if (attempt.status === 'cancelled') return 'cancelled';
  return 'pending';
}

async function alertSettlementProblem(
  settlement: PaymentLinkSettlementResult,
  attempt: PaymentLinkAttemptRow,
  provider: AuthoritativePayment,
  source: string,
  alertSender: typeof sendStaffAlert,
) {
  const titles: Record<Exclude<PaymentLinkSettlementOutcome, 'settled' | 'already'>, string> = {
    duplicate_capture: 'Plată dublă pe link — verifică și restituie',
    late_capture: 'Plată târzie pe link — verificare manuală',
    amount_mismatch: 'Sumă neconformă încasată pe link — verificare manuală',
  };
  const outcome = settlement.outcome;
  if (outcome === 'settled' || outcome === 'already') return;

  await alertSender(titles[outcome], [
    `Payment link: ${settlement.linkId || attempt.payment_link_id}`,
    `Attempt: ${attempt.id}`,
    `Rail: ${attempt.payment_rail}`,
    `Outcome: ${outcome}`,
    `Expected: ${attempt.amount} ${attempt.currency}`,
    `Provider: ${provider.amount ?? '?'} ${provider.currency || '?'}`,
    `Source: ${source}`,
  ]).catch((error) => console.error('Payment-link staff alert failed', error));
}

export async function cancelProviderAttempt(
  payId: string,
  rail: PaymentLinkRail,
  reason: string,
) {
  if (rail === 'card') {
    await cancelMaibCheckout(payId, reason);
    return;
  }
  try {
    await cancelMaibMiaQr(payId, reason);
  } catch (error) {
    console.error('Could not cancel payment-link MIA QR', {
      payId,
      reason,
      message: error instanceof Error ? error.message : 'cancel failed',
    });
  }
}

async function cancelSiblingAttempt(
  client: SupabaseClient,
  payId: string,
  rail: PaymentLinkRail,
  settledAttemptId: string,
  source: string,
) {
  if (rail === 'card') {
    await cancelMaibCheckout(payId, 'payment_link_settled');
  } else {
    try {
      await cancelMaibMiaQr(payId, 'payment_link_settled');
    } catch (error) {
      console.error('Could not cancel sibling payment-link MIA QR', {
        payId,
        settledAttemptId,
        message: error instanceof Error ? error.message : 'cancel failed',
      });
    }
  }

  const sibling = await findPaymentLinkAttemptForCallback(client, { payId });
  if (sibling && sibling.id !== settledAttemptId) {
    await reconcilePaymentLinkAttempt(client, sibling, `${source}-cancelled-sibling`);
  }
}

function isSettlementOutcome(value: unknown): value is PaymentLinkSettlementOutcome {
  return ['settled', 'already', 'duplicate_capture', 'late_capture', 'amount_mismatch'].includes(
    String(value || ''),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}

export async function findUnrefundedAccommodationDifferences(
  client: SupabaseClient,
  reservationIds: string[],
): Promise<PaymentLinkRow[]> {
  if (!reservationIds.length) {
    return [];
  }

  const { data, error } = await table<PaymentLinkRow[]>(client, 'payment_links')
    .select('*')
    .eq('purpose', 'accommodation_difference')
    .eq('status', 'paid')
    .in('reservation_id', reservationIds);

  if (error) {
    throw new Error(error.message);
  }

  const unverified = (data || []).filter((link) => verifiedPaidAmount(link.paid_amount) === null);
  if (unverified.length) {
    throw new Error(
      `Paid accommodation difference has missing or invalid paid_amount (UNVERIFIED): ${
        unverified.map((link) => link.id).join(', ')
      }`,
    );
  }

  return (data || []).filter((link) => {
    const paid = verifiedPaidAmount(link.paid_amount) ?? 0;
    const refunded = Number(link.refunded_amount || 0);
    return paid - refunded > 0;
  });
}

export function sumUnrefundedDifferenceAmount(
  links: Array<{
    amount: number | string;
    paid_amount?: number | string | null;
    refunded_amount?: number | string | null;
  }>,
): number {
  return links.reduce((sum, link) => {
    const paid = verifiedPaidAmount(link.paid_amount) ?? 0;
    const refunded = Number(link.refunded_amount || 0);
    return sum + Math.max(0, paid - refunded);
  }, 0);
}

export async function alertUnrefundedAccommodationDifferences(
  input: {
    bookingGroupId: string;
    reservationIds: string[];
    links: Array<{
      id: string;
      amount: number | string;
      paid_amount?: number | string | null;
      currency?: string | null;
    }>;
    totalAmount: number;
    guestName?: string | null;
    guestPhone?: string | null;
  },
  alertSender: typeof sendStaffAlert = sendStaffAlert,
) {
  const linkSummary = input.links
    .map((link) => {
      const paid = verifiedPaidAmount(link.paid_amount);
      return `${link.id} (${paid === null ? 'UNVERIFIED' : paid} ${link.currency || 'MDL'})`;
    })
    .join(', ');

  return await alertSender('Diferență cazare de restituit manual la anulare', [
    'O rezervare cu diferență de cazare achitată prin link a fost anulată.',
    'Suma din link nu este inclusă în restituirea automată și trebuie restituită manual în portalul MAIB.',
    `Booking group: ${input.bookingGroupId}`,
    `Rezervări: ${input.reservationIds.join(', ')}`,
    `Payment link: ${linkSummary}`,
    `Sumă de restituit manual: ${input.totalAmount} MDL`,
    input.guestName ? `Client: ${input.guestName}` : null,
    input.guestPhone ? `Telefon: ${input.guestPhone}` : null,
  ]);
}

export async function alertAccommodationDifferenceVerificationFailure(
  input: {
    bookingGroupId: string;
    reservationIds: string[];
    guestPhone?: string | null;
    error: string;
  },
  alertSender: typeof sendStaffAlert = sendStaffAlert,
) {
  return await alertSender('Verificare eșuată a diferenței de cazare la anulare', [
    'Rezervarea a fost anulată, dar linkurile pentru diferența de cazare nu au putut fi verificate.',
    'Restituirea de bază rămâne programată. Verifică manual payment_links și contactează clientul.',
    `Booking group: ${input.bookingGroupId}`,
    `Rezervări: ${input.reservationIds.join(', ')}`,
    input.guestPhone ? `Telefon: ${input.guestPhone}` : null,
    `Eroare verificare: ${input.error}`,
  ]);
}

function verifiedPaidAmount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const paid = Number(value);
  return Number.isSafeInteger(paid) && paid > 0 ? paid : null;
}
