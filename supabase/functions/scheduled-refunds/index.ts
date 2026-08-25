// Staff controls for the guest refund cooldown (ADR-096). Guest self-service
// cancellations schedule their refund for 60h later instead of paying it out on
// the spot; during that window the owner (diana) can:
//   * list    — see every refund still cooling down (amount, guest, ETA),
//   * cancel  — abort a refund judged fraudulent/mistaken (money stays; the
//               booking's "refunded" marker is reset so Finance stays honest),
//   * release — pay it out immediately instead of waiting for the cron.
// All three run with the service role, so no maib_refunds RLS is exposed to the
// browser. Staff/CRM-initiated refunds (maib-refund) are unaffected — they still
// fire immediately and never appear here.
import { handleCors } from '../_shared/cors.ts';
import {
  assertMethod,
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireStaffRole,
} from '../_shared/http.ts';
import {
  alertRefundProblem,
  attemptBookingRefund,
  cancelScheduledRefund,
  findRefundRow,
  type MaibRefundRow,
  quoteFromRefundRow,
} from '../_shared/refunds.ts';
import { refundPaidChanges } from '../_shared/reservationChanges.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';
import { aggregateRefundQuotes } from '../_shared/refundIntents.ts';
import type { RefundQuote } from '../_shared/refundPolicy.ts';
import { activeCommissionBps } from '../_shared/refundPolicy.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  range(from: number, to: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type RoomRelation = { number?: number | string | null; type?: string | null };

type ScheduledRefundRow = {
  pay_id: string;
  booking_group_id: string;
  amount?: number | string | null;
  gross_amount?: number | string | null;
  withheld_commission?: number | string | null;
  commission_rate_bps?: number | string | null;
  refund_policy_version?: string | null;
  currency?: string | null;
  status?: string | null;
  reason?: string | null;
  eligible_at?: string | null;
  created_at?: string | null;
};

type ReservationRow = {
  booking_group_id: string;
  guest_first_name?: string | null;
  guest_last_name?: string | null;
  check_in?: string | null;
  check_out?: string | null;
  rooms?: RoomRelation | RoomRelation[] | null;
};

type PaymentRow = {
  pay_id: string;
  provider_payment_id?: string | null;
  booking_group_id?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  status?: string | null;
};

type ChangeQuoteRow = {
  booking_group_id: string;
  refund_amount?: number | string | null;
  refund_withheld?: number | string | null;
  refund_rate_bps?: number | string | null;
  refund_policy_version?: string | null;
};

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    await requireStaffRole(request, ['diana']);

    const body = await readJson(request);
    const action = String(body?.action || 'list').trim();
    const client = createServiceClient();

    if (action === 'list') {
      return jsonResponse(
        {
          ok: true,
          refunds: await listScheduledRefunds(client),
          activeCommissionBps: activeCommissionBps(),
        },
        {},
        request,
      );
    }

    if (action === 'refunded-groups') {
      // Booking groups whose money was actually returned. The CRM can't read the
      // RLS-locked payment tables, and cancellation_reason is an unreliable proxy
      // (the CRM cancel stamps 'Anulat din CRM', the guest card path
      // 'guest_request_refunded', etc.), so the Finance tab asks here for the
      // truth to decide which cancellations are "rambursat".
      //
      // Two shapes on purpose. `groups` stays the plain id list it has always
      // been, because the function deploys days before the owner uploads the
      // frontend: a CRM still running the old bundle would turn a list of
      // objects into a Set of objects and report every refunded cancellation as
      // "fără rambursare". `refunds` carries the amounts (ADR-104) and the new
      // bundle prefers it.
      const refunds = await refundedBookingGroups(client);
      return jsonResponse(
        { ok: true, groups: refunds.map((entry) => entry.bookingGroupId), refunds },
        {},
        request,
      );
    }

    const payId = optionalString(body?.payId);
    const bookingGroupId = optionalString(body?.bookingGroupId);
    if (!payId && !bookingGroupId) {
      throw new HttpError(400, 'payId or bookingGroupId is required.');
    }

    const resolvedPayId = payId || (await payIdForGroup(client, bookingGroupId));
    if (!resolvedPayId) {
      throw new HttpError(404, 'Scheduled refund was not found.');
    }

    if (action === 'cancel') {
      const result = await cancelScheduledRefund(client, resolvedPayId);
      if (!result.ok) {
        throw new HttpError(409, cancelReasonMessage(result.reason));
      }
      return jsonResponse(
        { ok: true, status: 'cancelled', alreadyCancelled: Boolean(result.alreadyCancelled) },
        {},
        request,
      );
    }

    if (action === 'release') {
      return jsonResponse(await releaseNow(client, resolvedPayId), {}, request);
    }

    throw new HttpError(400, 'Unknown action.');
  } catch (error) {
    return errorResponse(error, request);
  }
});

