// Refund reconciliation cron (ADR-088). Re-attempts every MAIB refund that was
// requested but never confirmed (status requested/processing/failed) until it
// resolves — the "insufficient settlement funds" case fixes itself here as soon
// as the account is topped up. MAIB permits a single refund per payment, so a
// retry of an already-executed refund returns REVERSED and simply resolves the
// row; the loop can never pay a guest twice. Unresolved rows re-alert staff on
// a slow cadence, and paid-but-unrefunded "add guests" differences belonging to
// refunded bookings are swept along.
import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, requireSharedSecret } from '../_shared/http.ts';
import { sendStaffAlert } from '../_shared/alerts.ts';
import {
  alertRefundProblem,
  attemptBookingRefund,
  type MaibRefundRow,
} from '../_shared/refunds.ts';
import { refundPaidChanges } from '../_shared/reservationChanges.ts';
import type { ChangeRefundResult } from '../_shared/reservationChanges.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type PaymentRow = {
  pay_id: string;
  provider_payment_id?: string | null;
  booking_group_id: string;
  amount?: number | string | null;
  currency?: string | null;
  status?: string | null;
};

type OrphanChangeRow = {
  id: string;
  booking_group_id: string;
};

// Bounded per tick: refunds are rare, and a short list keeps the MAIB call
// volume trivial even if a backlog ever builds up.
const MAX_REFUNDS_PER_RUN = 20;
const MAX_ORPHAN_GROUPS_PER_RUN = 10;
// Rows older than this stop being retried automatically — by then the money
// question is a support case, not a retry loop. Alerts have long since fired.
const MAX_AGE_DAYS = 60;
// Staff re-alert cadence for a refund that keeps failing.
const REALERT_MS = 6 * 60 * 60 * 1000;

type RefundReconcileOutcome = {
  payId: string;
  bookingGroupId: string;
  resolved: boolean;
  alreadyRefunded?: boolean;
  providerStatus?: string;
  error?: string;
  alerted?: boolean;
};

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST', 'GET']);
    requireSharedSecret(request);

    const client = createServiceClient();
    const unresolved = await findUnresolvedRefunds(client);
    const outcomes: RefundReconcileOutcome[] = [];
    const touchedGroups = new Set<string>();

    for (const refund of unresolved) {
      outcomes.push(await reconcileRefund(client, refund));
      touchedGroups.add(refund.booking_group_id);
    }

    // Differences whose original refund already succeeded (so the row above no
    // longer selects) but whose own MAIB transaction never confirmed.
    const orphanResults = await sweepOrphanedChangeRefunds(client, touchedGroups);

    return jsonResponse(
      {
        ok: true,
        checked: unresolved.length,
        resolved: outcomes.filter((outcome) => outcome.resolved).length,
        outcomes,
        orphanResults,
      },
      {},
      request,
    );
  } catch (error) {
    console.error('Refund reconciliation failed', error);
    return errorResponse(error, request);
  }
});

async function findUnresolvedRefunds(client: SupabaseClient) {
  const oldestIso = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await table<MaibRefundRow[]>(client, 'maib_refunds')
    .select(
      'pay_id, booking_group_id, amount, currency, status, reason, provider_status, attempts, alerted_at, created_at',
    )
    .in('status', ['requested', 'processing', 'failed'])
    .gt('created_at', oldestIso)
    .order('updated_at', { ascending: true })
    .limit(MAX_REFUNDS_PER_RUN);

  if (error) throw new Error(error.message);
  return data || [];
}

