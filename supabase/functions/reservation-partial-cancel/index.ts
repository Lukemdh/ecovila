// Partial cancellation + manual refund (ADR-104). Staff open a booking in the
// CRM, tick the villas the guest is giving up, type the amount to return, and
// this function does the whole operation server-side in one call:
//
//   1. validate the selection against the live booking group,
//   2. cancel exactly those rows (row-count asserted, ADR-101 style),
//   3. execute the refund for the typed amount,
//   4. tell the guest what was dropped and what still stands.
//
// It is one function rather than three browser calls (the shape of today's
// "Șterge rezervarea" path) because a closed tab or a dropped connection
// between the steps would leave villas cancelled with no refund and no notice.
//
// MAIB allows exactly ONE refund per payment, so a partial refund permanently
// consumes it: the preflight refuses a second one instead of returning the
// silent `{ok:true}` the shared engine would otherwise produce, and staff are
// told to transfer the remainder manually.
import { handleCors } from '../_shared/cors.ts';
import {
  assertMethod,
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireStaffRole,
} from '../_shared/http.ts';
import { alertRefundProblem, attemptBookingRefund, findRefundRow } from '../_shared/refunds.ts';
import { supersedeOpenChanges } from '../_shared/reservationChanges.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  aggregateRoomLabel,
  buildCancellationEmail,
  buildPartialCancellationEmail,
  cancellationConfirmationSms,
  mapNotificationOwners,
  markNotificationEventFailed,
  markNotificationEventSent,
  normalizeEmailLang,
  partialCancellationSms,
  reserveNotificationEvent,
  titleCaseName,
} from '../_shared/notifications.ts';
import type { NotificationMessage } from '../_shared/notifications.ts';
import { sendEmail, sendSms } from '../_shared/providers.ts';
import { getSiteUrl } from '../_shared/env.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

// Same event type as the CRM full cancellation: the dedup key is
// (reservation_id, event_type), and this function only ever reserves it on the
// rows cancelled in THIS call, so a later partial cancellation of the same
// booking group still reaches the guest.
const EVENT_TYPE = 'reservation_cancelled';
// One booking group can hold at most the whole 25-villa inventory.
const MAX_SELECTION = 25;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// How far out the claimed refund's eligible_at is set. Long enough that the
// 30-minute reconcile cron cannot fire while this request is still running, short
// enough that a crashed request still pays the guest within the hour.
const REFUND_RECOVERY_DELAY_MS = 10 * 60 * 1000;

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

// The shared SupabaseClient type only declares `from`; the runtime client also
// has `rpc`. Same narrowing cast reservation-reschedule uses.
type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<SupabaseQueryResult<unknown>>;
};

type RoomRelation = { number?: number | string | null; type?: string | null };

type GroupReservationRow = {
  id: string;
  booking_group_id: string | null;
  guest_first_name?: string | null;
  guest_last_name?: string | null;
  guest_phone: string;
  guest_email?: string | null;
  guest_language?: string | null;
  check_in: string;
  check_out: string;
  total_price?: number | string | null;
  payment_type?: string | null;
  payment_status?: string | null;
  payment_in_progress?: boolean | null;
  payment_session_expires_at?: string | null;
  cash_expires_at?: string | null;
  cancelled_at?: string | null;
  rooms?: RoomRelation | RoomRelation[] | null;
};

type MaibPaymentRow = {
  pay_id: string;
  provider_payment_id?: string | null;
  booking_group_id?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  status?: string | null;
};

