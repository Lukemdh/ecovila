import { handleCors } from '../_shared/cors.ts';
import {
  assertMethod,
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireStaffRole,
} from '../_shared/http.ts';
import { getSiteUrl } from '../_shared/env.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  composeBookingConfirmation,
  dispatchScheduledNotificationOnce,
} from '../_shared/notifications.ts';
import { buildManageTokenRow } from '../_shared/reservationManage.ts';
import { buildCancellationTokenRows, withRoomFields } from '../_shared/reservations.ts';
import { dispatchPurchaseTrackingOnce } from '../_shared/tracking.ts';
import type { NotificationReservation } from '../_shared/notifications.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  single(): Promise<SupabaseQueryResult<T>>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type RoomJoin = {
  number?: number | string | null;
  type?: string | null;
};

type ConfirmableReservationRow = NotificationReservation & {
  booking_group_id: string;
  room_id?: string | null;
  payment_status: 'pending' | 'paid' | string;
  rooms?: RoomJoin | RoomJoin[] | null;
  tracking_event_id?: string | null;
  tracking_fbp?: string | null;
  tracking_fbc?: string | null;
  tracking_user_agent?: string | null;
  tracking_source_url?: string | null;
};

type CancellationTokenRow = {
  reservation_id?: string;
  token?: string | null;
};

type NotificationDispatchResult = Awaited<ReturnType<typeof dispatchScheduledNotificationOnce>>;

type NotificationResult = {
  reservationId: string;
  sent: boolean;
  skipped_duplicate?: boolean;
  abandoned?: boolean;
  retry_pending?: boolean;
  result?: NotificationDispatchResult['result'];
  error?: string;
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
    const reservationId = optionalString(body?.reservationId);
    const bookingGroupId = optionalString(body?.bookingGroupId);

    if (!reservationId && !bookingGroupId) {
      throw new HttpError(400, 'reservationId or bookingGroupId is required.');
    }

    const client = createServiceClient();
    const reservations = await findConfirmableReservations(client, {
      reservationId,
      bookingGroupId,
    });
    const now = new Date().toISOString();
    const ids = reservations.map((reservation) => reservation.id);

    if (!ids.length) {
      return jsonResponse(
        {
          ok: true,
          status: 'paid',
          matched: 0,
          reservationIds: [],
          notificationResults: [],
        },
        {},
        request,
      );
    }

    const pendingIds = reservations
      .filter((reservation) => reservation.payment_status === 'pending')
      .map((reservation) => reservation.id);

    if (pendingIds.length) {
      // Re-assert pending inside the UPDATE so a reservation the expiry cron
      // cancelled between this function's SELECT and UPDATE is left untouched.
      const { error } = await table(client, 'reservations')
        .update({ payment_status: 'paid', cash_expires_at: null, paid_at: now })
        .in('id', pendingIds)
        .eq('payment_status', 'pending')
        .is('cancelled_at', null);

      if (error) {
        throw new Error(error.message);
      }
    }

    const [notificationResults, trackingResult] = await Promise.all([
      notifyPaidReservations(client, reservations),
      dispatchPurchaseTrackingOnce(client, reservations, { source: 'confirm-reservation-payment' }),
    ]);

    return jsonResponse(
      {
        ok: true,
        status: 'paid',
        matched: ids.length,
        updated: pendingIds.length,
        reservationIds: ids,
        notificationResults,
        trackingResult,
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function findConfirmableReservations(
  client: SupabaseClient,
  input: { reservationId?: string; bookingGroupId?: string },
) {
  let query = table<ConfirmableReservationRow[]>(client, 'reservations')
    .select(
      'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, payment_status, tracking_event_id, tracking_fbp, tracking_fbc, tracking_user_agent, tracking_source_url, rooms(number, type)',
    )
    .eq('payment_type', 'cash')
    .in('payment_status', ['pending', 'paid'])
    .is('cancelled_at', null);

  query = input.bookingGroupId
    ? query.eq('booking_group_id', input.bookingGroupId)
    : query.eq('id', input.reservationId);

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map(withRoomFields);
}

async function notifyPaidReservations(
  client: SupabaseClient,
  reservations: ConfirmableReservationRow[],
) {
  const results: NotificationResult[] = [];
  const siteUrl = getSiteUrl();

  for (const reservation of reservations) {
    try {
      let token = await findCancellationToken(client, reservation.id);
      if (!token) {
        const tokenRows = buildCancellationTokenRows([reservation]);
        const { data, error } = await table<CancellationTokenRow>(client, 'cancellation_tokens')
          .insert(tokenRows)
          .select('reservation_id, token')
          .single();

        if (error) {
          throw new Error(error.message);
        }

        token = data?.token || '';
      }

      const manageToken = await createManageTokenForNotification(client, reservation.guest_phone);
      const result = await dispatchScheduledNotificationOnce(
        client,
        reservation.id,
        'payment_confirmation',
        composeBookingConfirmation(reservationForNotification(reservation), {
          cancellationToken: token,
          manageToken,
          siteUrl,
        }),
      );
      results.push({
        reservationId: reservation.id,
        ...result,
        skipped_duplicate: result.skipped_duplicate,
      });
    } catch (error) {
      console.error('Staff payment notification failed', error);
      results.push({
        reservationId: reservation.id,
        sent: false,
        error: error instanceof Error ? error.message : 'Notification failed.',
      });
    }
  }

  return results;
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

function reservationForNotification(
  reservation: ConfirmableReservationRow,
): NotificationReservation {
  return {
    ...reservation,
    guest_language: reservation.guest_language || undefined,
  };
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}

function optionalString(value: unknown) {
  return String(value || '').trim() || undefined;
}
