// Pure planning for a staff "move to new dates" (reschedule) of a booking group.
//
// Reuses the same availability + anti-fragmentation ordering as new-booking room
// auto-assignment (ADR-054) so the calendar stays consistent: a moved booking
// keeps its current villa when that villa is still free for the new dates, and
// otherwise takes the tightest-window free villa of the SAME type. If no villa of
// the type is free, the move is rejected wholesale (the caller writes nothing and
// returns a 409). `planReschedule` is pure and unit-tested.

import './pricing.js';
import { orderRoomsByTightestWindow } from './roomAssignment.ts';
import type { AssignmentReservation, AssignmentRoom } from './roomAssignment.ts';

export type RescheduleGroupRow = {
  id: string;
  room_id: string;
  room_type: string;
};

export type ReschedulePlan =
  | { ok: true; assignments: Array<{ id: string; room_id: string }> }
  | { ok: false; unavailableType: string };

function assignmentDirectionFor(type: string): 'ascending' | 'descending' {
  const pricing = (globalThis as {
    EcoVilaPricing?: { ROOM_TYPES?: Record<string, { assignmentDirection?: string }> };
  }).EcoVilaPricing;
  return pricing?.ROOM_TYPES?.[type]?.assignmentDirection === 'descending'
    ? 'descending'
    : 'ascending';
}

/**
 * Decide which room each row of a booking group should occupy after a date move.
 *
 * `reservations` MUST exclude the group's own rows, otherwise the booking blocks
 * itself. Each row prefers to keep its current room when that room is free for the
 * new dates; otherwise it takes the tightest-window free room of the same type.
 * Rooms chosen earlier in the group are excluded so two rows never land on the
 * same villa. If any row has no free same-type villa, returns `{ ok: false }`
 * naming that type so the caller can reject the whole move.
 */
export function planReschedule(input: {
  rooms: AssignmentRoom[];
  reservations: AssignmentReservation[];
  groupRows: RescheduleGroupRow[];
  checkIn: string;
  checkOut: string;
}): ReschedulePlan {
  const usedRoomIds = new Set<string>();
  const assignments: Array<{ id: string; room_id: string }> = [];

  for (const row of input.groupRows) {
    const candidates = orderRoomsByTightestWindow({
      rooms: input.rooms,
      reservations: input.reservations,
      type: row.room_type,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      excludeRoomIds: usedRoomIds,
      assignmentDirection: assignmentDirectionFor(row.room_type),
    });

    if (candidates.length === 0) {
      return { ok: false, unavailableType: row.room_type };
    }

    // Minimise disruption: keep the current villa when it is still free for the
    // new dates; only relocate when something else now holds it.
    const keepsCurrent = candidates.some((room) => room.id === row.room_id);
    const chosen = keepsCurrent ? row.room_id : candidates[0].id;

    usedRoomIds.add(chosen);
    assignments.push({ id: row.id, room_id: chosen });
  }

  return { ok: true, assignments };
}
