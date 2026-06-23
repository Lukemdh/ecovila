import { assertEquals } from 'std/assert';
import { aggregateCheckoutStatus, selectReviewRequestGroups } from '../_shared/reviewRequests.ts';

type Row = { id: string; booking_group_id?: string | null };

Deno.test("aggregateCheckoutStatus ORs signals across a reservation's daily rows", () => {
  const status = aggregateCheckoutStatus([
    // Check-in day row (no checkout yet) then the checkout day row.
    { reservation_id: 'a', checked_out_at: null, checkout_note: null },
    { reservation_id: 'a', checked_out_at: '2026-07-01T08:00:00Z', checkout_note: null },
    // Whitespace-only notes do not count as a real note.
    { reservation_id: 'b', checked_out_at: '2026-07-01T09:00:00Z', checkout_note: '   ' },
    // A real note.
    {
      reservation_id: 'c',
      checked_out_at: '2026-07-01T09:30:00Z',
      checkout_note: 'scratch on the door',
    },
  ]);

  assertEquals(status.get('a'), { departed: true, hasNote: false });
  assertEquals(status.get('b'), { departed: true, hasNote: false });
  assertEquals(status.get('c'), { departed: true, hasNote: true });
});

Deno.test('selectReviewRequestGroups picks departed bookings with no checkout note', () => {
  const reservations: Row[] = [
    { id: 'departed-clean', booking_group_id: null },
    { id: 'departed-noted', booking_group_id: null },
    { id: 'no-show', booking_group_id: null },
  ];
  const statusByReservation = new Map([
    ['departed-clean', { departed: true, hasNote: false }],
    ['departed-noted', { departed: true, hasNote: true }],
    // 'no-show' has no daily-status row at all → absent from the map.
  ]);

  const selected = selectReviewRequestGroups({ reservations, statusByReservation });

  assertEquals(selected.map((entry) => entry.owner.id), ['departed-clean']);
});

Deno.test('selectReviewRequestGroups sends one email per booking group via the owner', () => {
  // Two villas in one booking group: only the lower id "owns" the email, and a note
  // on either room suppresses the whole booking.
  const cleanGroup: Row[] = [
    { id: 'b-room', booking_group_id: 'grp-clean' },
    { id: 'a-room', booking_group_id: 'grp-clean' },
  ];
  const cleanStatus = new Map([
    ['a-room', { departed: true, hasNote: false }],
    ['b-room', { departed: false, hasNote: false }],
  ]);

  const cleanSelected = selectReviewRequestGroups({
    reservations: cleanGroup,
    statusByReservation: cleanStatus,
  });
  assertEquals(cleanSelected.length, 1);
  assertEquals(cleanSelected[0].owner.id, 'a-room');
  assertEquals(cleanSelected[0].group.length, 2);

  const notedGroup: Row[] = [
    { id: 'a-room', booking_group_id: 'grp-noted' },
    { id: 'b-room', booking_group_id: 'grp-noted' },
  ];
  const notedStatus = new Map([
    ['a-room', { departed: true, hasNote: false }],
    ['b-room', { departed: true, hasNote: true }],
  ]);

  const notedSelected = selectReviewRequestGroups({
    reservations: notedGroup,
    statusByReservation: notedStatus,
  });
  assertEquals(notedSelected.length, 0);
});
