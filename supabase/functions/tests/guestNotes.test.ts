import { assertEquals, assertFalse, assertStringIncludes } from 'std/assert';
import {
  fetchPreviousBookings,
  matchGuestFlags,
  normalizeNoteEmail,
} from '../_shared/guestNotes.ts';
import { sweepGuestFlagAlerts } from '../_shared/guestFlagAlerts.ts';
import { buildGuestFlagAlertEmail } from '../_shared/notifications.ts';
import type { GuestFlagMarker, GuestNote, PreviousStay } from '../_shared/guestNotes.ts';
import type { GuestFlagReservationRow } from '../_shared/guestFlagAlerts.ts';
import type { SupabaseClient } from '../_shared/supabaseAdmin.ts';

const ATTENTION_MARKER: GuestFlagMarker = {
  id: 'attention-note',
  guest_phone: '+37369000000',
  guest_email: null,
  severity: 'attention',
  created_at: '2026-08-30T10:00:00Z',
  body_preview: 'Needs attention',
};

const VIP_MARKER: GuestFlagMarker = {
  id: 'vip-note',
  guest_phone: null,
  guest_email: 'a@b.md',
  severity: 'vip',
  created_at: '2026-08-29T10:00:00Z',
  body_preview: 'VIP',
};

Deno.test('matchGuestFlags matches phone and case-insensitive email contacts', () => {
  assertEquals(
    matchGuestFlags([ATTENTION_MARKER], { phone: '+37369000000', email: null })?.severity,
    'attention',
  );
  assertEquals(
    matchGuestFlags([VIP_MARKER], { phone: '', email: 'A@B.md' })?.severity,
    'vip',
  );
  assertEquals(normalizeNoteEmail('  A@B.md  '), 'a@b.md');
});

Deno.test('matchGuestFlags never matches empty contacts', () => {
  const emptyMarkers: GuestFlagMarker[] = [
    { ...ATTENTION_MARKER, guest_phone: '' },
    { ...VIP_MARKER, guest_email: null },
  ];
  assertEquals(matchGuestFlags(emptyMarkers, { phone: '', email: null }), null);
  assertEquals(matchGuestFlags(emptyMarkers, { phone: null, email: '' }), null);
});

Deno.test('matchGuestFlags reports both flags and gives attention precedence', () => {
  const match = matchGuestFlags([VIP_MARKER, ATTENTION_MARKER], {
    phone: '+37369000000',
    email: 'A@B.md',
  });

  assertEquals(match?.severity, 'attention');
  assertEquals(match?.hasAttention, true);
  assertEquals(match?.hasVip, true);
  assertEquals(match?.notes.length, 2);
});

Deno.test('fetchPreviousBookings returns three groups, collapses villas, and excludes current', async () => {
  const rows = [
    previousRow('current-a', 'current', '2026-08-20', 'small'),
    previousRow('current-b', 'current', '2026-08-20', 'large'),
    previousRow('stay-a-1', 'stay-a', '2026-07-10', 'small', 2, [7]),
    previousRow('stay-a-2', 'stay-a', '2026-07-10', 'small', 1, [9, 12]),
    previousRow('stay-b', 'stay-b', '2026-06-10', 'large'),
    previousRow('stay-c', 'stay-c', '2026-05-10', 'hotel'),
    previousRow('stay-d', 'stay-d', '2026-04-10', 'small'),
  ];
  const client = fakeClient({ reservations: rows });

  const stays = await fetchPreviousBookings(client, {
    phone: '+37369000000',
    email: null,
    excludeBookingGroupId: 'current',
  });

  assertEquals(stays.length, 3);
  assertEquals(stays.map((stay) => stay.bookingGroupId), ['stay-a', 'stay-b', 'stay-c']);
  assertEquals(stays[0].adults, 3);
  assertEquals(stays[0].kidsCount, 3);
  assertEquals(stays[0].accommodation, '2× Căsuță mică');
});

