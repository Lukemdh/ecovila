import { assertEquals, assertInstanceOf } from 'std/assert';
import { errorResponse, HttpError } from '../_shared/http.ts';
import { RateLimitError } from '../_shared/rateLimit.ts';
import { failureReason } from '../create-reservation/index.ts';
import { createReservationsWithTokens, type ReservationInput } from '../_shared/reservations.ts';
import {
  assignAutomaticRooms,
  type AssignmentReservation,
  type AssignmentRoom,
  findRoomAvailabilityConflict,
  type RoomUnavailableDetail,
} from '../_shared/roomAssignment.ts';
import type { SupabaseClient, SupabaseQueryError } from '../_shared/supabaseAdmin.ts';

const ROOMS: AssignmentRoom[] = [
  { id: 'room-3', number: 3, type: 'small', is_active: true },
  { id: 'room-5', number: 5, type: 'small', is_active: true },
  { id: 'room-7', number: 7, type: 'small', is_active: true },
];

function reservationInput(roomId = 'room-5', explicitlySelected = true): ReservationInput {
  return {
    id: '00000000-0000-4000-8000-000000000005',
    room_id: roomId,
    guest_first_name: 'Ana',
    guest_last_name: 'Munteanu',
    guest_phone: '+37360123456',
    guest_email: 'ana@example.md',
    guest_language: 'ro',
    check_in: '2026-10-10',
    check_out: '2026-10-12',
    adults: 2,
    kids_ages: [],
    total_price: 5200,
    payment_type: 'cash',
    room_explicitly_selected: explicitlySelected,
  };
}

function activeBooking(roomId: string): AssignmentReservation {
  return {
    room_id: roomId,
    check_in: '2026-10-10',
    check_out: '2026-10-12',
    payment_status: 'paid',
    cancelled_at: null,
  };
}

function resolvedQuery<T>(data: T) {
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
      return chain;
    },
    then: (resolve: (value: { data: T; error: null }) => unknown) => {
      const sliced = Array.isArray(data) ? data.slice(rangeStart, rangeEnd + 1) : data;
      return resolve({ data: sliced as T, error: null });
    },
  };
  return chain;
}

