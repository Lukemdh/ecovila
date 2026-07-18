// MAIB refund engine (ADR-088). Every refund goes through attemptBookingRefund,
// which (a) reads the provider's result.status instead of trusting the HTTP
// layer — a refund is confirmed on OK, on CREATED (MIA instant refunds report
// CREATED — verified against the maibmerchants statement, ADR-094), or on REVERSED
// ("previously refunded; repeated refunds are not allowed"). Anything else means the
// money has NOT been confirmed moved (e.g. the merchant settlement account had
// insufficient funds) — and (b) leaves every unresolved refund as a
// requested/processing/failed maib_refunds row that the reconcile-refunds cron
// retries until it succeeds. MAIB allows exactly one refund per payment, so the
// retry loop is safe by construction: re-attempting an already-executed refund
// returns REVERSED, which resolves the row instead of paying twice.
import { refundMaibPayment } from './maib.ts';
import { sendStaffAlert } from './alerts.ts';
import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

// Guest self-service refunds (ADR-096) are scheduled, not executed on the spot:
// scheduleBookingRefund stamps eligible_at = now + this many hours, and the
// reconcile-refunds cron pays them out only once that moment has passed. The
// window lets staff cancel a fraudulent/mistaken refund, or release it early.
export const REFUND_COOLDOWN_HOURS = 60;