Deno.test('buildGuestFlagAlertEmail escapes content, caps notes, and keeps old stays money-free', () => {
  const longBody = 'L'.repeat(2000);
  const notes: GuestNote[] = [
    guestNote('n1', '2026-08-31T10:00:00Z', '<script>alert(1)</script>'),
    guestNote('n2', '2026-08-30T10:00:00Z', longBody),
    guestNote('n3', '2026-08-29T10:00:00Z', 'Third note'),
    guestNote('n4', '2026-08-28T10:00:00Z', 'Fourth note'),
    guestNote('n5', '2026-08-27T10:00:00Z', 'Fifth note'),
    guestNote('n6', '2026-08-26T10:00:00Z', 'SIXTH_NOTE_SHOULD_NOT_APPEAR'),
  ];
  notes[0].source_reservation_id = 'source-stay';
  notes[0].source_reservation = { check_in: '2026-02-01', check_out: '2026-02-03' };
  const previousStay: PreviousStay = {
    bookingGroupId: 'old-group',
    checkIn: '2026-01-10',
    checkOut: '2026-01-12',
    adults: 2,
    kidsCount: 1,
    accommodation: 'Căsuță mare',
    status: 'paid',
  };
  const email = buildGuestFlagAlertEmail({
    fullName: '<script>Guest</script>',
    phone: '+37369000000',
    email: 'guest@example.md',
    notes,
    groupReservations: [
      alertReservation('new-a', 'new-group', 'small', 2, [6]),
      alertReservation('new-b', 'new-group', 'large', 1, [10, 12]),
    ],
    previousStays: [previousStay],
    siteUrl: 'https://ecovila.md',
  });

  assertStringIncludes(email.html, '&lt;script&gt;Guest&lt;/script&gt;');
  assertStringIncludes(email.html, '&lt;script&gt;alert(1)&lt;/script&gt;');
  assertFalse(email.html.includes('<script>Guest</script>'));
  assertFalse(email.html.includes('SIXTH_NOTE_SHOULD_NOT_APPEAR'));
  assertStringIncludes(email.html, `${'L'.repeat(299)}…`);
  assertFalse(email.html.includes('L'.repeat(300)));
  const previousSection = email.html.slice(email.html.indexOf('Sejururi anterioare'));
  assertFalse(previousSection.includes('MDL'));
  assertStringIncludes(email.text, '20 septembrie 2026 – 23 septembrie 2026');
  assertStringIncludes(email.text, '3 adulți, 3 copii');
  assertStringIncludes(email.text, '7 500 MDL');
  assertStringIncludes(email.text, 'Sejur: 1 februarie 2026 – 3 februarie 2026');
});

Deno.test('sweeper with no recipient never reaches reservation or notification reservation', async () => {
  let tableReads = 0;
  let reserveNotificationEventCalls = 0;
  const client: SupabaseClient = {
    from() {
      tableReads += 1;
      return fakeQuery([]);
    },
  };

  const summary = await sweepGuestFlagAlerts(
    client,
    { recipient: '   ', siteUrl: 'https://ecovila.md' },
    {
      dispatch() {
        reserveNotificationEventCalls += 1;
        return Promise.resolve({ sent: true });
      },
    },
  );

  assertEquals(summary, { scanned: 0, matched: 0, sent: 0, skipped: 0 });
  assertEquals(tableReads, 0);
  assertEquals(reserveNotificationEventCalls, 0);
});

Deno.test('sweeper dispatches exactly once for a matching three-villa group', async () => {
  const reservations = [
    alertReservation('c-room', 'three-villas', 'small'),
    alertReservation('a-room', 'three-villas', 'large'),
    alertReservation('b-room', 'three-villas', 'hotel'),
  ];
  const client = fakeClient({ reservations, notification_events: [] });
  let dispatches = 0;
  let ownerId = '';

  const summary = await sweepGuestFlagAlerts(
    client,
    {
      recipient: 'owner@ecovila.md',
      siteUrl: 'https://ecovila.md',
      now: new Date('2026-08-31T12:00:00Z'),
    },
    {
      fetchMarkers: () => Promise.resolve([ATTENTION_MARKER]),
      fetchNotes: () => Promise.resolve([guestNote('active-note', '2026-08-30T10:00:00Z')]),
      fetchPrevious: () => Promise.resolve([]),
      dispatch(_client, reservationId, eventType) {
        dispatches += 1;
        ownerId = reservationId;
        assertEquals(eventType, 'guest_flag_alert');
        return Promise.resolve({ sent: true });
      },
    },
  );

  assertEquals(summary, { scanned: 3, matched: 3, sent: 1, skipped: 0 });
  assertEquals(dispatches, 1);
  assertEquals(ownerId, 'a-room');
});