// Every refund still cooling down: status 'requested' with a future eligible_at.
// Enriched with the booking's guest + villa detail for the CRM list.
async function listScheduledRefunds(client: SupabaseClient) {
  const nowIso = new Date().toISOString();
  const { data: refunds, error } = await table<ScheduledRefundRow[]>(client, 'maib_refunds')
    .select(
      'pay_id, booking_group_id, amount, gross_amount, withheld_commission, commission_rate_bps, refund_policy_version, currency, status, reason, eligible_at, created_at',
    )
    .eq('status', 'requested')
    .gt('eligible_at', nowIso)
    .order('eligible_at', { ascending: true })
    .limit(200);

  if (error) throw new Error(error.message);
  const rows = refunds || [];
  if (!rows.length) {
    return [];
  }

  const groupIds = [...new Set(rows.map((row) => row.booking_group_id))];
  const { data: reservations, error: resError } = await table<ReservationRow[]>(
    client,
    'reservations',
  )
    .select(
      'booking_group_id, guest_first_name, guest_last_name, check_in, check_out, rooms(number, type)',
    )
    .in('booking_group_id', groupIds);

  if (resError) throw new Error(resError.message);

  const byGroup = new Map<string, ReservationRow[]>();
  for (const reservation of reservations || []) {
    const list = byGroup.get(reservation.booking_group_id) || [];
    list.push(reservation);
    byGroup.set(reservation.booking_group_id, list);
  }

  const changeQuotes = await storedChangeQuotes(client, groupIds);

  return rows.map((refund) => {
    const group = byGroup.get(refund.booking_group_id) || [];
    const primary = group[0];
    const mainQuote = quoteFromRefundRow(refund);
    const totalQuote = aggregateRefundQuotes([
      mainQuote,
      ...(changeQuotes.get(refund.booking_group_id) || []),
    ]);
    return {
      payId: refund.pay_id,
      bookingGroupId: refund.booking_group_id,
      amount: Number(refund.amount || 0),
      refundQuote: publicQuote(mainQuote),
      refundTotal: publicQuote(totalQuote),
      currency: refund.currency || 'MDL',
      eligibleAt: refund.eligible_at || null,
      createdAt: refund.created_at || null,
      guestName: primary
        ? `${primary.guest_first_name || ''} ${primary.guest_last_name || ''}`.trim()
        : '',
      checkIn: primary?.check_in || '',
      checkOut: primary?.check_out || '',
      villas: group.map((row) => {
        const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
        return { number: room?.number ?? null, type: room?.type ?? '' };
      }),
    };
  });
}