type NotificationResult = {
  reservationId: string;
  sent: boolean;
  skipped_duplicate?: boolean;
  result?: Record<string, unknown>;
  error?: string;
};

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    // Money leaves the account here, so this is diana-only — angela's read-only
    // dashboard never renders the control and the server refuses it anyway.
    await requireStaffRole(request, ['diana']);

    const body = await readJson(request);
    const bookingGroupId = String(body?.bookingGroupId || '').trim();
    const reservationIds = normalizeIds(body?.reservationIds);
    const refundAmount = normalizeAmount(body?.refundAmount);

    if (!UUID_PATTERN.test(bookingGroupId)) {
      throw new HttpError(400, 'bookingGroupId is required.');
    }
    if (!reservationIds.length) {
      throw new HttpError(400, 'Selectează cel puțin o cazare de anulat.');
    }
    if (reservationIds.length > MAX_SELECTION) {
      throw new HttpError(400, 'Selecție invalidă.');
    }
    if (refundAmount !== null && !(refundAmount > 0)) {
      throw new HttpError(400, 'Suma de restituit trebuie să fie un număr pozitiv.');
    }

    const client = createServiceClient();
    const group = await loadBookingGroup(client, bookingGroupId);

    if (!group.length) {
      throw new HttpError(404, 'Rezervarea nu a fost găsită.');
    }

    const byId = new Map(group.map((row) => [row.id, row]));
    const selected: GroupReservationRow[] = [];
    for (const id of reservationIds) {
      const row = byId.get(id);
      if (!row) {
        throw new HttpError(409, 'O cazare selectată nu face parte din această rezervare.');
      }
      if (!isActive(row)) {
        throw new HttpError(409, 'O cazare selectată este deja anulată — reîncarcă pagina.');
      }
      if (isTemporaryHold(row)) {
        // A hold was never a booking: cancelling it here would email and text the
        // guest about a reservation they never made. Staff release holds instead.
        throw new HttpError(409, 'Rezervările temporare se eliberează, nu se anulează.');
      }
      selected.push(row);
    }

    const active = group.filter(isActive);
    const remaining = active.filter((row) => !reservationIds.includes(row.id));

    // A checkout in flight for this booking would settle against the amount it
    // was created with and land on whatever rows survive — the guest pays for
    // three villas and gets two. Make staff wait it out (sessions are minutes).
    assertNoLivePaymentSession(group);
    await assertNoOpenPaymentSession(client, bookingGroupId);

    // Refund preflight BEFORE anything is cancelled: a refund that can never
    // execute must not leave villas cancelled behind a "success" toast.
    let payment: MaibPaymentRow | null = null;
    if (refundAmount !== null) {
      payment = await preparePartialRefund(client, {
        bookingGroupId,
        group,
        amount: refundAmount,
      });
    }

    // An open "add guests" change quotes and charges for the villa count as it
    // was; paying it after this cancellation would apply to fewer rows than the
    // guest paid for. Void the outstanding QR before the inventory changes — and
    // accept that a cancellation which then fails leaves the change voided: the
    // guest can request it again, whereas a payment landing against stale villas
    // takes real money for rooms that no longer exist.
    await supersedeOpenChanges(client, bookingGroupId);

    // Cancellation and refund claim, one transaction. After this returns, the
    // refund exists as a due-dated row even if everything below fails.
    const cancelledIds = await cancelSelectedReservations(client, bookingGroupId, reservationIds, {
      payment,
      amount: refundAmount,
    });

    const refund = payment
      ? await executeRefund(client, {
        payment,
        bookingGroupId,
        amount: refundAmount as number,
      })
      : null;

    const notificationResults = await notifyGuest(client, {
      cancelled: selected,
      remaining,
      refundAmount: refund?.ok ? refundAmount : null,
      totalCount: active.length,
    });

    return jsonResponse(
      {
        ok: true,
        cancelledIds,
        remainingActive: remaining.length,
        refund,
        notificationResults,
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

function normalizeIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const ids = list.map((item) => String(item || '').trim()).filter(Boolean);
  // Shape-check before the RPC: a malformed id reaches Postgres as invalid uuid
  // input (22P02) and would surface as a 500 with a raw database message
  // instead of a plain rejected request (ADR-102).
  for (const id of ids) {
    if (!UUID_PATTERN.test(id)) {
      throw new HttpError(400, 'Selecție invalidă.');
    }
  }
  return [...new Set(ids)];
}

function normalizeAmount(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    throw new HttpError(400, 'Suma de restituit trebuie să fie un număr pozitiv.');
  }
  // Whole lei only — MAIB settles in MDL and staff type round sums.
  return Math.round(amount);
}

function isActive(row: GroupReservationRow) {
  return !row.cancelled_at && ['pending', 'paid'].includes(String(row.payment_status || ''));
}

// Mirrors isTemporaryHold in admin/js/crm-calendar.js and the SQL-side hold
// definition (ADR-100): an office-typed pending row with a live deadline.
function isTemporaryHold(row: GroupReservationRow) {
  return String(row.payment_type || '') === 'office' &&
    String(row.payment_status || '') === 'pending' &&
    Boolean(row.cash_expires_at);
}

async function loadBookingGroup(client: SupabaseClient, bookingGroupId: string) {
  const { data, error } = await table<GroupReservationRow[]>(client, 'reservations')
    .select(
      'id, booking_group_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, payment_status, payment_in_progress, payment_session_expires_at, cash_expires_at, cancelled_at, rooms(number, type)',
    )
    .eq('booking_group_id', bookingGroupId);

  if (error) throw new Error(error.message);
  return data || [];
}