export function refundEligibleAtIso(now: Date = new Date()): string {
  return new Date(now.getTime() + REFUND_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
}

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): Promise<SupabaseQueryResult>;
  update(payload: unknown): QueryBuilder<T>;
  upsert(payload: unknown, options?: Record<string, unknown>): Promise<SupabaseQueryResult>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  neq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
  lt(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

export type MaibRefundRow = {
  pay_id: string;
  booking_group_id: string;
  amount?: number | string | null;
  currency?: string | null;
  status?: string | null;
  reason?: string | null;
  response_payload?: Record<string, unknown> | null;
  provider_status?: string | null;
  attempts?: number | null;
  alerted_at?: string | null;
  eligible_at?: string | null;
  created_at?: string | null;
};

export type MaibRefundInterpretation = {
  completed: boolean;
  alreadyRefunded: boolean;
  providerStatus: string;
  refundId: string | null;
};

export type RefundAttemptOutcome = {
  // true only when the provider confirmed the refund (status OK, or REVERSED —
  // an earlier refund already executed). false means unresolved: the row stays
  // requested/processing/failed and the reconcile cron retries it.
  ok: boolean;
  alreadyRefunded?: boolean;
  // true when the attempt was refused because staff cancelled the scheduled
  // refund (ADR-096) — no MAIB call was made and no money moved.
  cancelled?: boolean;
  providerStatus?: string;
  refundId?: string | null;
  payload?: Record<string, unknown>;
  error?: string;
};

type RefundResponseBody = Record<string, unknown> & {
  result?: {
    refundId?: string | number | null;
    status?: string | null;
    statusMessage?: string | null;
  };
  refundId?: string | number | null;
  status?: string | null;
};

// A response with no status field at all is treated as completed: that was the
// pre-ADR-088 behavior for every refund that genuinely worked, and demoting it
// to "processing" would park every refund in limbo if the provider ever omits
// the field. The reconcile cron only ever touches rows that are NOT succeeded,
// so this default cannot resurrect a resolved refund.
export function interpretMaibRefundResponse(raw: unknown): MaibRefundInterpretation {
  const body = (raw && typeof raw === 'object' ? raw : {}) as RefundResponseBody;
  const result = body.result && typeof body.result === 'object' ? body.result : {};
  const providerStatus = String(result.status ?? body.status ?? '').trim().toUpperCase();
  const refundId = String(result.refundId ?? body.refundId ?? '').trim() || null;

  return {
    // MIA instant (bank-transfer) refunds report result.status CREATED on success:
    // the credit-transfer is created and settles immediately (verified against the
    // maibmerchants statement — Vera/Alina refunds, ADR-094). Treating CREATED as
    // unconfirmed parked every real MIA refund as "processing" and fired a false
    // "refund not finalized" staff alert. OK is the card/other success; REVERSED
    // means a refund already executed; anything else (or a thrown provider error)
    // stays a retryable row.
    completed: providerStatus === '' || providerStatus === 'OK' ||
      providerStatus === 'CREATED',
    alreadyRefunded: providerStatus === 'REVERSED',
    providerStatus,
    refundId,
  };
}

export async function findRefundRow(client: SupabaseClient, payId: string) {
  const { data, error } = await table<MaibRefundRow>(client, 'maib_refunds')
    .select(
      'pay_id, booking_group_id, amount, currency, status, reason, response_payload, provider_status, attempts, alerted_at, eligible_at, created_at',
    )
    .eq('pay_id', payId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

// Schedule a guest refund for the cooldown (ADR-096) WITHOUT calling MAIB: record
// the maib_refunds row as 'requested' with eligible_at = now + 60h, and let the
// reconcile-refunds cron execute it once due. Idempotent and clock-stable — a
// terminal row (succeeded/cancelled) is left alone, and an existing eligible_at is
// preserved so re-initiating never pushes the payout later.
export async function scheduleBookingRefund(
  client: SupabaseClient,
  input: {
    payId: string;
    bookingGroupId: string;
    amount: number;
    currency?: string;
    reason: string;
    source: string;
  },
): Promise<MaibRefundRow | null> {
  const existing = await findRefundRow(client, input.payId);
  if (existing?.status === 'succeeded' || existing?.status === 'cancelled') {
    return existing;
  }

  const now = new Date();
  const eligibleAt = existing?.eligible_at || refundEligibleAtIso(now);
  const { error } = await table(client, 'maib_refunds')
    .upsert({
      pay_id: input.payId,
      booking_group_id: input.bookingGroupId,
      amount: input.amount,
      currency: input.currency || 'MDL',
      // A row already mid-flight (processing) keeps that state; a fresh schedule
      // starts as requested. Either way the cron gates on eligible_at.
      status: existing?.status === 'processing' ? 'processing' : 'requested',
      reason: input.reason,
      request_payload: {
        amount: input.amount,
        reason: input.reason,
        source: input.source,
        scheduled: true,
      },
      eligible_at: eligibleAt,
      updated_at: now.toISOString(),
    }, { onConflict: 'pay_id' });

  if (error) throw new Error(error.message);
  return (await findRefundRow(client, input.payId)) ?? null;
}

export type ScheduledRefundCancelResult =
  | { ok: true; row: MaibRefundRow | null; alreadyCancelled?: boolean }
  | { ok: false; reason: 'not_found' | 'already_refunded' | 'already_processing' };

// Staff aborts a still-pending scheduled refund during the cooldown (ADR-096).
// Only a row that has NOT yet fired is cancellable: status 'requested' with a
// future eligible_at (the cron never sent it to MAIB). Once the cooldown elapses
// and the cron moves it to processing/succeeded/failed, the money may be in
// flight, so cancellation is refused. Terminal 'cancelled' is idempotent.
export async function cancelScheduledRefund(
  client: SupabaseClient,
  payId: string,
): Promise<ScheduledRefundCancelResult> {
  const existing = await findRefundRow(client, payId);
  if (!existing) {
    return { ok: false, reason: 'not_found' };
  }
  if (existing.status === 'cancelled') {
    return { ok: true, row: existing, alreadyCancelled: true };
  }
  if (existing.status === 'succeeded') {
    return { ok: false, reason: 'already_refunded' };
  }

  const notYetDue = Boolean(
    existing.eligible_at && new Date(existing.eligible_at).getTime() > Date.now(),
  );
  if (existing.status !== 'requested' || !notYetDue) {
    return { ok: false, reason: 'already_processing' };
  }

  const now = new Date().toISOString();
  // Guard the update on status='requested' so an execution that claims the row
  // between our read and write wins the race — we never cancel a sent refund.
  // The claim (attemptBookingRefund) moves the row to 'processing' before any
  // MAIB call, so this can only match a row that has NOT fired. Verify a row was
  // actually updated: 0 matches means the refund was claimed concurrently, and
  // reporting "cancelled" then would be a lie (ADR-099).
  const { data: cancelledRows, error } = await table<{ pay_id: string }[]>(client, 'maib_refunds')
    .update({
      status: 'cancelled',
      error_message: 'Restituire anulată de personal în perioada de așteptare.',
      updated_at: now,
    })
    .eq('pay_id', payId)
    .eq('status', 'requested')
    .select('pay_id');

  if (error) throw new Error(error.message);
  if (!cancelledRows || !cancelledRows.length) {
    return { ok: false, reason: 'already_processing' };
  }

  // Keep the Finance "Sumă rambursată" box honest: the booking stays cancelled,
  // but the money was NOT returned, so drop the "refunded" marker back to plain
  // guest_request for the group. Best-effort — the abort already succeeded.
  const { error: reasonError } = await table(client, 'reservations')
    .update({ cancellation_reason: 'guest_request' })
    .eq('booking_group_id', existing.booking_group_id)
    .eq('cancellation_reason', 'guest_request_refunded');
  if (reasonError) {
    console.error('Could not reset cancellation_reason after refund cancel', reasonError);
  }

  return { ok: true, row: (await findRefundRow(client, payId)) ?? null };
}

export async function attemptBookingRefund(
  client: SupabaseClient,
  input: {
    payId: string;
    providerPayId: string;
    bookingGroupId: string;
    amount: number;
    currency?: string;
    reason: string;
    source: string;
    // Only the deliberate staff refund path (maib-refund) may execute a refund
    // whose scheduled row staff previously cancelled — pressing "Restituie" after
    // an abort is an explicit decision to pay after all. Every other caller
    // (reconcile cron, scheduled-refunds release) must respect the abort.
    allowCancelled?: boolean;
  },
): Promise<RefundAttemptOutcome> {
  const existing = await findRefundRow(client, input.payId);
  if (existing?.status === 'succeeded') {
    return { ok: true, payload: existing.response_payload || {} };
  }

  const attempts = Number(existing?.attempts || 0) + 1;
  const now = new Date().toISOString();
  const claim = {
    booking_group_id: input.bookingGroupId,
    amount: input.amount,
    currency: input.currency || 'MDL',
    // 'processing' (not 'requested') from the moment the attempt is claimed:
    // cancelScheduledRefund's guard only matches 'requested' rows, so a claimed
    // attempt can never be "cancelled" while the MAIB call is in flight.
    status: 'processing',
    reason: input.reason,
    request_payload: { amount: input.amount, reason: input.reason, source: input.source },
    attempts,
    last_attempt_at: now,
    updated_at: now,
  };

  if (existing) {
    // Guarded claim instead of a blind upsert: a concurrent staff abort
    // (status 'cancelled') must win — the old upsert resurrected the row to
    // 'requested' and paid out a refund staff had just cancelled (ADR-099).
    let query = table<{ pay_id: string }[]>(client, 'maib_refunds')
      .update(claim)
      .eq('pay_id', input.payId);
    if (!input.allowCancelled) {
      query = query.neq('status', 'cancelled');
    }
    const { data: claimed, error: claimError } = await query.select('pay_id');
    if (claimError) throw new Error(claimError.message);
    if (!claimed || !claimed.length) {
      return {
        ok: false,
        cancelled: true,
        error: 'Restituirea a fost anulată de personal — nu se mai execută.',
      };
    }
  } else {
    const { error: insertError } = await table(client, 'maib_refunds')
      .insert({ pay_id: input.payId, ...claim });
    if (insertError) throw new Error(insertError.message);
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await refundMaibPayment(input.providerPayId, input.amount, input.reason)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Refund failed.';
    await updateRefundRow(client, input.payId, {
      status: 'failed',
      error_message: message,
      updated_at: new Date().toISOString(),
    });
    return { ok: false, error: message };
  }

  const verdict = interpretMaibRefundResponse(raw);
  const doneAt = new Date().toISOString();

  if (verdict.completed || verdict.alreadyRefunded) {
    await updateRefundRow(client, input.payId, {
      status: 'succeeded',
      response_payload: raw,
      provider_refund_id: verdict.refundId,
      provider_status: verdict.providerStatus || null,
      confirmed_at: doneAt,
      error_message: null,
      updated_at: doneAt,
    });
    await markPaymentRefunded(client, input.payId, raw, doneAt);
    return {
      ok: true,
      alreadyRefunded: verdict.alreadyRefunded,
      providerStatus: verdict.providerStatus,
      refundId: verdict.refundId,
      payload: raw,
    };
  }

  // MAIB acknowledged the request but did not confirm the money moved (a
  // non-OK result.status — the insufficient-settlement-funds shape). Keep the
  // row unresolved so the cron retries, and never mark the payment refunded.
  await updateRefundRow(client, input.payId, {
    status: 'processing',
    response_payload: raw,
    provider_status: verdict.providerStatus || null,
    error_message: null,
    updated_at: doneAt,
  });
  return {
    ok: false,
    providerStatus: verdict.providerStatus,
    refundId: verdict.refundId,
    payload: raw,
  };
}

// Staff alert for an unresolved (or REVERSED-resolved) refund, stamped on the
// row so the reconcile cron repeats it on a slow cadence instead of every tick.
export async function alertRefundProblem(
  client: SupabaseClient,
  input: {
    payId: string;
    bookingGroupId: string;
    amount: number | string | null | undefined;
    reason: string;
    detail: string;
    source: string;
  },
) {
  const result = await sendStaffAlert('Restituire nefinalizată', [
    `O restituire MAIB nu s-a finalizat și necesită atenție.`,
    `Booking group: ${input.bookingGroupId}`,
    `Pay ID: ${input.payId}`,
    `Sumă: ${input.amount ?? '?'} MDL`,
    `Motiv restituire: ${input.reason}`,
    `Detaliu: ${input.detail}`,
    `Sursă: ${input.source}`,
    '',
    'Sistemul reîncearcă automat la fiecare 30 de minute. Dacă contul de decontare',
    'nu are fonduri suficiente, alimentează-l — restituirea se va finaliza singură.',
    'Verifică și panoul maibmerchants pentru starea exactă a plății.',
  ]);

  await updateRefundRow(client, input.payId, {
    alerted_at: new Date().toISOString(),
  }).catch((error) => console.error('Could not stamp refund alerted_at', error));

  return result;
}

async function updateRefundRow(
  client: SupabaseClient,
  payId: string,
  values: Record<string, unknown>,
) {
  const { error } = await table(client, 'maib_refunds')
    .update(values)
    .eq('pay_id', payId);

  if (error) throw new Error(error.message);
}

async function markPaymentRefunded(
  client: SupabaseClient,
  payId: string,
  raw: Record<string, unknown>,
  now: string,
) {
  const { error } = await table(client, 'maib_payments')
    .update({
      status: 'refunded',
      refund_payload: raw,
      refunded_at: now,
      updated_at: now,
    })
    .eq('pay_id', payId);

  if (error) throw new Error(error.message);
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
