// Anti-fragmentation room auto-assignment (ADR-054).
//
// When a guest books a villa *type* without picking a specific unit
// (`room_explicitly_selected === false`), the server assigns the available room
// whose surrounding free window — the gap before the stay, the stay itself, and
// the gap after — is the TIGHTEST. Filling the most-constrained room first keeps
// longer contiguous gaps open on the other rooms, so a later guest who wants a
// multi-night stay still has somewhere to go.
//
// Example (small villas, booking 11–12 Jul): #3 is free 10–13 Jul (window 3
// nights) and #7 is free only 11–12 Jul (window 1 night). The old "lowest/
// highest number" assignment would take #3 and destroy the 3-night gap; this
// picks #7, leaving #3's 10–13 window intact.
//
// `orderRoomsByTightestWindow` and `freeWindowDays` are pure and unit-tested;
// `assignAutomaticRooms` is the thin orchestration used by `create-reservation`.

import './pricing.js';
import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// How far before/after the stay we look for a neighbouring booking when sizing a
// room's free window. A room with no booking within this many days on a side is
// treated as "open" on that side, so fully-free rooms sort last (largest window)
// and stay available for long stays. Also bounds the reservations query.
export const FREE_WINDOW_CAP_DAYS = 60;

export type AssignmentRoom = {
  id: string;
  number: number;
  type: string;
  is_active?: boolean | null;
};

export type AssignmentReservation = {
  room_id?: string | null;
  check_in?: string | null;
  check_out?: string | null;
  payment_status?: string | null;
  cancelled_at?: string | null;
};

type AssignableRow = {
  room_id: string;
  check_in: string;
  check_out: string;
  room_explicitly_selected: boolean;
};

function toEpochDay(value: string): number {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  return Math.round(Date.parse(`${value}T00:00:00.000Z`) / DAY_MS);
}

function addDaysISO(value: string, days: number): string {
  return new Date((toEpochDay(value) + days) * DAY_MS).toISOString().slice(0, 10);
}

// A reservation still holds its room while pending or paid and not cancelled.
// Mirrors `isActiveReservation` in js/calendar.js so server and browser agree.
function isActiveReservation(reservation: AssignmentReservation): boolean {
  if (reservation.cancelled_at) {
    return false;
  }
  const status = reservation.payment_status;
  return !status || status === 'pending' || status === 'paid';
}

// [aStart, aEnd) overlaps [bStart, bEnd) — half-open, matching the DB exclusion
// constraint's `daterange(check_in, check_out, '[)')`.
function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Size (in days) of the contiguous free window on `roomId` that contains
 * [checkIn, checkOut). The window starts at the latest active check-out that is
 * on/before check-in (or `checkIn - cap` if none) and ends at the earliest
 * active check-in that is on/after check-out (or `checkOut + cap` if none).
 * Smaller = tighter fit. Assumes the room is already free for the stay.
 */
export function freeWindowDays(input: {
  reservations: AssignmentReservation[];
  roomId: string;
  checkInDay: number;
  checkOutDay: number;
  windowCapDays?: number;
}): number {
  const cap = input.windowCapDays ?? FREE_WINDOW_CAP_DAYS;
  let windowStart = input.checkInDay - cap;
  let windowEnd = input.checkOutDay + cap;

  for (const reservation of input.reservations) {
    if (reservation.room_id !== input.roomId || !isActiveReservation(reservation)) {
      continue;
    }
    if (!reservation.check_in || !reservation.check_out) {
      continue;
    }
    const start = toEpochDay(reservation.check_in);
    const end = toEpochDay(reservation.check_out);

    if (end <= input.checkInDay) {
      // Booking entirely before the stay: its check-out bounds the window start.
      if (end > windowStart) {
        windowStart = end;
      }
    } else if (start >= input.checkOutDay) {
      // Booking entirely after the stay: its check-in bounds the window end.
      if (start < windowEnd) {
        windowEnd = start;
      }
    }
    // Overlapping bookings cannot occur for a room that is free for the stay.
  }

  return windowEnd - windowStart;
}

/**
 * Rooms of `type` that are free for [checkIn, checkOut) (excluding `excludeRoomIds`),
 * ordered tightest free-window first. Ties fall back to the configured room-number
 * direction so behaviour is deterministic and unchanged when no fragmentation
 * pressure exists (e.g. many fully-open rooms).
 */
