import {
  buildGuestFlagAlertEmail,
  dispatchScheduledNotificationOnce,
  mapNotificationOwners,
  resolveStableGroupOwnerIds,
  titleCaseName,
} from './notifications.ts';
import {
  fetchGuestFlagMarkers,
  fetchGuestNotesForContacts,
  fetchPreviousBookings,
  matchGuestFlags,
  normalizeNoteEmail,
} from './guestNotes.ts';
import type { NotificationMessage, NotificationReservation } from './notifications.ts';
import type { GuestFlagMarker, GuestNote, PreviousStay } from './guestNotes.ts';
import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

const GUEST_FLAG_EVENT = 'guest_flag_alert';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  gte(column: string, value: unknown): QueryBuilder<T>;
};

type RoomJoin = {
  number?: number | string | null;
  type?: string | null;
};

export type GuestFlagReservationRow = NotificationReservation & {
  booking_group_id: string | null;
  adults: number;
  kids_ages: number[] | null;
  payment_status: string;
  created_at: string;
  rooms?: RoomJoin | RoomJoin[] | null;
};

type RecentAlertReservation = {
  guest_phone: string | null;
  guest_email: string | null;
};

type RecentAlertEvent = {
  reservation_id: string;
  attempted_at: string | null;
  reservations?: RecentAlertReservation | RecentAlertReservation[] | null;
};

type DispatchResult = {
  sent: boolean;
  skipped_duplicate?: boolean;
};

export type GuestFlagAlertDependencies = {
  fetchMarkers?: (client: SupabaseClient) => Promise<GuestFlagMarker[]>;
  fetchNotes?: (
    client: SupabaseClient,
    contacts: { phone?: unknown; email?: unknown },
  ) => Promise<GuestNote[]>;
  fetchPrevious?: (
    client: SupabaseClient,
    contacts: { phone?: unknown; email?: unknown; excludeBookingGroupId?: string | null },
  ) => Promise<PreviousStay[]>;
  dispatch?: (
    client: SupabaseClient,
    reservationId: string,
    eventType: string,
    message: NotificationMessage,
    metadata: Record<string, unknown>,
  ) => Promise<DispatchResult>;
};

export type GuestFlagAlertSummary = {
  scanned: number;
  matched: number;
  sent: number;
  skipped: number;
};

