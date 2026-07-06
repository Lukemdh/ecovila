import { assertEquals } from 'std/assert';
import { planReschedule } from '../_shared/reservationReschedule.ts';
import type { RescheduleGroupRow } from '../_shared/reservationReschedule.ts';
import type { AssignmentReservation, AssignmentRoom } from '../_shared/roomAssignment.ts';
import { reservationRescheduleSms } from '../_shared/notifications.ts';

function room(id: string, number: number, type = 'large'): AssignmentRoom {
  return { id, number, type };
}

function booking(roomId: string, checkIn: string, checkOut: string): AssignmentReservation {
  return { room_id: roomId, check_in: checkIn, check_out: checkOut, payment_status: 'paid' };
}

function row(id: string, roomId: string, type = 'large'): RescheduleGroupRow {
  return { id, room_id: roomId, room_type: type };
}

// Seven large villas (9–15), matching production, used across the planning tests.
const LARGE_ROOMS: AssignmentRoom[] = [9, 10, 11, 12, 13, 14, 15].map((n) => room(`r${n}`, n));

Deno.test('reschedule keeps the current villa when it is still free for the new dates', () => {
  const plan = planReschedule({
    rooms: LARGE_ROOMS,
    reservations: [], // group's own row is excluded by the caller
    groupRows: [row('res1', 'r12')],
    checkIn: '2026-07-13',
    checkOut: '2026-07-15',
  });

  assertEquals(plan.ok, true);
  if (plan.ok) {
    assertEquals(plan.assignments, [{ id: 'res1', room_id: 'r12' }]);
  }
});

Deno.test('reschedule relocates to a free same-type villa when the current one is taken', () => {
  // Every large villa except #14 is occupied across 13–15 Jul; #12 (current) is
  // taken, so the booking must move to #14.
  const reservations = [9, 10, 11, 12, 13, 15].map((n) =>
    booking(`r${n}`, '2026-07-12', '2026-07-16')
  );

  const plan = planReschedule({
    rooms: LARGE_ROOMS,
    reservations,
    groupRows: [row('res1', 'r12')],
    checkIn: '2026-07-13',
    checkOut: '2026-07-15',
  });

  assertEquals(plan.ok, true);
  if (plan.ok) {
    assertEquals(plan.assignments, [{ id: 'res1', room_id: 'r14' }]);
  }
});

Deno.test('reschedule fails when no villa of the same type is free', () => {
  const reservations = [9, 10, 11, 12, 13, 14, 15].map((n) =>
    booking(`r${n}`, '2026-07-12', '2026-07-16')
  );

  const plan = planReschedule({
    rooms: LARGE_ROOMS,
    reservations,
    groupRows: [row('res1', 'r12')],
    checkIn: '2026-07-13',
    checkOut: '2026-07-15',
  });

  assertEquals(plan.ok, false);
  if (!plan.ok) {
    assertEquals(plan.unavailableType, 'large');
  }
});

Deno.test('multi-villa group keeps both villas and never double-assigns', () => {
  const plan = planReschedule({
    rooms: LARGE_ROOMS,
    reservations: [],
    groupRows: [row('resA', 'r12'), row('resB', 'r13')],
    checkIn: '2026-07-13',
    checkOut: '2026-07-15',
  });

  assertEquals(plan.ok, true);
  if (plan.ok) {
    assertEquals(plan.assignments, [
      { id: 'resA', room_id: 'r12' },
      { id: 'resB', room_id: 'r13' },
    ]);
    const rooms = plan.assignments.map((a) => a.room_id);
    assertEquals(new Set(rooms).size, rooms.length);
  }
});

Deno.test('reschedule SMS stays within one segment for every language and month', () => {
  // RO/EN are GSM-7 (<=160); RU is Cyrillic UCS-2 (<=140). Walk every month with a
  // two-digit day so the longest localized month name is exercised.
  const limits: Record<string, number> = { ro: 160, ru: 140, en: 160 };

  for (let month = 1; month <= 12; month += 1) {
    const mm = String(month).padStart(2, '0');
    const checkIn = `2026-${mm}-28`;
    const checkOut = `2026-${mm}-30`;

    for (const language of ['ro', 'ru', 'en']) {
      const message = reservationRescheduleSms({ language, checkIn, checkOut });
      if (message.length > limits[language]) {
        throw new Error(
          `${language} reschedule SMS is ${message.length} chars (month ${mm}), over ${
            limits[language]
          }: ${message}`,
        );
      }
      if (!message.includes('EcoVila')) {
        throw new Error(`${language} reschedule SMS missing brand: ${message}`);
      }
    }
  }
});

Deno.test('reschedule SMS falls back to Romanian for an unknown language', () => {
  const message = reservationRescheduleSms({
    language: 'fr',
    checkIn: '2026-07-13',
    checkOut: '2026-07-15',
  });
  assertEquals(message.startsWith('Rezervarea dvs a fost mutata'), true);
});
