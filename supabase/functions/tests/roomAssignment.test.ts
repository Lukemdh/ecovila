import { assertEquals } from 'std/assert';
import {
  assignAutomaticRooms,
  freeWindowDays,
  orderRoomsByTightestWindow,
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
): SupabaseClient {
  const resolveWith = <T>(data: T) => {
    const chain = {
      select: () => chain,
      is: () => chain,
      in: () => chain,
      gt: () => chain,
      lt: () => chain,
      then: (resolve: (value: { data: T; error: null }) => unknown) =>
        resolve({ data, error: null }),
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
