// ONE-OFF BACKFILL (B-39) — DELETE THIS FUNCTION WHEN THE RUNS ARE DONE.
//
// ADR-082's post-stay review email never sent between 2026-06-23 and 2026-08-31:
// `review_request` was absent from the notification_events CHECK constraint, the
// function caught the violation per guest into console.error, and the cron reported
// success because the HTTP POST worked. 552 bookings went un-asked. The constraint is
// repaired (ADR-111), so the normal flow resumes on its own; this catches up the
// window the owner approved.
//
// Deliberately NOT scheduled. It is invoked by hand, in three modes:
//   dry-run  (default) — report who would receive it. Sends nothing, records nothing.
//   test               — render one real recipient's email and deliver it to
//                        `testEmail`. Records NOTHING, so that guest still gets their
//                        own copy in a later send run.
//   send               — deliver up to `limit` emails and record each one, so the
//                        next run continues where this stopped and no guest is ever
//                        asked twice.
import { handleCors } from '../_shared/cors.ts';
import { getSiteUrl } from '../_shared/env.ts';
import {
  assertMethod,
  errorResponse,
  jsonResponse,
  readJson,
  requireSharedSecret,
} from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  composeReviewRequest,
  dispatchNotification,
  recordNotificationEvent,
  resolveStableGroupOwnerIds,
} from '../_shared/notifications.ts';
import { aggregateCheckoutStatus } from '../_shared/reviewRequests.ts';
import { withRoomFields } from '../_shared/reservations.ts';
import { normalizeBackfillEmail, selectBackfillRecipients } from './selection.ts';
import type { BackfillRow } from './selection.ts';
import type { DailyStatusRow } from '../_shared/reviewRequests.ts';
import type { NotificationReservation } from '../_shared/notifications.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

const REVIEW_REQUEST_EVENT = 'review_request';
const WINDOW_DAYS = 30;
const DEFAULT_LIMIT = 40;

type RoomJoin = { number?: number | string | null; type?: string | null };