Deno.test('sweeper storm guard skips a second booking by the same phone within six hours', async () => {
  const reservations = [alertReservation('new-booking', 'new-booking-group', 'small')];
  const recentEvents = [{
    reservation_id: 'prior-booking',
    event_type: 'guest_flag_alert',
    delivery_status: 'sent',
    attempted_at: '2026-08-31T10:00:00Z',
    reservations: {
      guest_phone: '+37369000000',
      guest_email: 'different@example.md',
    },
  }];
  const client = fakeClient({ reservations, notification_events: recentEvents });
  let dispatches = 0;

  const summary = await sweepGuestFlagAlerts(
    client,
    {
      recipient: 'owner@ecovila.md',
      siteUrl: 'https://ecovila.md',
      now: new Date('2026-08-31T12:00:00Z'),
    },
    {
      fetchMarkers: () => Promise.resolve([ATTENTION_MARKER]),
      dispatch() {
        dispatches += 1;
        return Promise.resolve({ sent: true });
      },
    },
  );

  assertEquals(summary, { scanned: 1, matched: 1, sent: 0, skipped: 1 });
  assertEquals(dispatches, 0);
});

Deno.test('sweeper retries after a failed attempt instead of muting it for six hours', async () => {
  const reservations = [alertReservation('new-booking', 'new-booking-group', 'small')];
  // A prior attempt that never reached the provider. Only a DELIVERED alert may
  // suppress the next one, otherwise one provider hiccup silences the guest.
  const recentEvents = [{
    reservation_id: 'prior-booking',
    event_type: 'guest_flag_alert',
    delivery_status: 'failed',
    attempted_at: '2026-08-31T10:00:00Z',
    reservations: { guest_phone: '+37369000000', guest_email: 'guest@example.md' },
  }];
  const client = fakeClient({ reservations, notification_events: recentEvents });
  let dispatches = 0;

  const summary = await sweepGuestFlagAlerts(
    client,
    {
      recipient: 'owner@ecovila.md',
      siteUrl: 'https://ecovila.md',
      now: new Date('2026-08-31T12:00:00Z'),
    },
    {
      fetchMarkers: () => Promise.resolve([ATTENTION_MARKER]),
      fetchNotes: () => Promise.resolve([guestNote('active-note', '2026-08-30T10:00:00Z')]),
      fetchPrevious: () => Promise.resolve([]),
      dispatch() {
        dispatches += 1;
        return Promise.resolve({ sent: true });
      },
    },
  );

  assertEquals(summary.sent, 1);
  assertEquals(dispatches, 1);
});

Deno.test('sweeper records the alert against the stable group owner', async () => {
  // The lowest id of the FULL group is 'a-room', but it was cancelled, so the
  // sweeper only sees b/c. Dedup must still key on 'a-room' or a partial
  // cancellation inside the 24h window would re-send the whole alert.
  const cancelled = {
    ...alertReservation('a-room', 'three-villas', 'large'),
    cancelled_at: '2026-08-31T11:30:00Z',
  };
  const reservations = [
    alertReservation('c-room', 'three-villas', 'small'),
    alertReservation('b-room', 'three-villas', 'hotel'),
    cancelled,
  ];
  const client = fakeClient({ reservations, notification_events: [] });
  let dedupId = '';

  await sweepGuestFlagAlerts(
    client,
    {
      recipient: 'owner@ecovila.md',
      siteUrl: 'https://ecovila.md',
      now: new Date('2026-08-31T12:00:00Z'),
    },
    {
      fetchMarkers: () => Promise.resolve([ATTENTION_MARKER]),
      fetchNotes: () => Promise.resolve([guestNote('active-note', '2026-08-30T10:00:00Z')]),
      fetchPrevious: () => Promise.resolve([]),
      dispatch(_client, reservationId) {
        dedupId = reservationId;
        return Promise.resolve({ sent: true });
      },
    },
  );

  assertEquals(dedupId, 'a-room');
});

Deno.test('the alert names its severity and keeps the flagging note visible', () => {
  // Five newer routine notes must not push the older attention note — the reason
  // the alert fired at all — out of the five the email shows.
  const notes: GuestNote[] = [
    { ...guestNote('old-attention', '2026-01-01T10:00:00Z', 'THE_REASON_THIS_FIRED') },
    ...['i1', 'i2', 'i3', 'i4', 'i5'].map((id, index) => ({
      ...guestNote(id, `2026-08-2${index}T10:00:00Z`, `Routine ${id}`),
      severity: 'info' as const,
    })),
  ];

  const email = buildGuestFlagAlertEmail({
    fullName: 'Ion Popescu',
    phone: '+37369000000',
    email: 'guest@example.md',
    notes,
    groupReservations: [alertReservation('new-a', 'new-group', 'small')],
    previousStays: [],
    siteUrl: 'https://ecovila.md',
  });

  assertStringIncludes(email.subject, 'Atenție');
  assertStringIncludes(email.subject, 'Ion Popescu');
  assertStringIncludes(email.html, 'THE_REASON_THIS_FIRED');
});

