import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import { refundMaibPayment } from '../_shared/maib.ts';
import { assertRateLimit, RATE_LIMITS, rateLimitIp } from '../_shared/rateLimit.ts';
import { sendEmail, sendSms } from '../_shared/providers.ts';
import {
  groupReservations,
  hashManageToken,
  isRefundEligible,
  refundEligibilityReason,
} from '../_shared/reservationManage.ts';
import { refundPaidChanges } from '../_shared/reservationChanges.ts';
import type { ChangeRefundResult } from '../_shared/reservationChanges.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  aggregateRoomLabel,
  buildCancellationEmail,
  cancellationConfirmationSms,
  mapNotificationOwners,
  normalizeEmailLang,
  titleCaseName,
} from '../_shared/notifications.ts';
import type { NotificationMessage } from '../_shared/notifications.ts';
import { getSiteUrl } from '../_shared/env.ts';
import type { ReservationGroupRow } from '../_shared/reservationManage.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): Promise<SupabaseQueryResult>;
  update(payload: unknown): QueryBuilder<T>;
  upsert(payload: unknown, options?: Record<string, unknown>): Promise<SupabaseQueryResult>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type ManageTokenRow = {
  phone: string;
  expires_at: string;
};

type PrimaryReservationRow = {
  booking_group_id: string;
};

type CancellationReservationRow = ReservationGroupRow & {
  id: string;
  booking_group_id: string;
  check_in: string;
  check_out: string;
  guest_first_name?: string | null;
  guest_last_name?: string | null;
  guest_phone: string;
  guest_email: string;
  guest_language?: string | null;
  cancelled_at?: string | null;
};

type MaibPaymentRow = {
  pay_id: string;
  provider_payment_id?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  status?: string | null;
  refund_payload?: unknown;
  refunded_at?: string | null;
};

type MaibRefundRow = {
  status?: string | null;
  response_payload?: Record<string, unknown> | null;
};

type MaibRefundProviderResponse = Record<string, unknown> & {
  result?: {
    refundId?: string | number | null;
  };
  refundId?: string | number | null;
};

