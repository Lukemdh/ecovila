import { handleCors } from '../_shared/cors.ts';
import {
  assertMethod,
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireStaffRole,
} from '../_shared/http.ts';
import { sendEmail, sendSms } from '../_shared/providers.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  aggregateRoomLabel,
  buildCancellationEmail,
  cancellationConfirmationSms,
  mapNotificationOwners,
  markNotificationEventFailed,
  markNotificationEventSent,
  normalizeEmailLang,
  reserveNotificationEvent,
  titleCaseName,
} from '../_shared/notifications.ts';
import type { NotificationMessage } from '../_shared/notifications.ts';
import { getSiteUrl } from '../_shared/env.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';
import { aggregateRefundQuotes, refundCountsTowardGuestNotice } from '../_shared/refundIntents.ts';
import { type MaibRefundRow, quoteFromRefundRow } from '../_shared/refunds.ts';
import type { RefundQuote } from '../_shared/refundPolicy.ts';

// Staff CRM cancellations are recorded as 'reservation_cancelled' so they stay
// distinct from guest self-service cancellations ('guest_cancellation'). The
// per-reservation unique constraint keeps the guest from being notified twice.
const EVENT_TYPE = 'reservation_cancelled';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  neq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
};

type RoomRow = { number?: number | null; type?: string | null };

type CancelledReservationRow = {
  id: string;
  booking_group_id: string | null;
  guest_first_name?: string | null;
  guest_last_name?: string | null;
  guest_phone: string;
  guest_email: string;
  guest_language?: string | null;
  check_in: string;
  check_out: string;
  rooms?: RoomRow | RoomRow[] | null;
};

type NotificationResult = {
  reservationId: string;
  sent: boolean;
  skipped_duplicate?: boolean;
  result?: Record<string, unknown>;
  error?: string;
};