type BackfillReservation = NotificationReservation & BackfillRow & {
  room_id?: string | null;
  rooms?: RoomJoin | RoomJoin[] | null;
};

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  gte(column: string, value: unknown): QueryBuilder<T>;
  lt(column: string, value: unknown): QueryBuilder<T>;
};

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    requireSharedSecret(request);

    const body = await readJson(request).catch(() => ({}));
    const mode = String((body as Record<string, unknown>)?.mode || 'dry-run');
    const limit = Number((body as Record<string, unknown>)?.limit) || DEFAULT_LIMIT;
    const testEmail = String((body as Record<string, unknown>)?.testEmail || '').trim();

    const client = createServiceClient();
    const recipients = await loadRecipients(client);

    if (mode === 'dry-run') {
      return jsonResponse(
        {
          mode,
          eligible: recipients.length,
          window_days: WINDOW_DAYS,
          oldest_checkout: recipients[recipients.length - 1]?.owner.check_out || null,
          newest_checkout: recipients[0]?.owner.check_out || null,
          sample: recipients.slice(0, 5).map((entry) => ({
            check_out: entry.owner.check_out,
            rooms_in_booking: entry.group.length,
            language: entry.owner.guest_language || 'ro',
          })),
        },
        {},
        request,
      );
    }

    if (mode === 'test') {
      if (!testEmail) {
        return jsonResponse(
          { error: 'testEmail is required for mode=test' },
          { status: 400 },
          request,
        );
      }
      const first = recipients[0];
      if (!first) {
        return jsonResponse({ mode, sent: 0, reason: 'no eligible recipients' }, {}, request);
      }
      const message = buildMessage(first.owner, first.group);
      // Redirect the delivery, keep the rendering identical to what a guest gets.
      // Nothing is recorded, so this guest still receives their own copy later.
      await dispatchNotification({
        ...message,
        sms: null,
        email: message.email ? { ...message.email, to: testEmail } : null,
      });
      return jsonResponse(
        {
          mode,
          sent_to: testEmail,
          rendered_for_checkout: first.owner.check_out,
          recorded: false,
          eligible_total: recipients.length,
        },
        {},
        request,
      );
    }

    if (mode !== 'send') {
      return jsonResponse({ error: `unknown mode: ${mode}` }, { status: 400 }, request);
    }

    const batch = recipients.slice(0, Math.max(1, limit));
    const stableOwners = await resolveStableGroupOwnerIds(
      client,
      batch.map((entry) => entry.owner),
    );
    let sent = 0;
    const failures: Array<{ check_out: string; error: string }> = [];

    for (const entry of batch) {
      const dedupId = stableOwners.get(entry.owner.booking_group_id || entry.owner.id) ||
        entry.owner.id;
      try {
        const result = await dispatchNotification(buildMessage(entry.owner, entry.group));
        // Recorded AFTER a successful send, and only then: a recorded failure would
        // silently retire a guest who never received anything.
        await recordNotificationEvent(client, dedupId, REVIEW_REQUEST_EVENT, {
          backfill: true,
          checkout_date: entry.owner.check_out,
        }, result);
        sent += 1;
      } catch (error) {
        failures.push({
          check_out: entry.owner.check_out,
          error: error instanceof Error ? error.message : 'send failed',
        });
      }
    }

    return jsonResponse(
      {
        mode,
        sent,
        failed: failures.length,
        failures: failures.slice(0, 5),
        remaining_after_this_run: Math.max(0, recipients.length - sent),
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

function buildMessage(owner: BackfillReservation, group: BackfillReservation[]) {
  return composeReviewRequest(owner, {
    siteUrl: getSiteUrl(),
    groupReservations: group,
  });
}

async function loadRecipients(client: SupabaseClient) {
  const today = new Date();
  const windowStart = new Date(today.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const todayIso = today.toISOString().slice(0, 10);

  const { data, error } = await table<BackfillReservation[]>(client, 'reservations')
    .select(
      'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, total_price, payment_type, rooms(number, type)',
    )
    .eq('payment_status', 'paid')
    .is('cancelled_at', null)
    .gte('check_out', windowStart)
    .lt('check_out', todayIso);

  if (error) throw new Error(error.message);

  const reservations = (data || [])
    .map(withRoomFields)
    .filter((row) => normalizeBackfillEmail(row.guest_email)) as BackfillReservation[];

  if (!reservations.length) return [];

  const ids = reservations.map((row) => row.id);
  const [statuses, complaints, alreadySentEmails] = await Promise.all([
    fetchDailyStatuses(client, ids),
    fetchComplaints(client),
    fetchAlreadySentEmails(client),
  ]);

  return selectBackfillRecipients({
    reservations,
    statusByReservation: aggregateCheckoutStatus(statuses),
    complaintPhones: complaints.phones,
    complaintReservationIds: complaints.reservationIds,
    alreadySentEmails,
  });
}

async function fetchDailyStatuses(client: SupabaseClient, reservationIds: string[]) {
  const rows: DailyStatusRow[] = [];
  // Chunked for the same reason as B-37: a single `in.(...)` of every id overflows
  // the PostgREST URL and answers 400.
  for (let index = 0; index < reservationIds.length; index += 200) {
    const { data, error } = await table<DailyStatusRow[]>(client, 'crm_daily_statuses')
      .select('reservation_id, checked_out_at, checkout_note')
      .in('reservation_id', reservationIds.slice(index, index + 200));
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
  }
  return rows;
}

async function fetchComplaints(client: SupabaseClient) {
  const { data, error } = await table<
    Array<{ guest_phone: string | null; reservation_id: string | null }>
  >(
    client,
    'complaints',
  ).select('guest_phone, reservation_id');
  if (error) throw new Error(error.message);

  const phones = new Set<string>();
  const reservationIds = new Set<string>();
  for (const row of data || []) {
    if (row.guest_phone) phones.add(String(row.guest_phone).trim());
    if (row.reservation_id) reservationIds.add(row.reservation_id);
  }
  return { phones, reservationIds };
}

async function fetchAlreadySentEmails(client: SupabaseClient) {
  const { data, error } = await table<
    Array<
      {
        reservations?:
          | { guest_email?: string | null }
          | Array<{ guest_email?: string | null }>
          | null;
      }
    >
  >(client, 'notification_events')
    .select('reservation_id, reservations!inner(guest_email)')
    .eq('event_type', REVIEW_REQUEST_EVENT);
  if (error) throw new Error(error.message);

  const emails = new Set<string>();
  for (const row of data || []) {
    const joined = Array.isArray(row.reservations)
      ? row.reservations
      : row.reservations
      ? [row.reservations]
      : [];
    for (const reservation of joined) {
      const email = normalizeBackfillEmail(reservation.guest_email);
      if (email) emails.add(email);
    }
  }
  return emails;
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