async function reconcileRefund(
  client: SupabaseClient,
  refund: MaibRefundRow,
): Promise<RefundReconcileOutcome> {
  const base = { payId: refund.pay_id, bookingGroupId: refund.booking_group_id };

  let payment: PaymentRow | null = null;
  try {
    payment = (await findPaymentRow(client, refund.pay_id)) ?? null;
  } catch (error) {
    return {
      ...base,
      resolved: false,
      error: error instanceof Error ? error.message : 'Payment lookup failed.',
    };
  }

  if (!payment) {
    // A refund row without its payment should be impossible (FK); alert rather
    // than retry forever against nothing.
    const alerted = await maybeAlert(client, refund, 'Rândul de plată MAIB nu mai există.');
    return { ...base, resolved: false, error: 'payment_row_missing', alerted };
  }

  const amount = Number(refund.amount || payment.amount || 0);
  if (!(amount > 0)) {
    const alerted = await maybeAlert(client, refund, 'Suma restituirii este invalidă.');
    return { ...base, resolved: false, error: 'invalid_amount', alerted };
  }

  const outcome = await attemptBookingRefund(client, {
    payId: payment.pay_id,
    providerPayId: payment.provider_payment_id || payment.pay_id,
    bookingGroupId: refund.booking_group_id,
    amount,
    currency: payment.currency || refund.currency || 'MDL',
    reason: refund.reason || 'reconcile',
    source: 'reconcile-refunds',
  });

  if (outcome.ok) {
    if (outcome.alreadyRefunded) {
      // REVERSED on a retry: MAIB reports a refund already exists for this
      // payment. That resolves the row, but because the FIRST attempt did not
      // confirm, ask staff to eyeball the maibmerchants panel once.
      await sendStaffAlert('Restituire rezolvată prin REVERSED — verifică panoul MAIB', [
        `Restituirea pentru booking group ${refund.booking_group_id} (pay ${refund.pay_id})`,
        `s-a rezolvat cu statusul REVERSED la o reîncercare: MAIB raportează că plata`,
        `fusese deja restituită. Verifică în panoul maibmerchants că suma de`,
        `${amount} MDL a ajuns efectiv la client.`,
      ]).catch((alertError) => console.error('REVERSED alert failed', alertError));
    }
    return {
      ...base,
      resolved: true,
      alreadyRefunded: outcome.alreadyRefunded,
      providerStatus: outcome.providerStatus,
    };
  }

  const alerted = await maybeAlert(
    client,
    refund,
    outcome.error || `Răspuns MAIB fără confirmare (status: ${outcome.providerStatus || '?'}).`,
  );

  return {
    ...base,
    resolved: false,
    providerStatus: outcome.providerStatus,
    error: outcome.error,
    alerted,
  };
}

async function maybeAlert(client: SupabaseClient, refund: MaibRefundRow, detail: string) {
  const lastAlert = refund.alerted_at ? new Date(refund.alerted_at).getTime() : 0;
  if (Number.isFinite(lastAlert) && Date.now() - lastAlert < REALERT_MS) {
    return false;
  }

  await alertRefundProblem(client, {
    payId: refund.pay_id,
    bookingGroupId: refund.booking_group_id,
    amount: refund.amount,
    reason: refund.reason || 'reconcile',
    detail: `${detail} (încercarea ${Number(refund.attempts || 0) + 1})`,
    source: 'reconcile-refunds',
  }).catch((error) => console.error('Refund alert failed', error));

  return true;
}

// "Add guests" differences are separate MAIB transactions with no maib_refunds
// row of their own. When a booking's refund flow ran, any difference left
// 'paid' + unrefunded needs the same retry treatment. A change qualifies when
// its booking group has ANY maib_refunds row — that row only ever exists after
// a cancellation-with-refund was initiated for the group.
async function sweepOrphanedChangeRefunds(
  client: SupabaseClient,
  alreadyTouched: Set<string>,
): Promise<Array<{ bookingGroupId: string; refunds: ChangeRefundResult[] }>> {
  const { data, error } = await table<OrphanChangeRow[]>(client, 'reservation_changes')
    .select('id, booking_group_id')
    .eq('status', 'paid')
    .is('refunded_at', null)
    .gt('difference_amount', 0);

  if (error) throw new Error(error.message);

  const groups = [...new Set((data || []).map((change) => change.booking_group_id))];
  const results: Array<{ bookingGroupId: string; refunds: ChangeRefundResult[] }> = [];

  for (const bookingGroupId of groups.slice(0, MAX_ORPHAN_GROUPS_PER_RUN)) {
    // Groups whose refunds ran this tick are skipped — attemptBookingRefund's
    // callers already invoke refundPaidChanges through the cancellation paths,
    // and skipping avoids double MAIB calls inside a single run.
    if (alreadyTouched.has(bookingGroupId)) {
      continue;
    }

    const { data: refundRow, error: refundError } = await table<{ pay_id: string }>(
      client,
      'maib_refunds',
    )
      .select('pay_id')
      .eq('booking_group_id', bookingGroupId)
      .limit(1)
      .maybeSingle();

    if (refundError) throw new Error(refundError.message);
    if (!refundRow) {
      // The booking was never refund-cancelled (e.g. a live booking with a paid
      // change) — nothing to reverse.
      continue;
    }

    try {
      const refunds = await refundPaidChanges(client, bookingGroupId, 'reconcile');
      if (refunds.length) {
        results.push({ bookingGroupId, refunds });
      }
    } catch (sweepError) {
      console.error('Orphaned change refund sweep failed', { bookingGroupId, sweepError });
    }
  }

  return results;
}

async function findPaymentRow(client: SupabaseClient, payId: string) {
  const { data, error } = await table<PaymentRow>(client, 'maib_payments')
    .select('pay_id, provider_payment_id, booking_group_id, amount, currency, status')
    .eq('pay_id', payId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