Deno.test('sweeper sends nothing when the marker view exposes only non-info notes', async () => {
  let reservationReads = 0;
  let dispatches = 0;
  const client: SupabaseClient = {
    from(table) {
      if (table === 'reservations') reservationReads += 1;
      return fakeQuery([]);
    },
  };

  const summary = await sweepGuestFlagAlerts(
    client,
    { recipient: 'owner@ecovila.md', siteUrl: 'https://ecovila.md' },
    {
      // An info-only dossier yields zero rows from guest_flag_markers.
      fetchMarkers: () => Promise.resolve([]),
      dispatch() {
        dispatches += 1;
        return Promise.resolve({ sent: true });
      },
    },
  );

  assertEquals(summary, { scanned: 0, matched: 0, sent: 0, skipped: 0 });
  assertEquals(reservationReads, 0);
  assertEquals(dispatches, 0);
});

function previousRow(
  id: string,
  bookingGroupId: string,
  checkIn: string,
  roomType: string,
  adults = 2,
  kidsAges: number[] = [],
) {
  return {
    id,
    booking_group_id: bookingGroupId,
    guest_phone: '+37369000000',
    guest_email: 'guest@example.md',
    check_in: checkIn,
    check_out: addDays(checkIn, 2),
    adults,
    kids_ages: kidsAges,
    payment_status: 'paid',
    rooms: { type: roomType },
  };
}

function alertReservation(
  id: string,
  bookingGroupId: string,
  roomType: string,
  adults = 2,
  kidsAges: number[] = [],
): GuestFlagReservationRow {
  return {
    id,
    booking_group_id: bookingGroupId,
    guest_first_name: 'Ion',
    guest_last_name: 'Popescu',
    guest_phone: '+37369000000',
    guest_email: 'guest@example.md',
    check_in: '2026-09-20',
    check_out: '2026-09-23',
    adults,
    kids_ages: kidsAges,
    total_price: roomType === 'small' ? 2500 : 5000,
    payment_type: 'card',
    payment_status: 'paid',
    created_at: '2026-08-31T11:00:00Z',
    cancelled_at: null,
    rooms: { type: roomType },
  } as GuestFlagReservationRow;
}

function guestNote(id: string, createdAt: string, body = 'Active note'): GuestNote {
  return {
    id,
    guest_phone: '+37369000000',
    guest_email: 'guest@example.md',
    severity: 'attention',
    body,
    source_reservation_id: null,
    created_by: 'staff-user',
    created_by_role: 'diana',
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null,
    archived_by: null,
  };
}

function fakeClient(rowsByTable: Record<string, unknown[]>): SupabaseClient {
  return {
    from(table) {
      return fakeQuery(rowsByTable[table] || []);
    },
  };
}

// The fake honours eq/is/gte/in/ilike rather than swallowing them. A no-op fake
// hid real defects: a `failed` notification_event looked identical to a delivered
// one, so the storm guard appeared to work while it was actually muting retries.
function fakeQuery(data: unknown[]) {
  let rows = data as Array<Record<string, unknown>>;
  const builder = {
    select() {
      return builder;
    },
    eq(column: string, value: unknown) {
      rows = rows.filter((row) => row[column] === value);
      return builder;
    },
    ilike(column: string, pattern: string) {
      const wanted = String(pattern).replace(/\\(.)/g, '$1').toLowerCase();
      rows = rows.filter((row) => String(row[column] ?? '').toLowerCase() === wanted);
      return builder;
    },
    is(column: string, value: unknown) {
      rows = rows.filter((row) => (row[column] ?? null) === value);
      return builder;
    },
    gte(column: string, value: unknown) {
      rows = rows.filter((row) => String(row[column] ?? '') >= String(value));
      return builder;
    },
    in(column: string, values: unknown[]) {
      rows = rows.filter((row) => values.includes(row[column]));
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    then(
      resolve: (value: { data: unknown[]; error: null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