function fakeBookingClient(options: {
  reservationSnapshots?: AssignmentReservation[][];
  insertError?: SupabaseQueryError;
}) {
  let reservationRead = 0;
  let reservationInsertCount = 0;

  const client = {
    from(table: string) {
      if (table === 'rooms') {
        return resolvedQuery(ROOMS);
      }
      if (table !== 'reservations') {
        throw new Error(`Unexpected table ${table}`);
      }

      const snapshots = options.reservationSnapshots || [[]];
      const snapshot = snapshots[Math.min(reservationRead, snapshots.length - 1)];
      const query = resolvedQuery(snapshot);
      reservationRead += 1;
      return {
        ...query,
        insert() {
          reservationInsertCount += 1;
          return {
            select: () =>
              Promise.resolve({
                data: null,
                error: options.insertError || null,
              }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return {
    client,
    reservationInsertCount: () => reservationInsertCount,
  };
}

Deno.test('23P01 insert race maps to 409 with the complete availability contract', async () => {
  const store = fakeBookingClient({
    reservationSnapshots: [[], [activeBooking('room-5')]],
    insertError: { code: '23P01', message: 'reservations_no_room_overlap' },
  });
  let thrown: unknown;

  try {
    await createReservationsWithTokens(store.client, [reservationInput()], {
      now: new Date('2026-09-03T09:00:00.000Z'),
      beforeInsert: async (rows) => {
        const conflict = await findRoomAvailabilityConflict(store.client, rows);
        if (conflict) throw conflict;
      },
      onRoomConflict: async (rows) => {
        const conflict = await findRoomAvailabilityConflict(store.client, rows, {
          forceConflict: true,
        });
        if (!conflict) throw new Error('Expected the race backstop to find a conflict.');
        return conflict;
      },
    });
  } catch (error) {
    thrown = error;
  }

  assertInstanceOf(thrown, HttpError);
  assertEquals(thrown.status, 409);
  assertEquals((thrown as HttpError & { sqlstate?: string }).sqlstate, '23P01');
  assertEquals(await errorResponse(thrown).json(), {
    error:
      'Vila selectată tocmai a fost ocupată pentru datele selectate. Alege una dintre vilele disponibile.',
    code: 'rooms_unavailable',
    roomType: 'small',
    explicitPick: true,
    takenRoomNumbers: [5],
    freeRoomNumbers: [3, 7],
    soldOut: false,
  });
});

Deno.test('preflight rejects a taken explicit pick and lists free same-type rooms', async () => {
  const store = fakeBookingClient({
    reservationSnapshots: [[activeBooking('room-5')]],
  });
  let thrown: unknown;

  try {
    await createReservationsWithTokens(store.client, [reservationInput()], {
      now: new Date('2026-09-03T09:00:00.000Z'),
      beforeInsert: async (rows) => {
        const conflict = await findRoomAvailabilityConflict(store.client, rows);
        if (conflict) throw conflict;
      },
    });
  } catch (error) {
    thrown = error;
  }

  assertInstanceOf(thrown, HttpError);
  assertEquals(thrown.detail, {
    code: 'rooms_unavailable',
    roomType: 'small',
    explicitPick: true,
    takenRoomNumbers: [5],
    freeRoomNumbers: [3, 7],
    soldOut: false,
  });
  assertEquals(store.reservationInsertCount(), 0);
});

Deno.test('availability conflict reports soldOut when every room of the type is gone', async () => {
  const store = fakeBookingClient({
    reservationSnapshots: [[
      activeBooking('room-3'),
      activeBooking('room-5'),
      activeBooking('room-7'),
    ]],
  });

  const conflict = await findRoomAvailabilityConflict(store.client, [
    {
      room_id: 'room-5',
      check_in: '2026-10-10',
      check_out: '2026-10-12',
      room_explicitly_selected: true,
    },
  ]);

  assertInstanceOf(conflict, HttpError);
  assertEquals(conflict.detail, {
    code: 'rooms_unavailable',
    roomType: 'small',
    explicitPick: true,
    takenRoomNumbers: [5],
    freeRoomNumbers: [],
    soldOut: true,
  });
});

Deno.test('an explicit room pick is never silently reassigned before conflict rejection', async () => {
  const store = fakeBookingClient({
    reservationSnapshots: [[activeBooking('room-5')]],
  });
  const rows = [{
    room_id: 'room-5',
    check_in: '2026-10-10',
    check_out: '2026-10-12',
    room_explicitly_selected: true,
  }];

  const assigned = await assignAutomaticRooms(store.client, rows);
  const conflict = await findRoomAvailabilityConflict(store.client, assigned);

  assertEquals(assigned[0].room_id, 'room-5');
  assertInstanceOf(conflict, HttpError);
  assertEquals(conflict.detail?.takenRoomNumbers, [5]);
});

Deno.test('22P02 reservation insert failure maps to 400 instead of 500', async () => {
  const store = fakeBookingClient({
    insertError: { code: '22P02', message: 'invalid input syntax for type uuid' },
  });
  let thrown: unknown;

  try {
    await createReservationsWithTokens(store.client, [reservationInput()], {
      now: new Date('2026-09-03T09:00:00.000Z'),
    });
  } catch (error) {
    thrown = error;
  }

  assertInstanceOf(thrown, HttpError);
  assertEquals(thrown.status, 400);
  assertEquals((thrown as HttpError & { sqlstate?: string }).sqlstate, '22P02');
  assertEquals(await errorResponse(thrown).json(), {
    error: 'ID-ul rezervării trimis nu este valid.',
  });
});

Deno.test('429 RateLimitError maps to reason rate_limited (not invalid_request)', () => {
  const rateLimitError = new RateLimitError();
  assertEquals(rateLimitError.status, 429);
  assertEquals(failureReason(rateLimitError), 'rate_limited');

  // A 429 HttpError from any source also maps to rate_limited
  const generic429 = new HttpError(429, 'Too many requests');
  assertEquals(failureReason(generic429), 'rate_limited');

  // Generic < 500 status still maps to invalid_request
  const invalidRequest = new HttpError(400, 'Bad request');
  assertEquals(failureReason(invalidRequest), 'invalid_request');
});

Deno.test('failureReason return values and migration CHECK allowlist are in exact lockstep', async () => {
  const migrationUrl = new URL(
    '../../migrations/20260903120000_booking_conflict_visibility.sql',
    import.meta.url,
  );
  const sql = await Deno.readTextFile(migrationUrl);
  const checkMatch = sql.match(/reason\s+in\s*\(([^)]+)\)/i);
  if (!checkMatch) throw new Error('Could not find reason CHECK constraint in migration');
  const allowedInCheck = checkMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .sort();

  const observedReasons = [
    failureReason(new HttpError(409, 'Conflict', { code: 'rooms_unavailable' })),
    failureReason(new RateLimitError()),
    failureReason(new HttpError(429, 'Too many requests')),
    failureReason(new HttpError(400, 'Bad request')),
    failureReason(new Error('Internal server error')),
    failureReason(new HttpError(500, 'Server error')),
  ];
  const uniqueObserved = [...new Set(observedReasons)].sort();

  assertEquals(
    uniqueObserved,
    allowedInCheck,
    "The set of strings failureReason() can return must EXACTLY match the migration's CHECK allowlist",
  );
});

Deno.test('forceConflict on a two-villa booking never lists any room of that booking as free', async () => {
  const store = fakeBookingClient({
    reservationSnapshots: [[]],
  });

  const conflict = await findRoomAvailabilityConflict(
    store.client,
    [
      {
        room_id: 'room-3',
        check_in: '2026-10-10',
        check_out: '2026-10-12',
        room_explicitly_selected: true,
      },
      {
        room_id: 'room-5',
        check_in: '2026-10-10',
        check_out: '2026-10-12',
        room_explicitly_selected: true,
      },
    ],
    { forceConflict: true },
  );

  assertInstanceOf(conflict, HttpError);
  assertEquals(conflict.status, 409);
  const detail = conflict.detail as RoomUnavailableDetail;
  assertEquals(detail?.code, 'rooms_unavailable');
  assertEquals(detail?.freeRoomNumbers, [7]);
  assertEquals(detail?.freeRoomNumbers.includes(3), false);
  assertEquals(detail?.freeRoomNumbers.includes(5), false);
  assertEquals(detail?.soldOut, false);
});
