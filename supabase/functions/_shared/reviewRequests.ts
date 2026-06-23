import { mapNotificationOwners } from './notifications.ts';
import type { NotificationGroupRow } from './notifications.ts';

export type DailyStatusRow = {
  reservation_id: string;
  checked_out_at?: string | null;
  checkout_note?: string | null;
};

export type CheckoutStatus = { departed: boolean; hasNote: boolean };

/**
 * Collapse the situația-zilnică rows for a set of reservations into a per-reservation
 * checkout summary. A reservation can have more than one daily-status row (the
 * check-in day and the checkout day are separate service_date rows), so the signals
 * are OR-ed together: `departed` if any row marks a checkout, `hasNote` if any row
 * carries a non-empty checkout note.
 */
export function aggregateCheckoutStatus(rows: DailyStatusRow[]): Map<string, CheckoutStatus> {
  const byReservation = new Map<string, CheckoutStatus>();

  for (const row of rows) {
    const current = byReservation.get(row.reservation_id) || { departed: false, hasNote: false };
    byReservation.set(row.reservation_id, {
      departed: current.departed || Boolean(row.checked_out_at),
      hasNote: current.hasNote || String(row.checkout_note ?? '').trim().length > 0,
    });
  }

  return byReservation;
}

/**
 * Pick the booking groups that should receive a post-stay review request: the guest
 * was actually checked out in situația zilnică and no room in the booking carries a
 * checkout note (a note means staff recorded an issue, so we stay quiet). Returns one
 * entry per booking group, each keyed by the group's owner reservation (the row that
 * sends the single email — see mapNotificationOwners).
 */
export function selectReviewRequestGroups<T extends NotificationGroupRow>(input: {
  reservations: T[];
  statusByReservation: Map<string, CheckoutStatus>;
}): Array<{ owner: T; group: T[] }> {
  const ownerGroups = mapNotificationOwners(input.reservations);
  const selected: Array<{ owner: T; group: T[] }> = [];

  for (const [ownerId, group] of ownerGroups) {
    const owner = group.find((reservation) => reservation.id === ownerId) || group[0];
    const departed = group.some(
      (reservation) => input.statusByReservation.get(reservation.id)?.departed,
    );
    const hasNote = group.some(
      (reservation) => input.statusByReservation.get(reservation.id)?.hasNote,
    );

    if (departed && !hasNote) {
      selected.push({ owner, group });
    }
  }

  return selected;
}