// Everything that must hold BEFORE money moves. Returns the payment to refund.
async function preparePartialRefund(
  client: SupabaseClient,
  input: { bookingGroupId: string; group: GroupReservationRow[]; amount: number },
) {
  const paidByCard = input.group.some((row) =>
    String(row.payment_type || '') === 'card' && String(row.payment_status || '') === 'paid'
  );
  if (!paidByCard) {
    throw new HttpError(
      409,
      'Restituirea automată este disponibilă doar pentru rezervările achitate online. Anulează fără sumă și returnează banii la birou.',
    );
  }

  const payment = await findPayment(client, input.bookingGroupId);
  if (!payment) {
    throw new HttpError(409, 'Plata online nu a fost găsită pentru această rezervare.');
  }

  // A payment can be marked refunded WITHOUT a maib_refunds row — manual
  // reconciliation does exactly that. Calling MAIB again then returns REVERSED,
  // which the engine reads as success, and we would report money as returned
  // that never moved. The refund-row check below cannot see this case.
  if (String(payment.status || '') === 'refunded') {
    throw new HttpError(
      409,
      'Această plată figurează deja ca restituită. MAIB permite o singură restituire per plată — transferă restul manual.',
    );
  }

  const paidAmount = Number(payment.amount || 0);
  if (paidAmount > 0 && input.amount > paidAmount) {
    throw new HttpError(
      400,
      `Suma depășește plata online (${Math.round(paidAmount)} MDL).`,
    );
  }

  // MAIB allows one refund per payment, and maib_refunds holds one row per
  // pay_id, so any existing refund is THE refund for this payment.
  const existing = await findRefundRow(client, payment.pay_id);

  // Already paid out: attemptBookingRefund would short-circuit on the succeeded
  // row and answer ok:true without moving a leu. Refuse loudly instead, naming
  // the amount that did go back so staff know what is left to transfer by hand.
  if (existing?.status === 'succeeded') {
    throw new HttpError(
      409,
      `Această plată a fost deja restituită (${
        Math.round(Number(existing.amount || 0))
      } MDL). MAIB permite o singură restituire per plată — transferă restul manual.`,
    );
  }

  // Scheduled (a guest cancellation cooling down, ADR-096) or mid-flight: this
  // call would overwrite that row's amount and pay out a different sum, silently
  // replacing a refund someone else already set in motion. Send staff to the
  // Finance controls to cancel or release it first, then come back.
  if (existing && existing.status !== 'cancelled') {
    throw new HttpError(
      409,
      `Există deja o restituire de ${
        Math.round(Number(existing.amount || 0))
      } MDL pentru această plată. Anuleaz-o sau eliberează-o din Finance înainte de a restitui altă sumă.`,
    );
  }

  return payment;
}

