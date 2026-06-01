import { assertMethod, errorResponse, HttpError, jsonResponse } from '../_shared/http.ts';
import { getSiteUrl } from '../_shared/env.ts';
import {
  getMaibCallbackOrderId,
  getMaibCallbackPayId,
  getMaibCallbackStatus,
  getMaibProviderPaymentId,
  isMaibCallbackTerminalStatus,
  parseMaibCallback,
  verifyMaibCallbackSignature,
} from '../_shared/maib.ts';
import { sendEmail, sendSms } from '../_shared/providers.ts';
import { buildManageTokenRow } from '../_shared/reservationManage.ts';
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
  status: string;
  processed_at?: string | null;
};

type PaymentLookupInput = {
  payId?: string;
  providerPaymentId?: string;
  orderId?: string;
};

type ReservationRoomJoin = {
  number?: number | string | null;
  type?: string | null;
};

type RawPaymentReservationRow = {
  id: string;
  booking_group_id: string;
  room_id?: string | null;
  guest_first_name: string;
  guest_last_name: string;
  guest_phone: string;
  guest_email: string;
  guest_language?: string | null;
  check_in: string;
  check_out: string;
  total_price: number | string;
  payment_type: string;
  payment_status: string;
  rooms?: ReservationRoomJoin | ReservationRoomJoin[] | null;
  room_number?: number | string | null;
  room_type?: string | null;
};