// Release a scheduled refund immediately instead of waiting out the cooldown:
// execute the main refund now and sweep any paid "add guests" differences.
async function releaseNow(client: SupabaseClient, payId: string) {
  const refund = await findRefundRow(client, payId);
  if (!refund) {
    throw new HttpError(404, 'Scheduled refund was not found.');
  }
  if (refund.status === 'succeeded') {
    const total = await storedRefundTotal(client, refund);
    return {
      ok: true,
      status: 'succeeded',
      alreadyRefunded: true,
      refundQuote: publicQuote(quoteFromRefundRow(refund)),
      refundTotal: publicQuote(total),
    };
  }
  if (refund.status === 'cancelled') {
    throw new HttpError(409, 'Această restituire a fost anulată și nu mai poate fi eliberată.');
  }

  const payment = await findPaymentRow(client, payId);
  if (!payment) {
    throw new HttpError(404, 'MAIB payment was not found.');
  }

  // The staff release ends the cooldown whatever MAIB answers: clear eligible_at
  // BEFORE the attempt so a declined/unconfirmed release is retried by the
  // reconcile cron on its normal ≤30-min cadence. Leaving the future stamp in
  // place parked a failed release until the original 60h elapsed, while the
  // staff alert promised 30-minute retries (ADR-099).
  const { error: clearError } = await table(client, 'maib_refunds')
    .update({ eligible_at: null, updated_at: new Date().toISOString() })
    .eq('pay_id', payId);
  if (clearError) throw new Error(clearError.message);

  const amount = Number(refund.amount);
  if (!(amount > 0)) {
    throw new HttpError(409, 'Stored refund amount is invalid.');
  }
  const refundTotal = await storedRefundTotal(client, refund);
  const outcome = await attemptBookingRefund(client, {
    payId: payment.pay_id,
    providerPayId: payment.provider_payment_id || payment.pay_id,
    bookingGroupId: refund.booking_group_id,
    quote: quoteFromRefundRow(refund),
    currency: payment.currency || refund.currency || 'MDL',
    reason: refund.reason || 'staff_release',
    source: 'scheduled-refunds:release',
  });

  if (!outcome.ok && outcome.cancelled) {
    // Staff aborted the refund in the instant between our status check and the
    // execution claim — the abort wins and no money moved.
    throw new HttpError(409, 'Această restituire a fost anulată și nu mai poate fi eliberată.');
  }

  if (!outcome.ok) {
    await alertRefundProblem(client, {
      payId: payment.pay_id,
      bookingGroupId: refund.booking_group_id,
      amount,
      reason: refund.reason || 'staff_release',
      detail: outcome.error ||
        `Eliberare manuală — răspuns MAIB fără confirmare (status: ${
          outcome.providerStatus || 'necunoscut'
        }).`,
      source: 'scheduled-refunds:release',
    }).catch((alertError) => console.error('Refund alert failed', alertError));

    return {
      ok: false,
      pending: true,
      providerStatus: outcome.providerStatus || null,
      message: 'Restituirea nu s-a confirmat încă — sistemul o reîncearcă automat la 30 de minute.',
      refundQuote: publicQuote(quoteFromRefundRow(refund)),
      refundTotal: publicQuote(refundTotal),
    };
  }

  const differenceRefunds = await refundPaidChanges(
    client,
    refund.booking_group_id,
    refund.reason || 'staff_release',
  );
  const differencesPending = differenceRefunds.some((refund) => !refund.ok);

  return {
    ok: !differencesPending,
    pending: differencesPending,
    partial: differencesPending,
    status: differencesPending ? 'partial' : 'succeeded',
    message: differencesPending
      ? 'Restituirea principală s-a confirmat, dar una sau mai multe autorizări suplimentare sunt încă în așteptare — sistemul le reîncearcă automat.'
      : undefined,
    differenceRefunds,
    refundQuote: publicQuote(quoteFromRefundRow(refund)),
    refundTotal: publicQuote(refundTotal),
  };
}

// Union of the two authoritative "money returned" signals: a payment marked
// refunded (attemptBookingRefund's success path + manual reconciliation) and a
// succeeded refund row. Either alone is enough to call the group refunded.
// Paged through PostgREST's ~1000-row cap (ADR-099): an unpaginated select
// would silently truncate once the refund history outgrows one page, and every
// truncated group would render "fără rambursare" in Finance. pay_id (unique)
// gives the stable total order the pager needs.
const REFUNDED_GROUPS_PAGE_SIZE = 1000;

type RefundedGroupRow = {
  booking_group_id: string | null;
  amount?: number | string | null;
  gross_amount?: number | string | null;
  withheld_commission?: number | string | null;
};

