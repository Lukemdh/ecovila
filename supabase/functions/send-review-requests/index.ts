import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, requireSharedSecret } from '../_shared/http.ts';
import { getSiteUrl } from '../_shared/env.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  composeReviewRequest,
  dispatchScheduledNotificationOnce,
} from '../_shared/notifications.ts';
import { reviewRequestTargetDate, shouldSendReviewRequests } from '../_shared/reminders.ts';
import { aggregateCheckoutStatus, selectReviewRequestGroups } from '../_shared/reviewRequests.ts';
import { withRoomFields } from '../_shared/reservations.ts';
import type { NotificationReservation } from '../_shared/notifications.ts';
import type { DailyStatusRow } from '../_shared/reviewRequests.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

// notification_events.event_type for the once-per-guest post-stay review nudge.
const REVIEW_REQUEST_EVENT = 'review_request';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
};

type RoomJoin = {
  number?: number | string | null;
  type?: string | null;
};

type ReviewReservationRow = NotificationReservation & {
  booking_group_id?: string | null;
  room_id?: string | null;
  rooms?: RoomJoin | RoomJoin[] | null;
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
    assertMethod(request, ['POST', 'GET']);
    requireSharedSecret(request);

    const now = new Date();
    // The cron triggers every minute across a UTC window that brackets 18:30
    // Europe/Chisinau year-round; this gate keeps the actual send to the
    // [18:30, 19:00) local window and skips the DB work the rest of the time.
    if (!shouldSendReviewRequests(now)) {
      return jsonResponse({ skipped: true, reason: 'outside_send_window' }, {}, request);
    }

    const client = createServiceClient();
    const reviewRequests = await sendReviewRequests(client, now);

    return jsonResponse({ reviewRequests }, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function sendReviewRequests(client: SupabaseClient, now: Date) {
  // "One day after the stay" = yesterday's local checkout date in Europe/Chisinau.
  const checkoutDate = reviewRequestTargetDate(now);

  const { data, error } = await table<ReviewReservationRow[]>(client, 'reservations')
    .select(
      'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, rooms(number, type)',
    )
    .eq('payment_status', 'paid')
    .is('cancelled_at', null)
    .eq('check_out', checkoutDate);

  if (error) {
    throw new Error(error.message);
  }

  const reservations = (data || []).map(withRoomFields) as ReviewReservationRow[];
  if (!reservations.length) {
    return [];
  }

  const statusByReservation = aggregateCheckoutStatus(
    await fetchCheckoutStatuses(client, reservations.map((reservation) => reservation.id)),
  );
  const eligible = selectReviewRequestGroups({ reservations, statusByReservation });

  const results: NotificationResult[] = [];

  for (const { owner, group } of eligible) {
    // The review nudge is email-only — skip silently when the owner booking has no
    // email on file so we never burn the once-ever dedup slot on a no-op send.
    if (!String(owner.guest_email || '').trim()) {
      results.push({ reservationId: owner.id, sent: false, skipped_duplicate: true });
      continue;
    }

    try {
      const message = composeReviewRequest(reservationForNotification(owner), {
        siteUrl: getSiteUrl(),
        groupReservations: group.map(reservationForNotification),
      });
      const result = await dispatchScheduledNotificationOnce(
        client,
        owner.id,
        REVIEW_REQUEST_EVENT,
        message,
      );
      results.push({
        reservationId: owner.id,
        ...result,
        skipped_duplicate: result.skipped_duplicate,
      });
    } catch (error) {
      console.error('Review request notification failed', error);
      results.push({
        reservationId: owner.id,
        sent: false,
        error: error instanceof Error ? error.message : 'Notification failed.',
      });
    }
  }

  return results;
}

async function fetchCheckoutStatuses(
  client: SupabaseClient,
  reservationIds: string[],
): Promise<DailyStatusRow[]> {
  if (!reservationIds.length) {
    return [];
  }

  const { data, error } = await table<DailyStatusRow[]>(client, 'crm_daily_statuses')
    .select('reservation_id, checked_out_at, checkout_note')
    .in('reservation_id', reservationIds);

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}

function reservationForNotification(reservation: ReviewReservationRow): NotificationReservation {
  return {
    ...reservation,
    guest_language: reservation.guest_language || undefined,
  };
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
