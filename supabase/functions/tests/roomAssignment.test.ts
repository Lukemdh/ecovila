import { assertEquals } from 'std/assert';
import {
  assignAutomaticRooms,
  freeWindowDays,
  loadActiveReservations,
  orderRoomsByTightestWindow,
  RESERVATION_PAGE_SIZE,
} from '../_shared/roomAssignment.ts';
import type { AssignmentReservation, AssignmentRoom } from '../_shared/roomAssignment.ts';
import type { SupabaseClient } from '../_shared/supabaseAdmin.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const epochDay = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00.000Z`) / DAY_MS);

function room(id: string, number: number, type = 'small'): AssignmentRoom {
  return { id, number, type };
}

function booking(roomId: string, checkIn: string, checkOut: string): AssignmentReservation {
  return { room_id: roomId, check_in: checkIn, check_out: checkOut, payment_status: 'paid' };
}

Deno.test('orderRoomsByTightestWindow picks the room with the smallest free window', () => {
  // #3 is free 10–13 Jul (window 3); #7 is free only 11–12 Jul (window 1).
  const rooms = [room('r3', 3), room('r7', 7)];
  const reservations = [
    booking('r3', '2026-07-08', '2026-07-10'),
    booking('r3', '2026-07-13', '2026-07-15'),
    booking('r7', '2026-07-09', '2026-07-11'),
    booking('r7', '2026-07-12', '2026-07-14'),
  ];

  const ordered = orderRoomsByTightestWindow({
    rooms,
    reservations,
    type: 'small',
    checkIn: '2026-07-11',
    checkOut: '2026-07-12',
    assignmentDirection: 'descending',
  });

  assertEquals(ordered.map((r) => r.number), [7, 3]);
});

Deno.test('orderRoomsByTightestWindow keeps the configured direction when windows tie', () => {
  const rooms = [room('r1', 1), room('r2', 2), room('r3', 3)];

  assertEquals(
    orderRoomsByTightestWindow({
      rooms,
      reservations: [],
      type: 'small',
      checkIn: '2026-07-11',
      checkOut: '2026-07-12',
      assignmentDirection: 'descending',
    }).map((r) => r.number),
    [3, 2, 1],
  );

  assertEquals(
    orderRoomsByTightestWindow({
      rooms,
      reservations: [],
      type: 'small',
      checkIn: '2026-07-11',
      checkOut: '2026-07-12',
      assignmentDirection: 'ascending',
    }).map((r) => r.number),
    [1, 2, 3],
  );
});

Deno.test('orderRoomsByTightestWindow excludes occupied rooms and excludeRoomIds', () => {
  const rooms = [room('r1', 1), room('r2', 2), room('r3', 3)];
  const reservations = [booking('r1', '2026-07-10', '2026-07-13')]; // r1 overlaps the stay

  const ordered = orderRoomsByTightestWindow({
    rooms,
    reservations,
    type: 'small',
    checkIn: '2026-07-11',
    checkOut: '2026-07-12',
    excludeRoomIds: new Set(['r2']),
    assignmentDirection: 'ascending',
  });

  assertEquals(ordered.map((r) => r.id), ['r3']);
});

Deno.test('orderRoomsByTightestWindow lets a tight window beat the number direction', () => {
  // Ascending direction would prefer #2, but #4 is the tighter fit.
  const rooms = [room('r2', 2), room('r4', 4)];
  const reservations = [
    booking('r4', '2026-07-09', '2026-07-11'),
    booking('r4', '2026-07-12', '2026-07-14'),
  ];

  const ordered = orderRoomsByTightestWindow({
    rooms,
    reservations,
    type: 'small',
    checkIn: '2026-07-11',
    checkOut: '2026-07-12',
    assignmentDirection: 'ascending',
  });

  assertEquals(ordered[0].id, 'r4');
});

Deno.test('orderRoomsByTightestWindow ignores rooms of other types', () => {
  const rooms = [room('r9', 9, 'large'), room('r3', 3, 'small')];

  const ordered = orderRoomsByTightestWindow({
    rooms,
    reservations: [],
    type: 'large',
    checkIn: '2026-07-11',
    checkOut: '2026-07-12',
  });

  assertEquals(ordered.map((r) => r.id), ['r9']);
});

Deno.test('freeWindowDays measures adjacent bookings exactly and caps open sides', () => {
  const reservations = [
    booking('rx', '2026-07-09', '2026-07-11'),
    booking('rx', '2026-07-12', '2026-07-14'),
  ];

  assertEquals(
    freeWindowDays({
      reservations,
      roomId: 'rx',
      checkInDay: epochDay('2026-07-11'),
      checkOutDay: epochDay('2026-07-12'),
    }),
    1,
  );

  // No neighbours within the cap: (1 night stay) + 2 * 60-day cap.
  assertEquals(
    freeWindowDays({
      reservations: [],
      roomId: 'rx',
      checkInDay: epochDay('2026-07-11'),
      checkOutDay: epochDay('2026-07-12'),
    }),
    121,
  );
});

function fakeClient(
  rooms: AssignmentRoom[],
  reservations: AssignmentReservation[],
  options: { onRange?: (from: number, to: number) => void } = {},
): SupabaseClient {
  const resolveWith = <T>(data: T) => {
    let rangeStart = 0;
    let rangeEnd = Infinity;
    const chain = {
      select: () => chain,
      is: () => chain,
      in: () => chain,
      gt: () => chain,
      lt: () => chain,
      order: () => chain,
      range: (from: number, to: number) => {
        rangeStart = from;
        rangeEnd = to;
        options.onRange?.(from, to);
        return chain;
      },
      then: (resolve: (value: { data: T; error: null }) => unknown) => {
        const sliced = Array.isArray(data) ? data.slice(rangeStart, rangeEnd + 1) : data;
        return resolve({ data: sliced as T, error: null });
      },
    };
    return chain;
  };

  return {
    from(table: string) {
      return table === 'rooms' ? resolveWith(rooms) : resolveWith(reservations);
    },
  } as unknown as SupabaseClient;
}

