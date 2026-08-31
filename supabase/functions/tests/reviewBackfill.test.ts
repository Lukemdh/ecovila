import { assertEquals } from 'std/assert';
import {
  normalizeBackfillEmail,
  selectBackfillRecipients,
} from '../backfill-review-requests/selection.ts';
import type { BackfillRow } from '../backfill-review-requests/selection.ts';
import type { CheckoutStatus } from '../_shared/reviewRequests.ts';

function row(
  id: string,
  bookingGroupId: string | null,
  checkOut: string,
  email: string | null,
  phone = '+37369000001',
): BackfillRow {
  return {
    id,
    booking_group_id: bookingGroupId,
    check_out: checkOut,
    guest_email: email,
    guest_phone: phone,
  };
}

function departed(ids: string[], withNote: string[] = []): Map<string, CheckoutStatus> {
  return new Map(ids.map((id) => [id, { departed: true, hasNote: withNote.includes(id) }]));
}

Deno.test('backfill asks each person once, about their most recent stay', () => {
  // Same guest, three separate bookings in the window. A per-booking send would ask
  // them three times in one week; only the newest stay may produce an email.
  const reservations = [
    row('a', 'g1', '2026-08-10', 'ion@mail.md'),
    row('b', 'g2', '2026-08-25', 'ION@Mail.MD'),
    row('c', 'g3', '2026-08-18', 'ion@mail.md'),
    row('d', 'g4', '2026-08-20', 'maria@mail.md', '+37369000002'),
  ];

  const picked = selectBackfillRecipients({
    reservations,
    statusByReservation: departed(['a', 'b', 'c', 'd']),
  });

  assertEquals(picked.length, 2);
  // Most recent first, so an interrupted run has already sent the freshest asks.
  assertEquals(picked.map((entry) => entry.owner.check_out), ['2026-08-25', '2026-08-20']);
  assertEquals(picked[0].owner.id, 'b');
});

Deno.test('backfill honours the live eligibility rules it is catching up on', () => {
  const reservations = [
    row('note-a', 'g1', '2026-08-20', 'noted@mail.md'),
    row('note-b', 'g1', '2026-08-20', 'noted@mail.md'),
    row('never-left', 'g2', '2026-08-21', 'stayed@mail.md', '+37369000003'),
    row('ok', 'g3', '2026-08-22', 'fine@mail.md', '+37369000004'),
  ];
  const statuses = new Map<string, CheckoutStatus>([
    // A checkout note anywhere in the booking means staff recorded an issue.
    ['note-a', { departed: true, hasNote: false }],
    ['note-b', { departed: true, hasNote: true }],
    // Never marked checked out in situația zilnică — the live flow would skip them too.
    ['never-left', { departed: false, hasNote: false }],
    ['ok', { departed: true, hasNote: false }],
  ]);

  const picked = selectBackfillRecipients({ reservations, statusByReservation: statuses });

  assertEquals(picked.map((entry) => entry.owner.guest_email), ['fine@mail.md']);
});

Deno.test('backfill skips complainers, already-sent guests and missing emails', () => {
  const reservations = [
    row('complained-phone', 'g1', '2026-08-22', 'angry@mail.md', '+37369000009'),
    row('complained-res', 'g2', '2026-08-23', 'upset@mail.md', '+37369000010'),
    row('already', 'g3', '2026-08-24', 'done@mail.md', '+37369000011'),
    row('no-email', 'g4', '2026-08-25', null, '+37369000012'),
    row('keep', 'g5', '2026-08-21', 'keep@mail.md', '+37369000013'),
  ];

  const picked = selectBackfillRecipients({
    reservations,
    statusByReservation: departed([
      'complained-phone',
      'complained-res',
      'already',
      'no-email',
      'keep',
    ]),
    complaintPhones: new Set(['+37369000009']),
    complaintReservationIds: new Set(['complained-res']),
    alreadySentEmails: new Set(['done@mail.md']),
  });

  assertEquals(picked.map((entry) => entry.owner.guest_email), ['keep@mail.md']);
});

Deno.test('a complaint about one stay silences that PERSON, not just that booking', () => {
  // The dry run caught this: the guest complained about their August stay but had a
  // second, clean booking. Filtering per booking would still have invited them to
  // leave a public review about the other one.
  const reservations = [
    row('complained', 'g1', '2026-08-10', 'both@mail.md', '+37369000021'),
    row('clean', 'g2', '2026-08-26', 'both@mail.md', '+37369000021'),
    row('unrelated', 'g3', '2026-08-27', 'other@mail.md', '+37369000022'),
  ];

  const picked = selectBackfillRecipients({
    reservations,
    statusByReservation: departed(['complained', 'clean', 'unrelated']),
    complaintReservationIds: new Set(['complained']),
  });

  assertEquals(picked.map((entry) => entry.owner.guest_email), ['other@mail.md']);
});

Deno.test('normalizeBackfillEmail lowercases, trims and empties absent values', () => {
  assertEquals(normalizeBackfillEmail('  ION@Mail.MD '), 'ion@mail.md');
  assertEquals(normalizeBackfillEmail(null), '');
  assertEquals(normalizeBackfillEmail(undefined), '');
});
