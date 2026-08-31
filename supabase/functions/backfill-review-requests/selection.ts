// ONE-OFF BACKFILL (B-39). ADR-082's review email never sent between 2026-06-23 and
// 2026-08-31 because `review_request` was missing from the notification_events CHECK
// constraint. This module picks who receives the catch-up.
//
// It reuses the LIVE eligibility rules rather than restating them: a guest qualifies
// only if `selectReviewRequestGroups` would have picked them on the day — actually
// marked checked out in situația zilnică, and no room in the booking carrying a
// checkout note. Anything looser would email people the normal flow deliberately
// stays quiet about.
//
// DELETE THIS FUNCTION once the backfill runs are finished.
import { selectReviewRequestGroups } from '../_shared/reviewRequests.ts';
import type { CheckoutStatus } from '../_shared/reviewRequests.ts';
import type { NotificationGroupRow } from '../_shared/notifications.ts';

export type BackfillRow = NotificationGroupRow & {
  guest_email?: string | null;
  guest_phone?: string | null;
  check_out: string;
};

export function normalizeBackfillEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

/**
 * One recipient per PERSON, not per booking. The 552 missed bookings collapse to far
 * fewer people because repeat guests appear several times; mailing per booking would
 * ask the same person three or four times in one week. The most recent stay wins, so
 * the email a guest does receive is about the visit they remember best.
 */
export function selectBackfillRecipients<T extends BackfillRow>(input: {
  reservations: T[];
  statusByReservation: Map<string, CheckoutStatus>;
  complaintPhones?: Set<string>;
  complaintReservationIds?: Set<string>;
  alreadySentEmails?: Set<string>;
}): Array<{ owner: T; group: T[] }> {
  const complaintPhones = input.complaintPhones || new Set<string>();
  const complaintReservationIds = input.complaintReservationIds || new Set<string>();
  const alreadySentEmails = input.alreadySentEmails || new Set<string>();

  const eligible = selectReviewRequestGroups({
    reservations: input.reservations,
    statusByReservation: input.statusByReservation,
  });

  // Exclusion is per PERSON, not per booking. A guest who complained about one stay
  // must not be asked for a public review about a different one — filtering the
  // single booking would let exactly that through, and the dry run proved it did.
  const complainerEmails = new Set<string>();
  for (const entry of eligible) {
    const email = normalizeBackfillEmail(entry.owner.guest_email);
    if (!email) continue;
    const complained = entry.group.some((row) =>
      complaintReservationIds.has(row.id) ||
      (Boolean(row.guest_phone) && complaintPhones.has(String(row.guest_phone)))
    );
    if (complained) {
      complainerEmails.add(email);
    }
  }

  const byEmail = new Map<string, { owner: T; group: T[] }>();

  for (const entry of eligible) {
    const email = normalizeBackfillEmail(entry.owner.guest_email);
    if (!email || alreadySentEmails.has(email) || complainerEmails.has(email)) {
      continue;
    }

    const current = byEmail.get(email);
    if (!current || groupCheckOut(entry.group) > groupCheckOut(current.group)) {
      byEmail.set(email, entry);
    }
  }

  // Most recent stay first: if a run is interrupted, the freshest — and highest
  // converting — asks have already gone out.
  return [...byEmail.values()].sort((left, right) =>
    groupCheckOut(right.group).localeCompare(groupCheckOut(left.group))
  );
}

function groupCheckOut<T extends BackfillRow>(group: T[]): string {
  return group.reduce((latest, row) => (row.check_out > latest ? row.check_out : latest), '');
}
