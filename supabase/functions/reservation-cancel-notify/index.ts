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

// Staff CRM cancellations are recorded as 'reservation_cancelled' so they stay
// distinct from guest self-service cancellations ('guest_cancellation'). The
// per-reservation unique constraint keeps the guest from being notified twice.
const EVENT_TYPE = 'reservation_cancelled';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
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

    const notificationResults = await notifyCancelledReservations(client, reservations);

    return jsonResponse({ ok: true, notificationResults }, {}, request);
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

      const message = composeCancellation(reservation, group);
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
): NotificationMessage {
  // The owner reservation's email lists every villa in the booking group.
  const group = groupReservations.length ? groupReservations : [reservation];
  const roomCopy = [...new Set(group.map((row) => roomLabel(row)))].join(', ');
  const lang = normalizeEmailLang(reservation.guest_language);
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

function roomLabel(reservation: CancelledReservationRow) {
  const room = Array.isArray(reservation.rooms) ? reservation.rooms[0] : reservation.rooms;
  const type = room?.type || 'hotel';
  const number = room?.number;
  const typeLabel = type === 'small' ? 'Căsuță Mică' : type === 'large' ? 'Căsuță Mare' : 'Hotel';
  return number ? `${typeLabel} #${number}` : typeLabel;
}

function providerError(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Provider request failed.');
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
