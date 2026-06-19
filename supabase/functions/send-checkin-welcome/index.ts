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
  composeCheckinWelcome,
  dispatchScheduledNotificationOnce,
  mapNotificationOwners,
} from '../_shared/notifications.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { NotificationReservation } from '../_shared/notifications.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type ReservationRow = NotificationReservation & {
  booking_group_id?: string | null;
  payment_status?: string | null;
  cancelled_at?: string | null;
};

const RESERVATION_FIELDS =
  'id, booking_group_id, guest_first_name, guest_last_name, guest_phone, guest_email, ' +
  'guest_language, check_in, check_out, total_price, payment_type, payment_status, cancelled_at';

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    await requireStaffRole(request, ['diana', 'angela']);

    const body = await readJson(request);
    const reservationId = String(body?.reservationId || '').trim();
    if (!reservationId) {
      throw new HttpError(400, 'reservationId is required.');
    }

    const client = createServiceClient();
    const reservation = await findReservation(client, reservationId);

    // Welcome only real arrivals. A guest checked in is paid; never message a
    // cancelled booking. Returning ok keeps the CRM check-in action from failing.
    if (!reservation || reservation.payment_status !== 'paid' || reservation.cancelled_at) {
      return jsonResponse({ ok: true, sent: false, skipped: 'not_eligible' }, {}, request);
    }

    // One SMS per booking group: resolve the group's deterministic owner so a
    // multi-villa booking (or a re-toggled check-in) sends exactly once. The
    // dedup is keyed on the owner reservation id in notification_events.
    const owner = await resolveGroupOwner(client, reservation);
    const result = await dispatchScheduledNotificationOnce(
      client,
      owner.id,
      'checkin_welcome',
      composeCheckinWelcome(reservationForNotification(owner)),
    );

    return jsonResponse({ ok: true, ...result }, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function findReservation(client: SupabaseClient, reservationId: string) {
  const { data, error } = await table<ReservationRow>(client, 'reservations')
    .select(RESERVATION_FIELDS)
    .eq('id', reservationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function resolveGroupOwner(
  client: SupabaseClient,
  reservation: ReservationRow,
): Promise<ReservationRow> {
  const groupId = reservation.booking_group_id || reservation.id;
  const { data, error } = await tableList<ReservationRow[]>(client, 'reservations')
    .select(RESERVATION_FIELDS)
    .eq('booking_group_id', groupId);

  if (error) throw new Error(error.message);

  // Only paid, non-cancelled members are eligible to "own" the welcome, so the
  // dedup key never lands on a cancelled villa of a mixed-status group. The
  // checked-in reservation always qualifies, so the fallback is never empty.
  const eligible = (data || [])
    .filter((row) => row.payment_status === 'paid' && !row.cancelled_at);
  const rows = eligible.length ? eligible : [reservation];
  const owners = mapNotificationOwners(rows);
  const ownerId = [...owners.keys()][0];
  return rows.find((row) => row.id === ownerId) || reservation;
}

function reservationForNotification(reservation: ReservationRow): NotificationReservation {
  return {
    ...reservation,
    guest_language: reservation.guest_language || undefined,
  };
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}

function tableList<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as unknown as {
    select(columns: string): {
      eq(column: string, value: unknown): PromiseLike<SupabaseQueryResult<T>>;
    };
  };
}