export async function sweepGuestFlagAlerts(
  client: SupabaseClient,
  args: { recipient: string; siteUrl: string; now?: Date },
  dependencies: GuestFlagAlertDependencies = {},
): Promise<GuestFlagAlertSummary> {
  const recipient = String(args.recipient || '').trim();
  if (!recipient) {
    return emptySummary();
  }

  const fetchMarkers = dependencies.fetchMarkers || fetchGuestFlagMarkers;
  const markers = await fetchMarkers(client);
  if (!markers.length) {
    return emptySummary();
  }

  const now = args.now || new Date();
  const reservations = await fetchRecentReservations(client, now);
  const matchedReservations = reservations.filter((reservation) =>
    Boolean(
      matchGuestFlags(markers, {
        phone: reservation.guest_phone,
        email: reservation.guest_email,
      }),
    )
  );
  if (!matchedReservations.length) {
    return {
      scanned: reservations.length,
      matched: 0,
      sent: 0,
      skipped: 0,
    };
  }

  const recentContacts = await fetchRecentAlertContacts(client, now);
  const owners = mapNotificationOwners(matchedReservations);
  // mapNotificationOwners decides WHAT to send from the rows it is handed; this
  // decides the id the send is RECORDED against, resolved across every row of the
  // group including cancelled siblings. Without it a partial cancellation (ADR-104)
  // inside the 24h window promotes a new owner, whose missing event re-sends.
  const stableOwners = await resolveStableGroupOwnerIds(client, matchedReservations);
  const fetchNotes = dependencies.fetchNotes || fetchGuestNotesForContacts;
  const fetchPrevious = dependencies.fetchPrevious || fetchPreviousBookings;
  const dispatch = dependencies.dispatch || dispatchScheduledNotificationOnce;
  let sent = 0;
  let skipped = 0;

  for (const [ownerId, group] of owners) {
    const owner = group.find((reservation) => reservation.id === ownerId) || group[0];
    const phone = String(owner.guest_phone || '').trim();
    const email = normalizeNoteEmail(owner.guest_email);
    const flagMatch = matchGuestFlags(markers, { phone, email });

    if (
      !flagMatch ||
      (Boolean(phone) && recentContacts.phones.has(phone)) ||
      (Boolean(email) && recentContacts.emails.has(email))
    ) {
      skipped += 1;
      continue;
    }

    try {
      const [notes, previousStays] = await Promise.all([
        fetchNotes(client, { phone, email }),
        fetchPrevious(client, {
          phone,
          email,
          excludeBookingGroupId: owner.booking_group_id || owner.id,
        }),
      ]);
      const emailMessage = buildGuestFlagAlertEmail({
        fullName: titleCaseName(`${owner.guest_first_name} ${owner.guest_last_name}`),
        phone,
        email,
        notes,
        groupReservations: group,
        previousStays,
        siteUrl: args.siteUrl,
      });
      const message: NotificationMessage = {
        sms: null,
        email: {
          to: recipient,
          subject: emailMessage.subject,
          html: emailMessage.html,
          text: emailMessage.text,
        },
      };

      // Delivery is at-least-once: the provider send happens before the event is
      // marked sent, matching the retry semantics of the other scheduled notices.
      if (phone) recentContacts.phones.add(phone);
      if (email) recentContacts.emails.add(email);
      const groupKey = owner.booking_group_id || owner.id;
      const dedupId = stableOwners.get(groupKey) || owner.id;
      const result = await dispatch(client, dedupId, GUEST_FLAG_EVENT, message, {
        booking_group_id: groupKey,
        severity: flagMatch.severity,
        has_attention: flagMatch.hasAttention,
        has_vip: flagMatch.hasVip,
        note_count: notes.length,
      });

      if (result.sent) {
        sent += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      console.error('Guest flag alert failed', error);
      skipped += 1;
    }
  }

  return {
    scanned: reservations.length,
    matched: matchedReservations.length,
    sent,
    skipped,
  };
}

async function fetchRecentReservations(
  client: SupabaseClient,
  now: Date,
): Promise<GuestFlagReservationRow[]> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await table<GuestFlagReservationRow[]>(client, 'reservations')
    .select(
      'id, booking_group_id, guest_first_name, guest_last_name, guest_phone, guest_email, check_in, check_out, adults, kids_ages, total_price, payment_type, payment_status, created_at, rooms(number, type)',
    )
    .gte('created_at', cutoff)
    .is('cancelled_at', null);

  if (error) {
    throw new Error(error.message || 'Could not load recent reservations.');
  }

  return data || [];
}

async function fetchRecentAlertContacts(
  client: SupabaseClient,
  now: Date,
): Promise<{ phones: Set<string>; emails: Set<string> }> {
  const cutoff = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const { data, error } = await table<RecentAlertEvent[]>(client, 'notification_events')
    .select(
      'reservation_id, attempted_at, reservations!inner(guest_phone, guest_email)',
    )
    .eq('event_type', GUEST_FLAG_EVENT)
    // Only a DELIVERED alert may suppress the next one. Counting 'reserved' or
    // 'failed' rows here would let one provider hiccup mute the guest for six
    // hours — defeating the retry this cron exists to provide.
    .eq('delivery_status', 'sent')
    .gte('attempted_at', cutoff);

  if (error) {
    throw new Error(error.message || 'Could not load recent guest flag alerts.');
  }

  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const event of data || []) {
    const reservations = Array.isArray(event.reservations)
      ? event.reservations
      : event.reservations
      ? [event.reservations]
      : [];
    for (const reservation of reservations) {
      const phone = String(reservation.guest_phone || '').trim();
      const email = normalizeNoteEmail(reservation.guest_email);
      if (phone) phones.add(phone);
      if (email) emails.add(email);
    }
  }

  return { phones, emails };
}

function emptySummary(): GuestFlagAlertSummary {
  return { scanned: 0, matched: 0, sent: 0, skipped: 0 };
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