async function findPayment(client: SupabaseClient, bookingGroupId: string) {
  // Only a payment that captured money can be refunded; an abandoned pending
  // session for the same group must never shadow the paid one.
  const { data, error } = await table<MaibPaymentRow>(client, 'maib_payments')
    .select('pay_id, provider_payment_id, booking_group_id, amount, currency, status')
    .eq('booking_group_id', bookingGroupId)
    .in('status', ['paid', 'refunded'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

// Cancel exactly the selected rows, all or nothing. A guarded PostgREST UPDATE
// plus a row-count check here would NOT be atomic: a one-of-two match commits
// before this code could reject it, leaving a villa cancelled with no refund.
// The RPC asserts the cardinality inside the transaction and raises P0002, so a
// mismatch rolls back and nothing at all has changed when we throw (ADR-104).
async function cancelSelectedReservations(
  client: SupabaseClient,
  bookingGroupId: string,
  reservationIds: string[],
  refund: { payment: MaibPaymentRow | null; amount: number | null },
) {
  const { data, error } = await (client as unknown as RpcClient).rpc('cancel_reservation_rows', {
    p_booking_group_id: bookingGroupId,
    p_reservation_ids: reservationIds,
    p_reason: 'Anulare parțială din CRM',
    // Claiming the payment's single refund slot in the same transaction is what
    // makes the preflight check safe: without it, a guest cancellation
    // scheduling its own refund between the check and the execution would be
    // overwritten with this amount and paid out immediately.
    p_refund_pay_id: refund.payment?.pay_id ?? null,
    p_refund_amount: refund.amount,
    p_refund_currency: refund.payment?.currency || 'MDL',
    p_refund_reason: 'crm_partial_cancellation',
    // A few minutes out, so the reconcile cron finishes the payout if this
    // function dies before calling MAIB, without racing the immediate attempt
    // a few lines below (which claims the row to 'processing' at once).
    p_refund_eligible_at: refund.payment
      ? new Date(Date.now() + REFUND_RECOVERY_DELAY_MS).toISOString()
      : null,
  });

  if (error) {
    const code = String((error as { code?: string }).code);
    if (code === 'P0002') {
      throw new HttpError(
        409,
        'Rezervarea s-a schimbat între timp — nimic nu a fost anulat și nicio sumă nu a fost restituită. Reîncarcă pagina și încearcă din nou.',
      );
    }
    if (code === 'P0001') {
      // A refund for this payment appeared between the preflight and here.
      throw new HttpError(
        409,
        'A apărut între timp o restituire pentru această plată. Nimic nu a fost anulat — verifică Finance și încearcă din nou.',
      );
    }
    throw new Error(error.message);
  }

  return (Array.isArray(data) ? data : []).map((row) =>
    typeof row === 'string' ? row : String((row as { cancel_reservation_rows?: string })?.cancel_reservation_rows || '')
  ).filter(Boolean);
}

// A MAIB/MIA checkout session is live for a few minutes after the guest opens
// it. Its amount is fixed at creation, and settlement applies to whatever rows
// are still active — so cancelling mid-checkout can capture the full price and
// deliver fewer villas. Refuse while any row of the group has a live session.
function assertNoLivePaymentSession(group: GroupReservationRow[]) {
  const now = Date.now();
  const live = group.some((row) => {
    if (!isActive(row) || !row.payment_in_progress) return false;
    const expiresAt = row.payment_session_expires_at
      ? new Date(row.payment_session_expires_at).getTime()
      : 0;
    return !expiresAt || expiresAt > now;
  });

  if (live) {
    throw new HttpError(
      409,
      'Clientul are o plată online în curs pentru această rezervare. Așteaptă câteva minute și încearcă din nou.',
    );
  }
}

// The reservations flag alone leaves a window: maib-create-payment inserts the
// maib_payments row and only afterwards stamps payment_in_progress, so a
// cancellation landing in between sees a quiet booking while a checkout for the
// original amount is already open with the provider. Check the payment table too.
async function assertNoOpenPaymentSession(client: SupabaseClient, bookingGroupId: string) {
  const nowIso = new Date().toISOString();
  const { data, error } = await table<Array<{ pay_id: string }>>(client, 'maib_payments')
    .select('pay_id')
    .eq('booking_group_id', bookingGroupId)
    .in('status', ['created', 'pending'])
    .gt('expires_at', nowIso)
    .limit(1);

  if (error) throw new Error(error.message);
  if (data && data.length) {
    throw new HttpError(
      409,
      'Clientul are o plată online deschisă pentru această rezervare. Așteaptă să expire sesiunea și încearcă din nou.',
    );
  }
}

async function executeRefund(
  client: SupabaseClient,
  input: { payment: MaibPaymentRow; bookingGroupId: string; amount: number },
) {
  // Cancel-then-refund: the villas are already free at this point. A refund that
  // does not confirm leaves a retryable maib_refunds row for the 30-minute
  // reconcile cron and alerts staff — never a silent loss.
  const outcome = await attemptBookingRefund(client, {
    payId: input.payment.pay_id,
    providerPayId: input.payment.provider_payment_id || input.payment.pay_id,
    bookingGroupId: input.bookingGroupId,
    amount: input.amount,
    currency: input.payment.currency || 'MDL',
    reason: 'crm_partial_cancellation',
    source: 'reservation-partial-cancel',
    // Staff typing an amount and confirming is a deliberate decision to pay,
    // even over a scheduled refund they previously aborted (ADR-096/099).
    allowCancelled: true,
  });

  if (outcome.ok) {
    return {
      ok: true,
      amount: input.amount,
      alreadyRefunded: Boolean(outcome.alreadyRefunded),
      providerStatus: outcome.providerStatus || null,
    };
  }

  await alertRefundProblem(client, {
    payId: input.payment.pay_id,
    bookingGroupId: input.bookingGroupId,
    amount: input.amount,
    reason: 'crm_partial_cancellation',
    detail: outcome.error ||
      `Anulare parțială — răspuns MAIB fără confirmare (status: ${
        outcome.providerStatus || 'necunoscut'
      }).`,
    source: 'reservation-partial-cancel',
  }).catch((alertError) => console.error('Refund alert failed', alertError));

  return {
    ok: false,
    pending: true,
    amount: input.amount,
    providerStatus: outcome.providerStatus || null,
    error: outcome.error || null,
    message: 'Restituirea nu s-a confirmat încă — sistemul o reîncearcă automat la 30 de minute.',
  };
}

// One message per operation, addressed to the owner of the rows cancelled in
// THIS call. When nothing of the booking is left the guest gets the ordinary
// full-cancellation message; otherwise the partial variant, which names what
// was dropped, what stands, and the refunded sum.
async function notifyGuest(
  client: SupabaseClient,
  input: {
    cancelled: GroupReservationRow[];
    remaining: GroupReservationRow[];
    refundAmount: number | null;
    totalCount: number;
  },
): Promise<NotificationResult[]> {
  const owners = mapNotificationOwners(input.cancelled);
  const ownerId = [...owners.keys()][0];
  const owner = input.cancelled.find((row) => row.id === ownerId) || input.cancelled[0];
  if (!owner) return [];

  try {
    const reserved = await reserveNotificationEvent(client, owner.id, EVENT_TYPE, {
      source: 'crm_partial_cancel',
    });
    if (!reserved) {
      return [{ reservationId: owner.id, sent: false, skipped_duplicate: true }];
    }

    const message = composeMessage(owner, input);
    const [sms, email] = await Promise.allSettled([
      message.sms ? sendSms(message.sms) : Promise.resolve({ skipped: true }),
      sendEmail(message.email),
    ]);
    const result = {
      sms: sms.status === 'fulfilled' ? sms.value : { error: providerError(sms.reason) },
      email: email.status === 'fulfilled' ? email.value : { error: providerError(email.reason) },
    };
    await markNotificationEventSent(client, owner.id, EVENT_TYPE, result);
    return [{
      reservationId: owner.id,
      sent: sms.status === 'fulfilled' || email.status === 'fulfilled',
      result,
      skipped_duplicate: false,
    }];
  } catch (error) {
    console.error('Partial cancellation notification failed', error);
    await markNotificationEventFailed(client, owner.id, EVENT_TYPE, error).catch((recordError) =>
      console.error('Partial cancellation notification record failed', recordError)
    );
    return [{
      reservationId: owner.id,
      sent: false,
      error: error instanceof Error ? error.message : 'Notification failed.',
    }];
  }
}

function composeMessage(
  owner: GroupReservationRow,
  input: {
    cancelled: GroupReservationRow[];
    remaining: GroupReservationRow[];
    refundAmount: number | null;
    totalCount: number;
  },
): NotificationMessage {
  const lang = normalizeEmailLang(owner.guest_language);
  const firstName = titleCaseName(owner.guest_first_name || '');
  const siteUrl = getSiteUrl();
  const email = { to: owner.guest_email || '' };

  if (!input.remaining.length) {
    // Nothing of the booking survives — this is an ordinary cancellation.
    const fullName = titleCaseName(
      `${owner.guest_first_name || ''} ${owner.guest_last_name || ''}`,
    );
    const built = buildCancellationEmail({
      lang,
      firstName,
      fullName,
      roomCopy: aggregateRoomLabel(input.cancelled, lang),
      checkIn: owner.check_in,
      checkOut: owner.check_out,
      // Staff can tick every villa, which makes this a full cancellation that
      // still returned a hand-typed sum. The ordinary cancellation copy has no
      // refund line, so the guest would never be told the money is coming.
      refundAmount: input.refundAmount,
      siteUrl,
    });
    return {
      sms: {
        to: owner.guest_phone,
        message: cancellationConfirmationSms({
          checkIn: owner.check_in,
          checkOut: owner.check_out,
          refundAmount: input.refundAmount,
          language: lang,
        }),
      },
      email: { ...email, subject: built.subject, text: built.text, html: built.html },
    };
  }

  // The stay the guest still has: the widest window across the surviving rows.
  const checkIn = input.remaining.reduce(
    (min, row) => (!min || row.check_in < min ? row.check_in : min),
    '',
  );
  const checkOut = input.remaining.reduce(
    (max, row) => (!max || row.check_out > max ? row.check_out : max),
    '',
  );

  const built = buildPartialCancellationEmail({
    lang,
    firstName,
    cancelledCopy: aggregateRoomLabel(input.cancelled, lang),
    remainingCopy: aggregateRoomLabel(input.remaining, lang),
    checkIn,
    checkOut,
    refundAmount: input.refundAmount,
    manageUrl: `${siteUrl}/rezervari.html#reservation-lookup-title`,
    siteUrl,
  });

  return {
    sms: {
      to: owner.guest_phone,
      message: partialCancellationSms({
        cancelledCount: input.cancelled.length,
        totalCount: input.totalCount,
        checkIn,
        checkOut,
        refundAmount: input.refundAmount,
        language: lang,
      }),
    },
    email: { ...email, subject: built.subject, text: built.text, html: built.html },
  };
}

function providerError(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Provider request failed.');
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