async function allBookingGroupIds(
  build: () => QueryBuilder<RefundedGroupRow[]>,
): Promise<RefundedGroupRow[]> {
  const rows: RefundedGroupRow[] = [];
  for (let from = 0;; from += REFUNDED_GROUPS_PAGE_SIZE) {
    const { data, error } = await build().range(from, from + REFUNDED_GROUPS_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = data || [];
    rows.push(...page);
    if (page.length < REFUNDED_GROUPS_PAGE_SIZE) {
      return rows;
    }
  }
}

// Each entry also carries the amount that ACTUALLY went back, taken from the
// refund record. Finance used to assume a refund returned the full price of the
// cancelled villas, which stopped being true the moment staff could type their
// own amount (ADR-104). `amount: null` means "no refund row" (a payment
// reconciled to 'refunded' out of band) — the caller keeps its old estimate.
async function refundedBookingGroups(
  client: SupabaseClient,
): Promise<
  Array<{
    bookingGroupId: string;
    amount: number | null;
    grossAmount: number | null;
    withheldCommission: number;
  }>
> {
  const amounts = new Map<
    string,
    { amount: number | null; grossAmount: number | null; withheldCommission: number }
  >();
  const [payments, refunds] = await Promise.all([
    allBookingGroupIds(() =>
      table<RefundedGroupRow[]>(client, 'maib_payments')
        .select('booking_group_id')
        .eq('status', 'refunded')
        .order('pay_id', { ascending: true })
    ),
    allBookingGroupIds(() =>
      table<RefundedGroupRow[]>(client, 'maib_refunds')
        .select('booking_group_id, amount, gross_amount, withheld_commission')
        .eq('status', 'succeeded')
        .order('pay_id', { ascending: true })
    ),
  ]);
  for (const row of payments) {
    if (row.booking_group_id && !amounts.has(row.booking_group_id)) {
      amounts.set(row.booking_group_id, {
        amount: null,
        grossAmount: null,
        withheldCommission: 0,
      });
    }
  }
  // Refund rows win: they hold the sum the provider actually moved. A group can
  // legitimately have several payments refunded (booking + differences), so the
  // amounts add up rather than overwrite.
  for (const row of refunds) {
    if (!row.booking_group_id) continue;
    const amount = Number(row.amount || 0);
    if (!(amount > 0)) continue;
    const gross = Number(row.gross_amount ?? amount);
    const withheld = Number(row.withheld_commission || 0);
    const current = amounts.get(row.booking_group_id) || {
      amount: 0,
      grossAmount: 0,
      withheldCommission: 0,
    };
    amounts.set(row.booking_group_id, {
      amount: (current.amount || 0) + amount,
      grossAmount: (current.grossAmount || 0) + gross,
      withheldCommission: current.withheldCommission + withheld,
    });
  }
  return [...amounts.entries()].map(([bookingGroupId, quote]) => ({ bookingGroupId, ...quote }));
}

async function payIdForGroup(client: SupabaseClient, bookingGroupId: string) {
  const { data, error } = await table<{ pay_id: string }>(client, 'maib_refunds')
    .select('pay_id')
    .eq('booking_group_id', bookingGroupId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data?.pay_id || '';
}

async function findPaymentRow(client: SupabaseClient, payId: string) {
  const { data, error } = await table<PaymentRow>(client, 'maib_payments')
    .select('pay_id, provider_payment_id, booking_group_id, amount, currency, status')
    .eq('pay_id', payId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

function cancelReasonMessage(reason: string) {
  if (reason === 'already_refunded') {
    return 'Restituirea a fost deja efectuată și nu mai poate fi anulată.';
  }
  if (reason === 'already_processing') {
    return 'Restituirea a intrat deja în procesare și nu mai poate fi anulată.';
  }
  return 'Restituirea programată nu a fost găsită.';
}

function optionalString(value: unknown) {
  return String(value || '').trim();
}

async function storedRefundTotal(client: SupabaseClient, refund: MaibRefundRow) {
  const changes = await storedChangeQuotes(client, [refund.booking_group_id]);
  return aggregateRefundQuotes([
    quoteFromRefundRow(refund),
    ...(changes.get(refund.booking_group_id) || []),
  ]);
}

async function storedChangeQuotes(client: SupabaseClient, bookingGroupIds: string[]) {
  const quotes = new Map<string, RefundQuote[]>();
  if (!bookingGroupIds.length) return quotes;
  const { data, error } = await table<ChangeQuoteRow[]>(client, 'reservation_changes')
    .select(
      'booking_group_id, refund_amount, refund_withheld, refund_rate_bps, refund_policy_version',
    )
    .in('booking_group_id', bookingGroupIds)
    .in('status', ['paid', 'refunded'])
    .gt('refund_amount', 0);

  if (error) throw new Error(error.message);
  for (const row of data || []) {
    const net = Number(row.refund_amount);
    const withheld = Number(row.refund_withheld || 0);
    if (!(net > 0)) continue;
    const group = quotes.get(row.booking_group_id) || [];
    group.push({
      gross: net + withheld,
      net,
      withheld,
      rateBps: Number(row.refund_rate_bps || 0),
      version: String(row.refund_policy_version || ''),
    });
    quotes.set(row.booking_group_id, group);
  }
  return quotes;
}

function publicQuote(quote: RefundQuote) {
  return { gross: quote.gross, withheld: quote.withheld, net: quote.net };
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