export function orderRoomsByTightestWindow(input: {
  rooms: AssignmentRoom[];
  reservations: AssignmentReservation[];
  type: string;
  checkIn: string;
  checkOut: string;
  excludeRoomIds?: Set<string>;
  windowCapDays?: number;
  assignmentDirection?: 'ascending' | 'descending';
}): AssignmentRoom[] {
  const checkInDay = toEpochDay(input.checkIn);
  const checkOutDay = toEpochDay(input.checkOut);
  if (checkOutDay <= checkInDay) {
    throw new Error('Check-out must be after check-in.');
  }

  const exclude = input.excludeRoomIds ?? new Set<string>();
  const descending = input.assignmentDirection === 'descending';

  const candidates = input.rooms.filter((room) => {
    if (room.is_active === false || room.type !== input.type || exclude.has(room.id)) {
      return false;
    }
    return !input.reservations.some((reservation) => {
      if (reservation.room_id !== room.id || !isActiveReservation(reservation)) {
        return false;
      }
      if (!reservation.check_in || !reservation.check_out) {
        return false;
      }
      return rangesOverlap(
        toEpochDay(reservation.check_in),
        toEpochDay(reservation.check_out),
        checkInDay,
        checkOutDay,
      );
    });
  });

  return candidates
    .map((room) => ({
      room,
      window: freeWindowDays({
        reservations: input.reservations,
        roomId: room.id,
        checkInDay,
        checkOutDay,
        windowCapDays: input.windowCapDays,
      }),
    }))
    .sort((left, right) => {
      if (left.window !== right.window) {
        return left.window - right.window;
      }
      return descending
        ? Number(right.room.number) - Number(left.room.number)
        : Number(left.room.number) - Number(right.room.number);
    })
    .map((entry) => entry.room);
}

type QueryBuilder<T> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, values: unknown[]): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
  lt(column: string, value: unknown): QueryBuilder<T>;
};

function table<T>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}

function assignmentDirectionFor(type: string): 'ascending' | 'descending' {
  const pricing = (globalThis as {
    EcoVilaPricing?: { ROOM_TYPES?: Record<string, { assignmentDirection?: string }> };
  }).EcoVilaPricing;
  return pricing?.ROOM_TYPES?.[type]?.assignmentDirection === 'descending'
    ? 'descending'
    : 'ascending';
}

async function loadActiveRooms(client: SupabaseClient): Promise<AssignmentRoom[]> {
  const { data, error } = await table<AssignmentRoom[]>(client, 'rooms')
    .select('id, number, type, is_active');
  if (error) {
    throw new Error(error.message || 'Could not load rooms for assignment.');
  }
  return (data || []).filter((room) => room.is_active !== false);
}

async function loadActiveReservations(
  client: SupabaseClient,
  minDate: string,
  maxDate: string,
): Promise<AssignmentReservation[]> {
  const { data, error } = await table<AssignmentReservation[]>(client, 'reservations')
    .select('room_id, check_in, check_out, payment_status, cancelled_at')
    .is('cancelled_at', null)
    .in('payment_status', ['pending', 'paid'])
    .gt('check_out', minDate)
    .lt('check_in', maxDate);
  if (error) {
    throw new Error(error.message || 'Could not load reservations for assignment.');
  }
  return data || [];
}

/**
 * Reassign the `room_id` of every auto-assigned row (those with
 * `room_explicitly_selected === false`) to the tightest-window room of the same
 * type. Explicit picks are left untouched. Rooms already used in this booking
 * (explicit picks + earlier auto picks) are excluded so a multi-villa booking
 * never lands two rows on the same room. If no candidate is found for a row, its
 * client-supplied `room_id` is kept — the move is never worse than before, and
 * the DB exclusion constraint remains the final backstop.
 */
export async function assignAutomaticRooms<T extends AssignableRow>(
  client: SupabaseClient,
  rows: T[],
): Promise<T[]> {
  const autoRows = rows.filter((row) => !row.room_explicitly_selected);
  if (autoRows.length === 0) {
    return rows;
  }

  const rooms = await loadActiveRooms(client);
  const roomsById = new Map(rooms.map((room) => [room.id, room]));

  const dates = autoRows.flatMap((row) => [row.check_in, row.check_out]).sort();
  const minDate = addDaysISO(dates[0], -FREE_WINDOW_CAP_DAYS - 1);
  const maxDate = addDaysISO(dates[dates.length - 1], FREE_WINDOW_CAP_DAYS + 1);
  const reservations = await loadActiveReservations(client, minDate, maxDate);

  // Seed with rooms held by explicit picks in the same booking.
  const usedRoomIds = new Set<string>(
    rows
      .filter((row) => row.room_explicitly_selected && row.room_id)
      .map((row) => row.room_id),
  );

  for (const row of autoRows) {
    const type = roomsById.get(row.room_id)?.type;
    if (!type) {
      // Unknown room → leave the client value for the price guard / DB to judge.
      usedRoomIds.add(row.room_id);
      continue;
    }

    const [chosen] = orderRoomsByTightestWindow({
      rooms,
      reservations,
      type,
      checkIn: row.check_in,
      checkOut: row.check_out,
      excludeRoomIds: usedRoomIds,
      assignmentDirection: assignmentDirectionFor(type),
    });

    const roomId = chosen ? chosen.id : row.room_id;
    row.room_id = roomId;
    usedRoomIds.add(roomId);
  }

  return rows;
}