type ChangeRefundQuoteRow = {
  status?: string | null;
  refund_amount?: number | string | null;
  refund_withheld?: number | string | null;
  refund_rate_bps?: number | string | null;
  refund_policy_version?: string | null;
};

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    await requireStaffRole(request, ['diana', 'angela']);

    const body = await readJson(request);
    const bookingGroupId = String(body?.bookingGroupId || '').trim();
    const reservationId = String(body?.reservationId || '').trim();

    if (!bookingGroupId && !reservationId) {
      throw new HttpError(400, 'bookingGroupId or reservationId is required.');
    }

    const client = createServiceClient();
    const reservations = await loadCancelledReservations(client, {
      bookingGroupId,
      reservationId,
    });

    if (!reservations.length) {
      throw new HttpError(404, 'No cancelled reservation was found to notify about.');
    }

    const refundNotice = await loadStoredRefundNotice(
      client,
      reservations[0].booking_group_id || bookingGroupId,
    );
    const notificationResults = await notifyCancelledReservations(
      client,
      reservations,
      refundNotice,
    );

    return jsonResponse(
      {
        ok: true,
        refundQuote: refundNotice ? publicQuote(refundNotice.quote) : null,
        refundTotal: refundNotice ? publicQuote(refundNotice.quote) : null,
        notificationResults,
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function loadCancelledReservations(
  client: SupabaseClient,
  input: { bookingGroupId: string; reservationId: string },
) {
  const columns =
    'id, booking_group_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, rooms(number, type)';

  if (input.bookingGroupId) {
    const { data, error } = await table<CancelledReservationRow[]>(client, 'reservations')
      .select(columns)
      .eq('booking_group_id', input.bookingGroupId)
      .eq('payment_status', 'cancelled');

    if (error) throw new Error(error.message);
    return data || [];
  }

  const { data, error } = await table<CancelledReservationRow[]>(client, 'reservations')
    .select(columns)
    .eq('id', input.reservationId)
    .eq('payment_status', 'cancelled');

  if (error) throw new Error(error.message);
  return data || [];
}

async function notifyCancelledReservations(
  client: SupabaseClient,
  reservations: CancelledReservationRow[],
  refundNotice: RefundNotice | null,
) {
  const results: NotificationResult[] = [];
  // One notification per booking group: the owner reservation sends the SMS and
  // an email that lists every villa; the rest of the group is skipped.
  const ownerGroups = mapNotificationOwners(reservations);

  for (const reservation of reservations) {
    const group = ownerGroups.get(reservation.id);
    if (!group) {
      results.push({ reservationId: reservation.id, sent: false, skipped_duplicate: true });
      continue;
    }

    try {
      const reserved = await reserveNotificationEvent(client, reservation.id, EVENT_TYPE, {
        source: 'crm',
      });
      if (!reserved) {
        results.push({ reservationId: reservation.id, sent: false, skipped_duplicate: true });
        continue;
      }

      const message = composeCancellation(reservation, group, refundNotice);
      const [sms, email] = await Promise.allSettled([
        message.sms ? sendSms(message.sms) : Promise.resolve({ skipped: true }),
        sendEmail(message.email),
      ]);
      const result = {
        sms: sms.status === 'fulfilled' ? sms.value : { error: providerError(sms.reason) },
        email: email.status === 'fulfilled' ? email.value : { error: providerError(email.reason) },
      };
      await markNotificationEventSent(client, reservation.id, EVENT_TYPE, result);
      results.push({
        reservationId: reservation.id,
        sent: sms.status === 'fulfilled' || email.status === 'fulfilled',
        result,
        skipped_duplicate: false,
      });
    } catch (error) {
      console.error('CRM cancellation notification failed', error);
      await markNotificationEventFailed(client, reservation.id, EVENT_TYPE, error).catch(
        (recordError) => console.error('CRM cancellation notification record failed', recordError),
      );
      results.push({
        reservationId: reservation.id,
        sent: false,
        error: error instanceof Error ? error.message : 'Notification failed.',
      });
    }
  }

  return results;
}

function composeCancellation(
  reservation: CancelledReservationRow,
  groupReservations: CancelledReservationRow[] = [reservation],
  refundNotice: RefundNotice | null = null,
): NotificationMessage {
  // The owner reservation's email lists every villa in the booking group.
  const group = groupReservations.length ? groupReservations : [reservation];
  const lang = normalizeEmailLang(reservation.guest_language);
  const roomCopy = aggregateRoomLabel(group, lang);
  const firstName = titleCaseName(reservation.guest_first_name || '');
  const fullName = titleCaseName(
    `${reservation.guest_first_name || ''} ${reservation.guest_last_name || ''}`,
  );

  const email = buildCancellationEmail({
    lang,
    firstName,
    fullName,
    roomCopy,
    checkIn: reservation.check_in,
    checkOut: reservation.check_out,
    refundAmount: refundNotice?.quote.net,
    withheldCommission: refundNotice?.quote.withheld,
    refundStatus: refundNotice?.status,
    refundEta: refundNotice?.eligibleAt,
    siteUrl: getSiteUrl(),
  });

  return {
    sms: {
      to: reservation.guest_phone,
      message: cancellationConfirmationSms({
        checkIn: reservation.check_in,
        checkOut: reservation.check_out,
        refundAmount: refundNotice?.quote.net,
        withheldCommission: refundNotice?.quote.withheld,
        refundStatus: refundNotice?.status,
        refundEta: refundNotice?.eligibleAt,
        language: lang,
      }),
    },
    email: {
      to: reservation.guest_email,
      subject: email.subject,
      text: email.text,
      html: email.html,
    },
  };
}

function providerError(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Provider request failed.');
}

type RefundNotice = {
  quote: RefundQuote;
  status: 'completed' | 'scheduled' | 'processing';
  eligibleAt: string | null;
};

async function loadStoredRefundNotice(client: SupabaseClient, bookingGroupId: string) {
  if (!bookingGroupId) return null;
  const [{ data: refunds, error: refundError }, { data: changes, error: changeError }] =
    await Promise
      .all([
        table<MaibRefundRow[]>(client, 'maib_refunds')
          .select(
            'pay_id, booking_group_id, amount, gross_amount, withheld_commission, commission_rate_bps, refund_policy_version, status, eligible_at',
          )
          .eq('booking_group_id', bookingGroupId)
          .neq('status', 'cancelled'),
        table<ChangeRefundQuoteRow[]>(client, 'reservation_changes')
          .select(
            'status, refund_amount, refund_withheld, refund_rate_bps, refund_policy_version',
          )
          .eq('booking_group_id', bookingGroupId)
          .in('status', ['paid', 'refunded'])
          .gt('refund_amount', 0),
      ]);

  if (refundError) throw new Error(refundError.message);
  if (changeError) throw new Error(changeError.message);

  // Keep retryable failed rows: the cron retries them and they normally will
  // pay. Only a staff-aborted 'cancelled' row makes the promised total false.
  const quotes: RefundQuote[] = (refunds || [])
    .filter((row) => refundCountsTowardGuestNotice(row.status))
    .map(quoteFromRefundRow);
  for (const row of changes || []) {
    const net = Number(row.refund_amount);
    const withheld = Number(row.refund_withheld || 0);
    if (!(net > 0)) continue;
    quotes.push({
      gross: net + withheld,
      net,
      withheld,
      rateBps: Number(row.refund_rate_bps || 0),
      version: String(row.refund_policy_version || ''),
    });
  }

  if (!quotes.length) return null;

  const now = Date.now();
  const scheduledRow = (refunds || []).find((row) =>
    row.status === 'requested' && row.eligible_at && new Date(row.eligible_at).getTime() > now
  );
  const unresolved =
    (refunds || []).some((row) =>
      row.status === 'requested' || row.status === 'processing' || row.status === 'failed'
    ) || (changes || []).some((row) => row.status === 'paid');

  return {
    quote: aggregateRefundQuotes(quotes),
    status: scheduledRow ? 'scheduled' : unresolved ? 'processing' : 'completed',
    eligibleAt: scheduledRow?.eligible_at || null,
  } satisfies RefundNotice;
}

function publicQuote(quote: RefundQuote) {
  return { gross: quote.gross, withheld: quote.withheld, net: quote.net };
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