Deno.test('assignAutomaticRooms reassigns auto rows and leaves explicit picks untouched', async () => {
  const rooms = [room('r3', 3), room('r7', 7)];
  const reservations = [
    booking('r3', '2026-07-08', '2026-07-10'),
    booking('r3', '2026-07-13', '2026-07-15'),
    booking('r7', '2026-07-09', '2026-07-11'),
    booking('r7', '2026-07-12', '2026-07-14'),
  ];
  const client = fakeClient(rooms, reservations);

  // Client proposed #3 (its old lowest-window-blind pick); server should move it to #7.
  const autoRows = await assignAutomaticRooms(client, [
    {
      room_id: 'r3',
      check_in: '2026-07-11',
      check_out: '2026-07-12',
      room_explicitly_selected: false,
    },
  ]);
  assertEquals(autoRows[0].room_id, 'r7');

  // Explicit picks are never moved.
  const explicitRows = await assignAutomaticRooms(client, [
    {
      room_id: 'r3',
      check_in: '2026-07-11',
      check_out: '2026-07-12',
      room_explicitly_selected: true,
    },
  ]);
  assertEquals(explicitRows[0].room_id, 'r3');
});

Deno.test('assignAutomaticRooms gives a multi-villa booking distinct rooms', async () => {
  const rooms = [room('r1', 1), room('r2', 2), room('r3', 3)];
  const client = fakeClient(rooms, []); // all open → falls back to descending number order

  const rows = await assignAutomaticRooms(client, [
    {
      room_id: 'r1',
      check_in: '2026-07-11',
      check_out: '2026-07-12',
      room_explicitly_selected: false,
    },
    {
      room_id: 'r1',
      check_in: '2026-07-11',
      check_out: '2026-07-12',
      room_explicitly_selected: false,
    },
  ]);

  const assigned = rows.map((row) => row.room_id);
  assertEquals(new Set(assigned).size, 2, 'each villa in the booking gets a distinct room');
});

Deno.test('loadActiveReservations pages through full pages and returns the merged set', async () => {
  const rangeCalls: Array<[number, number]> = [];
  // 1007 rows matches the exact production count where truncation caused dropped bookings.
  const totalReservations = 1007;
  const mockReservations: AssignmentReservation[] = Array.from(
    { length: totalReservations },
    (_, i) => ({
      id: `res-${String(i + 1).padStart(5, '0')}`,
      room_id: `room-${(i % 5) + 1}`,
      check_in: '2026-08-01',
      check_out: '2026-08-03',
      payment_status: 'paid',
      cancelled_at: null,
    }),
  );

  const client = fakeClient([], mockReservations, {
    onRange: (from, to) => rangeCalls.push([from, to]),
  });

  const rows = await loadActiveReservations(client, '2026-07-01', '2026-11-01');

  assertEquals(rangeCalls, [
    [0, 999],
    [1000, 1999],
  ]);
  assertEquals(rows.length, 1007);
  assertEquals(rows[0].id, 'res-00001');
  assertEquals(rows[1006].id, 'res-01007');
});

Deno.test(
  'assignAutomaticRooms does not pick an occupied room when the blocking reservation only appears on the second page',
  async () => {
    // Hotel rooms #1 and #2. Ascending assignment order prefers #1 when both appear free.
    const rooms = [room('r1', 1, 'hotel'), room('r2', 2, 'hotel')];

    // Page 1 (1000 rows): filler reservations on another room so room #1 looks wide open.
    const fillerReservations: AssignmentReservation[] = Array.from(
      { length: 1000 },
      (_, i) => ({
        id: `res-filler-${String(i + 1).padStart(4, '0')}`,
        room_id: 'r99',
        check_in: '2026-08-01',
        check_out: '2026-08-03',
        payment_status: 'paid',
        cancelled_at: null,
      }),
    );

    // Page 2: the 1001st row (index 1000) blocks room #1 for 26-27 Sep 2026 (the live production incident).
    const blockingReservation: AssignmentReservation = {
      id: 'res-blocking-r1',
      room_id: 'r1',
      check_in: '2026-09-26',
      check_out: '2026-09-27',
      payment_status: 'paid',
      cancelled_at: null,
    };

    // If truncated to page 1, auto-assignment would believe room #1 is free and assign it (bug).
    const truncatedClient = fakeClient(rooms, fillerReservations);
    const brokenAssignment = await assignAutomaticRooms(truncatedClient, [
      {
        room_id: 'r1',
        check_in: '2026-09-26',
        check_out: '2026-09-27',
        room_explicitly_selected: false,
      },
    ]);
    assertEquals(
      brokenAssignment[0].room_id,
      'r1',
      'truncation repro: unpaginated read assigns room #1 because blocking row was dropped',
    );

    // With pagination, page 2 is read, room #1 is recognized as occupied, and room #2 is chosen:
    const allReservations = [...fillerReservations, blockingReservation];
    const paginatedClient = fakeClient(rooms, allReservations);
    const fixedAssignment = await assignAutomaticRooms(paginatedClient, [
      {
        room_id: 'r1',
        check_in: '2026-09-26',
        check_out: '2026-09-27',
        room_explicitly_selected: false,
      },
    ]);
    assertEquals(
      fixedAssignment[0].room_id,
      'r2',
      'pagination fix: reads through page 2, avoids occupied room #1, and assigns free room #2',
    );
  },
);
