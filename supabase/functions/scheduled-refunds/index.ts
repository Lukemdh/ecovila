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
} from '../_shared/refunds.ts';
import { refundPaidChanges } from '../_shared/reservationChanges.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

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
      return jsonResponse({ ok: true, refunds: await listScheduledRefunds(client) }, {}, request);
    }

    if (action === 'refunded-groups') {
      // Booking groups whose money was actually returned. The CRM can't read the
      // RLS-locked payment tables, and cancellation_reason is an unreliable proxy
      // (the CRM cancel stamps 'Anulat din CRM', the guest card path
      // 'guest_request_refunded', etc.), so the Finance tab asks here for the
      // truth to decide which cancellations are "rambursat".
      return jsonResponse({ ok: true, groups: await refundedBookingGroups(client) }, {}, request);
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
    .select('pay_id, booking_group_id, amount, currency, status, reason, eligible_at, created_at')
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
  const { data: reservations, error: resError } = await table<ReservationRow[]>(client, 'reservations')
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

  return rows.map((refund) => {
    const group = byGroup.get(refund.booking_group_id) || [];
    const primary = group[0];
    return {
      payId: refund.pay_id,
      bookingGroupId: refund.booking_group_id,
      amount: Number(refund.amount || 0),
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
    return { ok: true, status: 'succeeded', alreadyRefunded: true };
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

  const amount = Number(refund.amount || payment.amount || 0);
  const outcome = await attemptBookingRefund(client, {
    payId: payment.pay_id,
    providerPayId: payment.provider_payment_id || payment.pay_id,
    bookingGroupId: refund.booking_group_id,
    amount,
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
        `Eliberare manuală — răspuns MAIB fără confirmare (status: ${outcome.providerStatus || 'necunoscut'}).`,
      source: 'scheduled-refunds:release',
    }).catch((alertError) => console.error('Refund alert failed', alertError));

    return {
      ok: false,
      pending: true,
      providerStatus: outcome.providerStatus || null,
      message: 'Restituirea nu s-a confirmat încă — sistemul o reîncearcă automat la 30 de minute.',
    };
  }

  const differenceRefunds = await refundPaidChanges(
    client,
    refund.booking_group_id,
    refund.reason || 'staff_release',
  );

  return { ok: true, status: 'succeeded', differenceRefunds };
}

// Union of the two authoritative "money returned" signals: a payment marked
// refunded (attemptBookingRefund's success path + manual reconciliation) and a
// succeeded refund row. Either alone is enough to call the group refunded.
// Paged through PostgREST's ~1000-row cap (ADR-099): an unpaginated select
// would silently truncate once the refund history outgrows one page, and every
// truncated group would render "fără rambursare" in Finance. pay_id (unique)
// gives the stable total order the pager needs.
const REFUNDED_GROUPS_PAGE_SIZE = 1000;

async function allBookingGroupIds(
  build: () => QueryBuilder<{ booking_group_id: string | null }[]>,
): Promise<Array<{ booking_group_id: string | null }>> {
  const rows: Array<{ booking_group_id: string | null }> = [];
  for (let from = 0; ; from += REFUNDED_GROUPS_PAGE_SIZE) {
    const { data, error } = await build().range(from, from + REFUNDED_GROUPS_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = data || [];
    rows.push(...page);
    if (page.length < REFUNDED_GROUPS_PAGE_SIZE) {
      return rows;
    }
  }
}

async function refundedBookingGroups(client: SupabaseClient): Promise<string[]> {
  const groups = new Set<string>();
  const [payments, refunds] = await Promise.all([
    allBookingGroupIds(() =>
      table<{ booking_group_id: string | null }[]>(client, 'maib_payments')
        .select('booking_group_id')
        .eq('status', 'refunded')
        .order('pay_id', { ascending: true })
    ),
    allBookingGroupIds(() =>
      table<{ booking_group_id: string | null }[]>(client, 'maib_refunds')
        .select('booking_group_id')
        .eq('status', 'succeeded')
        .order('pay_id', { ascending: true })
    ),
  ]);
  for (const row of payments) {
    if (row.booking_group_id) groups.add(row.booking_group_id);
  }
  for (const row of refunds) {
    if (row.booking_group_id) groups.add(row.booking_group_id);
  }
  return [...groups];
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

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