type PaymentReservationRow = Omit<RawPaymentReservationRow, 'rooms'> & {
  room_number?: number;
  room_type?: string | null;
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

type CancellationTokenRow = {
  reservation_id?: string;
  token?: string | null;
};

type NotificationEventRow = {
  id: string;
};

type PaymentConfirmationDispatchResult = {
  sent: boolean;
  skipped_duplicate?: boolean;
  error?: string;
};

type PaymentConfirmationNotificationResult = PaymentConfirmationDispatchResult & {
  reservationId: string;
};

Deno.serve(async (request) => {
  try {
    assertMethod(request, ['POST']);
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

    if (payment?.processed_at && ['paid', 'failed', 'cancelled'].includes(payment.status)) {
      return jsonResponse({ ok: true, duplicate: true, status: payment.status }, {}, request);
    }

    const bookingGroupId = payment?.booking_group_id || orderId;
    const reservations = await findReservationsForBookingGroup(client, bookingGroupId);
    const now = new Date().toISOString();
    const status = getMaibCallbackStatus(payload);
    const terminal = isMaibCallbackTerminalStatus(status);

    await upsertPaymentCallback(client, {
      existingPayId: payment?.pay_id,
      payId: payId || payment?.pay_id || providerPaymentId,
      providerPaymentId,
      bookingGroupId,
      status,
      payload,
      processedAt: terminal ? now : null,
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

    if (!reservations.length) {
      console.info('Maib callback processed', {
        ...callbackContext,
        decision: 'no_matching_reservation',
      });
      return jsonResponse({ ok: true, matched: 0, status }, {}, request);
    }

    if (status === 'paid') {
      const ids = reservations.map((reservation) => reservation.id);
      const { error } = await table(client, 'reservations')
        .update({
          payment_status: 'paid',
          cash_expires_at: null,
          payment_in_progress: false,
          payment_session_expires_at: null,
          paid_at: now,
        })
        .in('id', ids)
        .eq('payment_status', 'pending')
        .is('cancelled_at', null);

      if (error) {
        throw new Error(error.message);
      }

      const notificationResults = await notifyPaidReservations(client, reservations);
      console.info('Maib callback processed', { ...callbackContext, decision: 'paid' });
      return jsonResponse(
        {
          ok: true,
          status: 'paid',
          matched: reservations.length,
          notificationResults,
        },
        {},
        request,
      );
    }

    if (status === 'pending') {
      console.info('Maib callback processed', { ...callbackContext, decision: 'left_pending' });
      return jsonResponse({ ok: true, status, matched: reservations.length }, {}, request);
    }

    const { error } = await table(client, 'reservations')
      .update({
        payment_status: 'cancelled',
        payment_in_progress: false,
        payment_session_expires_at: null,
        cancelled_at: now,
        cancellation_reason: status === 'cancelled' ? 'maib_cancelled' : 'maib_failed',
      })
      .in('id', reservations.map((reservation) => reservation.id))
      .eq('payment_status', 'pending')
      .is('cancelled_at', null);

    if (error) {
      throw new Error(error.message);
    }

    console.info('Maib callback processed', {
      ...callbackContext,
      decision: status === 'cancelled' ? 'cancelled' : 'failed',
    });

    return jsonResponse({ ok: true, status, matched: reservations.length }, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});

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

async function findReservationsForBookingGroup(client: SupabaseClient, bookingGroupId: string) {
  const { data, error } = await table<RawPaymentReservationRow[]>(client, 'reservations')
    .select(
      'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, payment_status, rooms(number, type)',
    )
    .eq('booking_group_id', bookingGroupId)
    .eq('payment_type', 'card')
    .in('payment_status', ['pending', 'paid'])
    .is('cancelled_at', null);

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map(withRoomFields);
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

async function notifyPaidReservations(
  client: SupabaseClient,
  reservations: PaymentReservationRow[],
) {
  const results: PaymentConfirmationNotificationResult[] = [];
  const siteUrl = getSiteUrl();

  for (const reservation of reservations) {
    try {
      let token = await findCancellationToken(client, reservation.id);
      if (!token) {
        const { data, error } = await table<CancellationTokenRow>(client, 'cancellation_tokens')
          .insert([{ reservation_id: reservation.id, token: createSecureToken() }])
          .select('reservation_id, token')
          .single();

        if (error) {
          throw new Error(error.message);
        }

        token = data?.token || '';
      }

      const result = await dispatchPaymentConfirmationOnce(client, reservation, token, siteUrl);
      results.push({ reservationId: reservation.id, ...result });
    } catch (error) {
      console.error('Maib payment notification failed', error);
      results.push({
        reservationId: reservation.id,
        sent: false,
        error: error instanceof Error ? error.message : 'Notification failed.',
      });
    }
  }

  return results;
}

async function dispatchPaymentConfirmationOnce(
  client: SupabaseClient,
  reservation: PaymentReservationRow,
  cancellationToken: string,
  siteUrl: string,
): Promise<PaymentConfirmationDispatchResult> {
  const now = new Date().toISOString();
  const { data, error } = await table<NotificationEventRow>(client, 'notification_events')
    .insert({
      reservation_id: reservation.id,
      event_type: 'payment_confirmation',
      provider: 'edge',
      delivery_status: 'reserved',
      attempt_count: 1,
      attempted_at: now,
      metadata: { source: 'maib-callback' },
    })
    .select('id')
    .single();

  if (error?.code === '23505') {
    return { sent: false, skipped_duplicate: true };
  }

  if (error) {
    throw new Error(error.message);
  }
  if (!data?.id) {
    throw new Error('Notification event reservation did not return an id.');
  }

  const manageToken = await createManageTokenForNotification(client, reservation.guest_phone);
  const message = composePaymentConfirmation(reservation, cancellationToken, siteUrl, manageToken);
  const providerResponse: Record<string, unknown> = {};
  const errors = [];

  try {
    providerResponse.sms = await sendSms({ to: reservation.guest_phone, message: message.sms });
  } catch (error) {
    errors.push(`SMS: ${error instanceof Error ? error.message : 'failed'}`);
  }

  try {
    providerResponse.email = await sendEmail({
      to: reservation.guest_email,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  } catch (error) {
    errors.push(`Email: ${error instanceof Error ? error.message : 'failed'}`);
  }

  const smsSent = !errors.some((entry) => entry.startsWith('SMS:'));
  const completedAt = new Date().toISOString();
  const { error: updateError } = await table(client, 'notification_events')
    .update({
      delivery_status: smsSent ? 'sent' : 'failed',
      sent_at: smsSent ? completedAt : null,
      completed_at: completedAt,
      last_error: errors.length ? errors.join(' | ') : null,
      provider_response: providerResponse,
    })
    .eq('id', data.id);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return {
    sent: smsSent,
    skipped_duplicate: false,
    error: errors.length ? errors.join(' | ') : undefined,
  };
}

async function createManageTokenForNotification(client: SupabaseClient, phone: string) {
  const manageToken = await buildManageTokenRow(phone);
  const { error } = await table(client, 'reservation_manage_tokens')
    .insert(manageToken.row);

  if (error) {
    throw new Error(error.message || 'Could not create reservation manage token.');
  }

  return manageToken.token;
}

async function findCancellationToken(client: SupabaseClient, reservationId: string) {
  const { data, error } = await table<CancellationTokenRow>(client, 'cancellation_tokens')
    .select('token')
    .eq('reservation_id', reservationId)
    .eq('used', false)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data?.token || '';
}

function withRoomFields(reservation: RawPaymentReservationRow): PaymentReservationRow {
  const room = Array.isArray(reservation.rooms) ? reservation.rooms[0] : reservation.rooms;

  return {
    ...reservation,
    room_number: Number(room?.number || reservation.room_number || 0) || undefined,
    room_type: room?.type || reservation.room_type,
  };
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}

function createSecureToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function composePaymentConfirmation(
  reservation: PaymentReservationRow,
  cancellationToken: string,
  siteUrl: string,
  manageToken: string,
) {
  const language = String(reservation.guest_language || 'ro').toLowerCase();
  const roomCopy = roomLabel(reservation, language);
  const confirmationLink = confirmationUrl(siteUrl, reservation.id, manageToken);
  const cancelLink = `${siteUrl}/anulare.html?token=${encodeURIComponent(cancellationToken)}`;
  const name = `${reservation.guest_first_name || ''} ${reservation.guest_last_name || ''}`.trim();
  const stay = `${reservation.check_in} - ${reservation.check_out}`;
  const sms = confirmationSms(language, reservation.check_in, reservation.check_out);
  const subject = subjectLine(language);
  const text = [
    greeting(language, name),
    `${label(language, 'period')}: ${stay}`,
    `${label(language, 'room')}: ${roomCopy}`,
    `${label(language, 'total')}: ${reservation.total_price} MDL`,
    `${label(language, 'confirm')}: ${confirmationLink}`,
    `${label(language, 'cancel')}: ${cancelLink}`,
  ].join('\n');

  return {
    sms,
    subject,
    text,
    html: [
      '<!doctype html><html><body>',
      `<h1>${escapeHtml(subject)}</h1>`,
      `<p>${escapeHtml(greeting(language, name))}</p>`,
      '<table>',
      row(label(language, 'period'), stay),
      row(label(language, 'room'), roomCopy),
      row(label(language, 'total'), `${reservation.total_price} MDL`),
      '</table>',
      `<p><a href="${escapeAttribute(confirmationLink)}">${
        escapeHtml(label(language, 'confirm'))
      }</a></p>`,
      `<p><a href="${escapeAttribute(cancelLink)}">${
        escapeHtml(label(language, 'cancel'))
      }</a></p>`,
      '</body></html>',
    ].join(''),
  };
}

function confirmationUrl(siteUrl: string, reservationId: string, manageToken: string) {
  const params = new URLSearchParams();
  params.set('id', reservationId);

  if (manageToken) {
    params.set('manage', manageToken);
  }

  return `${siteUrl}/confirmare.html?${params.toString()}`;
}

function subjectLine(language: string) {
  if (language === 'ru') return 'Бронирование EcoVila подтверждено';
  if (language === 'en') return 'EcoVila reservation confirmed';
  return 'Rezervarea EcoVila este confirmată';
}

function greeting(language: string, name: string) {
  if (language === 'ru') return `Здравствуйте${name ? `, ${name}` : ''}!`;
  if (language === 'en') return `Hello${name ? `, ${name}` : ''}!`;
  return `Bună${name ? `, ${name}` : ''}!`;
}

function label(language: string, key: string) {
  const labels: Record<string, Record<string, string>> = {
    ro: {
      period: 'Perioada',
      room: 'Cazare',
      total: 'Total',
      confirm: 'Vezi rezervarea',
      cancel: 'Anulează rezervarea',
    },
    ru: {
      period: 'Период',
      room: 'Размещение',
      total: 'Итого',
      confirm: 'Открыть бронирование',
      cancel: 'Отменить бронирование',
    },
    en: {
      period: 'Period',
      room: 'Accommodation',
      total: 'Total',
      confirm: 'View reservation',
      cancel: 'Cancel reservation',
    },
  };

  return labels[language]?.[key] || labels.ro[key] || key;
}

function roomLabel(reservation: PaymentReservationRow, language: string) {
  if (!reservation.room_number) return 'EcoVila';
  if (language === 'ru') return `Домик #${reservation.room_number}`;
  if (language === 'en') return `Villa #${reservation.room_number}`;
  return `Căsuța #${reservation.room_number}`;
}

function confirmationSms(language: string, checkIn: string, checkOut: string) {
  if (language === 'ru') {
    return `Бронь: ${checkIn}, 13.00 - ${checkOut}, 10.00. Вход с 13.00.`;
  }

  if (language === 'en') {
    return `Your reservation is confirmed: ${checkIn}, 13.00 - ${checkOut}, 10.00. Access to the property: after 13.00. See you soon!`;
  }

  return `Rezervarea dvs este confirmata: ${checkIn}, 13.00 - ${checkOut}, 10.00. Acces pe teritoriu: dupa 13.00. Va asteptam!`;
}

function row(labelText: string, value: string) {
  return `<tr><th align="left">${escapeHtml(labelText)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function escapeHtml(value: string) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}