type CancellationNotificationResult = {
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
    const body = await readJson(request);
    const token = String(body?.manageToken || '').trim();
    const reservationId = String(body?.reservationId || '').trim();

    if (!token || !reservationId) {
      throw new HttpError(400, 'manageToken and reservationId are required.');
    }

    const client = createServiceClient();
    // Token-gated; an IP cap blunts token-guessing / DB-probe floods (ADR-060).
    await assertRateLimit(client, RATE_LIMITS.manageActionIp, rateLimitIp(request));
    const manageToken = await validateManageToken(client, token);
    const reservations = await findActiveReservationGroup(client, reservationId, manageToken.phone);

    if (!reservations.length) {
      throw new HttpError(404, 'Reservation was not found or is already cancelled.');
    }

    const summary = groupReservations(reservations)[0];
    const paidCard = summary.paymentType === 'card' && summary.paymentStatus === 'paid';
    const pendingCash = summary.paymentType === 'cash' && summary.paymentStatus === 'pending';
    const createdAt = earliestCreatedAt(reservations);
    const refundable = isRefundEligible({
      checkIn: summary.checkIn,
      createdAt,
    });

    if (summary.paymentType === 'cash' && !pendingCash) {
      throw new HttpError(
        409,
        'Cash reservations cannot be cancelled online. Reimbursement is available only at the office.',
      );
    }

    if (!pendingCash && !refundable) {
      throw new HttpError(
        409,
        'Online cancellation is available only at least 20 days before arrival or within 2 hours of booking.',
      );
    }

    const payment = await findMaibPayment(client, summary.bookingGroupId);
    let refundResult = null;
    let differenceRefunds: ChangeRefundResult[] = [];

    if (paidCard && refundable) {
      if (!payment || payment.status !== 'paid') {
        throw new HttpError(409, 'The MAIB payment is not ready for refund.');
      }

      // Reverse any paid "add guests" differences FIRST, then the original
      // booking payment — each as its own MAIB transaction. Order matters: if a
      // difference refund fails, the original payment is still 'paid', so a
      // retry passes the guard above and re-runs cleanly (both refundPaidChanges
      // and createRefund are idempotent — already-refunded rows are skipped).
      // Refunding the original first would flip it to 'refunded' and the retry
      // would then 409 here, stranding the booking active with the difference
      // unrefunded. All run before the reservations are marked cancelled so any
      // failure surfaces as an error and leaves the booking retryable.
      differenceRefunds = await refundPaidChanges(client, summary.bookingGroupId, 'guest_request');
      refundResult = await createRefund(client, payment, summary.bookingGroupId);
    }

    const now = new Date().toISOString();
    const { error: cancelError } = await client
      .from('reservations')
      .update({
        payment_status: 'cancelled',
        payment_in_progress: false,
        payment_session_expires_at: null,
        cancelled_at: now,
        cancellation_reason: paidCard && refundable ? 'guest_request_refunded' : 'guest_request',
      })
      .eq('booking_group_id', summary.bookingGroupId)
      .eq('guest_phone', manageToken.phone)
      .in('payment_status', ['pending', 'paid'])
      .is('cancelled_at', null);

    if (cancelError) throw new Error(cancelError.message);

    const notificationResults = await notifyCancelledReservations(client, reservations);

    return jsonResponse(
      {
        ok: true,
        status: 'cancelled',
        refunded: Boolean(refundResult),
        refundable,
        refundReason: refundEligibilityReason({
          checkIn: summary.checkIn,
          createdAt,
        }),
        refund: refundResult,
        differenceRefunds,
        notificationResults,
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function validateManageToken(client: SupabaseClient, token: string) {
  const tokenHash = await hashManageToken(token);
  const { data, error } = await table<ManageTokenRow>(client, 'reservation_manage_tokens')
    .select('phone, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data || new Date(data.expires_at).getTime() < Date.now()) {
    throw new HttpError(401, 'Invalid or expired manage token.');
  }

  return data;
}

async function findActiveReservationGroup(
  client: SupabaseClient,
  reservationId: string,
  phone: string,
) {
  const { data: primary, error: primaryError } = await table<PrimaryReservationRow>(
    client,
    'reservations',
  )
    .select('booking_group_id')
    .eq('id', reservationId)
    .eq('guest_phone', phone)
    .maybeSingle();

  if (primaryError) throw new Error(primaryError.message);
  if (!primary) return [];

  const { data, error } = await table<CancellationReservationRow[]>(client, 'reservations')
    .select(
      'id, booking_group_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, payment_status, created_at, cancelled_at, rooms(number, type)',
    )
    .eq('booking_group_id', primary.booking_group_id)
    .eq('guest_phone', phone)
    .in('payment_status', ['pending', 'paid'])
    .is('cancelled_at', null);

  if (error) throw new Error(error.message);
  return data || [];
}

function earliestCreatedAt(reservations: CancellationReservationRow[]) {
  return reservations.reduce((min, reservation) => {
    const createdAt = String(reservation.created_at || '');
    return !min || createdAt < min ? createdAt : min;
  }, '');
}

async function notifyCancelledReservations(
  client: SupabaseClient,
  reservations: CancellationReservationRow[],
) {
  const results: CancellationNotificationResult[] = [];
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
      const reserved = await reserveNotificationEvent(client, reservation.id, 'guest_cancellation');
      if (!reserved) {
        results.push({ reservationId: reservation.id, sent: false, skipped_duplicate: true });
        continue;
      }

      const message = composeCancellationConfirmation(reservation, group);
      const [sms, email] = await Promise.allSettled([
        message.sms ? sendSms(message.sms) : Promise.resolve({ skipped: true }),
        sendEmail(message.email),
      ]);
      const result = {
        sms: sms.status === 'fulfilled' ? sms.value : { error: providerError(sms.reason) },
        email: email.status === 'fulfilled' ? email.value : { error: providerError(email.reason) },
      };
      await markNotificationEventSent(client, reservation.id, 'guest_cancellation', result);
      results.push({
        reservationId: reservation.id,
        sent: sms.status === 'fulfilled' || email.status === 'fulfilled',
        result,
        skipped_duplicate: false,
      });
    } catch (error) {
      console.error('Guest cancellation notification failed', error);
      await markNotificationEventFailed(client, reservation.id, 'guest_cancellation', error).catch(
        (recordError) =>
          console.error('Guest cancellation notification record failed', recordError),
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

async function reserveNotificationEvent(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
) {
  const now = new Date().toISOString();
  const { error } = await table(client, 'notification_events')
    .insert({
      reservation_id: reservationId,
      event_type: eventType,
      delivery_status: 'reserved',
      attempt_count: 1,
      attempted_at: now,
      metadata: { source: 'reservation_manage' },
    });

  if (!error) return true;
  if (error.code === '23505') return false;
  throw new Error(error.message || 'Could not reserve cancellation notification.');
}

async function markNotificationEventSent(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
  providerResponse: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  const { error } = await table(client, 'notification_events')
    .update({
      delivery_status: 'sent',
      provider_response: providerResponse,
      completed_at: now,
      sent_at: now,
      last_error: null,
    })
    .eq('reservation_id', reservationId)
    .eq('event_type', eventType);

  if (error) throw new Error(error.message || 'Could not mark cancellation notification sent.');
}

async function markNotificationEventFailed(
  client: SupabaseClient,
  reservationId: string,
  eventType: string,
  error: unknown,
) {
  const { error: updateError } = await table(client, 'notification_events')
    .update({
      delivery_status: 'failed',
      last_error: error instanceof Error ? error.message : 'Notification failed.',
      completed_at: new Date().toISOString(),
    })
    .eq('reservation_id', reservationId)
    .eq('event_type', eventType);

  if (updateError) {
    throw new Error(updateError.message || 'Could not mark cancellation notification failed.');
  }
}

function composeCancellationConfirmation(
  reservation: CancellationReservationRow,
  groupReservations: CancellationReservationRow[] = [reservation],
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
    siteUrl: getSiteUrl(),
  });

  return {
    sms: {
      to: reservation.guest_phone,
      message: cancellationConfirmationSms({
        checkIn: reservation.check_in,
        checkOut: reservation.check_out,
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

async function findMaibPayment(client: SupabaseClient, bookingGroupId: string) {
  const { data, error } = await table<MaibPaymentRow>(client, 'maib_payments')
    .select('pay_id, provider_payment_id, amount, currency, status, refund_payload, refunded_at')
    .eq('booking_group_id', bookingGroupId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

async function createRefund(
  client: SupabaseClient,
  payment: MaibPaymentRow,
  bookingGroupId: string,
) {
  const existing = await findExistingRefund(client, payment.pay_id);
  if (existing?.status === 'succeeded') {
    return existing.response_payload || {};
  }

  const amount = Number(payment.amount || 0);
  const reason = 'guest_request';
  const now = new Date().toISOString();

  const { error: insertError } = await table(client, 'maib_refunds')
    .upsert({
      pay_id: payment.pay_id,
      booking_group_id: bookingGroupId,
      amount,
      currency: 'MDL',
      status: 'requested',
      reason,
      request_payload: { amount, reason },
      updated_at: now,
    }, { onConflict: 'pay_id' });

  if (insertError) throw new Error(insertError.message);

  try {
    const providerPayId = payment.provider_payment_id || payment.pay_id;
    const refund = await refundMaibPayment(
      providerPayId,
      amount,
      reason,
    ) as MaibRefundProviderResponse;
    const providerRefundId = String(refund?.result?.refundId || refund?.refundId || '').trim() ||
      null;

    await table(client, 'maib_refunds')
      .update({
        status: 'succeeded',
        response_payload: refund,
        provider_refund_id: providerRefundId,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('pay_id', payment.pay_id);

    await table(client, 'maib_payments')
      .update({
        status: 'refunded',
        refund_payload: refund,
        refunded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('pay_id', payment.pay_id);

    return refund?.result || refund;
  } catch (error) {
    await table(client, 'maib_refunds')
      .update({
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Refund failed.',
        updated_at: new Date().toISOString(),
      })
      .eq('pay_id', payment.pay_id);
    throw error;
  }
}

async function findExistingRefund(client: SupabaseClient, payId: string) {
  const { data, error } = await table<MaibRefundRow>(client, 'maib_refunds')
    .select('status, response_payload')
    .eq('pay_id', payId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
