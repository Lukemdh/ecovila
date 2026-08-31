import { aggregateRoomLabel } from './notifications.ts';
import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  ilike(column: string, value: string): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: { ascending?: boolean }): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
};

type ContactInput = {
  phone?: unknown;
  email?: unknown;
};

type SourceReservation = {
  check_in: string;
  check_out: string;
};

type PreviousReservationRow = {
  id: string;
  booking_group_id: string | null;
  guest_phone: string | null;
  guest_email: string | null;
  check_in: string;
  check_out: string;
  adults: number;
  kids_ages: number[] | null;
  payment_status: string;
  rooms?: { type?: string | null } | Array<{ type?: string | null }> | null;
};

export type GuestFlagMarker = {
  id: string;
  guest_phone: string | null;
  guest_email: string | null;
  severity: 'attention' | 'vip';
  created_at: string;
  body_preview: string;
};

export type GuestFlagMatch = {
  severity: 'attention' | 'vip';
  hasAttention: boolean;
  hasVip: boolean;
  notes: GuestFlagMarker[];
};

export type GuestNote = {
  id: string;
  guest_phone: string | null;
  guest_email: string | null;
  severity: 'info' | 'attention' | 'vip';
  body: string;
  source_reservation_id: string | null;
  created_by: string | null;
  created_by_role: 'diana' | 'angela';
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  archived_by: string | null;
  source_reservation?: SourceReservation | SourceReservation[] | null;
};

export type PreviousStay = {
  bookingGroupId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  kidsCount: number;
  accommodation: string;
  status: string;
};

export function normalizeNoteEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

// Guest emails are only validated against /^[^\s@]+@[^\s@]+\.[^\s@]+$/, which
// admits `%` and `_` — both LIKE wildcards. Left unescaped, a booking made with
// `a_b@x.md` would turn the case-insensitive lookup into a pattern matching
// `axb@x.md` as well. The JS contact filter below rejects those rows anyway, but
// a wildcard query would first fill the row limit with the wrong reservations.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function matchGuestFlags(
  markers: GuestFlagMarker[],
  contacts: ContactInput,
): GuestFlagMatch | null {
  const phone = String(contacts.phone || '').trim();
  const email = normalizeNoteEmail(contacts.email);
  const notes = markers.filter((marker) => {
    const phoneMatches = Boolean(phone) && Boolean(marker.guest_phone) &&
      marker.guest_phone === phone;
    const emailMatches = Boolean(email) && Boolean(marker.guest_email) &&
      normalizeNoteEmail(marker.guest_email) === email;
    return phoneMatches || emailMatches;
  });

  if (!notes.length) {
    return null;
  }

  const hasAttention = notes.some((note) => note.severity === 'attention');
  const hasVip = notes.some((note) => note.severity === 'vip');

  return {
    severity: hasAttention ? 'attention' : 'vip',
    hasAttention,
    hasVip,
    notes,
  };
}

export async function fetchGuestFlagMarkers(client: SupabaseClient): Promise<GuestFlagMarker[]> {
  const { data, error } = await table<GuestFlagMarker[]>(client, 'guest_flag_markers')
    .select('id, guest_phone, guest_email, severity, created_at, body_preview');

  if (error) {
    throw new Error(error.message || 'Could not load guest flag markers.');
  }

  return data || [];
}

export async function fetchGuestNotesForContacts(
  client: SupabaseClient,
  contacts: ContactInput,
): Promise<GuestNote[]> {
  const phone = String(contacts.phone || '').trim();
  const email = normalizeNoteEmail(contacts.email);
  const results = await Promise.all([
    ...(phone ? [fetchNotesBy(client, 'guest_phone', phone)] : []),
    ...(email ? [fetchNotesBy(client, 'guest_email', email)] : []),
  ]);

  return uniqueById(results.flat())
    .filter((note) => contactMatches(note, phone, email))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

export async function fetchPreviousBookings(
  client: SupabaseClient,
  contacts: ContactInput & { excludeBookingGroupId?: string | null },
): Promise<PreviousStay[]> {
  const phone = String(contacts.phone || '').trim();
  const email = normalizeNoteEmail(contacts.email);
  const results = await Promise.all([
    ...(phone ? [fetchReservationsBy(client, 'guest_phone', phone)] : []),
    ...(email ? [fetchReservationsBy(client, 'guest_email', email, true)] : []),
  ]);
  const rows = uniqueById(results.flat()).filter((row) => contactMatches(row, phone, email));
  const groups = new Map<string, PreviousReservationRow[]>();

  for (const row of rows) {
    const bookingGroupId = row.booking_group_id || row.id;
    if (bookingGroupId === contacts.excludeBookingGroupId) {
      continue;
    }

    const group = groups.get(bookingGroupId);
    if (group) {
      group.push(row);
    } else {
      groups.set(bookingGroupId, [row]);
    }
  }

  return [...groups.entries()]
    .map(([bookingGroupId, group]) => toPreviousStay(bookingGroupId, group))
    .sort((left, right) => right.checkIn.localeCompare(left.checkIn))
    .slice(0, 3);
}

async function fetchNotesBy(
  client: SupabaseClient,
  column: 'guest_phone' | 'guest_email',
  value: string,
): Promise<GuestNote[]> {
  let query = table<GuestNote[]>(client, 'guest_notes')
    .select(
      'id, guest_phone, guest_email, severity, body, source_reservation_id, created_by, created_by_role, created_at, updated_at, archived_at, archived_by, source_reservation:reservations!guest_notes_source_reservation_id_fkey(check_in, check_out)',
    )
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  // guest_notes.guest_email is CHECK-enforced lowercase, so equality is both
  // correct and able to use guest_notes_email_idx. Only the reservations lookup
  // below needs a case-insensitive match, because the CRM add form never
  // lowercased what staff typed.
  query = query.eq(column, value);
  const { data, error } = await query;

  if (error) {
    throw new Error(error.message || 'Could not load guest notes.');
  }

  return data || [];
}

async function fetchReservationsBy(
  client: SupabaseClient,
  column: 'guest_phone' | 'guest_email',
  value: string,
  caseInsensitive = false,
): Promise<PreviousReservationRow[]> {
  let query = table<PreviousReservationRow[]>(client, 'reservations')
    .select(
      'id, booking_group_id, guest_phone, guest_email, check_in, check_out, adults, kids_ages, payment_status, rooms(type)',
    )
    .order('check_in', { ascending: false })
    .limit(100);
  query = caseInsensitive ? query.ilike(column, escapeLikePattern(value)) : query.eq(column, value);
  const { data, error } = await query;

  if (error) {
    throw new Error(error.message || 'Could not load previous bookings.');
  }

  return data || [];
}

function toPreviousStay(
  bookingGroupId: string,
  group: PreviousReservationRow[],
): PreviousStay {
  const ordered = [...group].sort((left, right) => right.check_in.localeCompare(left.check_in));
  const representative = ordered[0];
  return {
    bookingGroupId,
    checkIn: representative.check_in,
    checkOut: ordered.reduce(
      (latest, row) => (row.check_out > latest ? row.check_out : latest),
      representative.check_out,
    ),
    adults: group.reduce((sum, row) => sum + Math.max(0, Number(row.adults) || 0), 0),
    kidsCount: group.reduce(
      (sum, row) => sum + (Array.isArray(row.kids_ages) ? row.kids_ages.length : 0),
      0,
    ),
    accommodation: aggregateRoomLabel(group, 'ro'),
    status: representative.payment_status,
  };
}

function contactMatches(
  row: { guest_phone?: string | null; guest_email?: string | null },
  phone: string,
  email: string,
): boolean {
  return (Boolean(phone) && row.guest_phone === phone) ||
    (Boolean(email) && normalizeNoteEmail(row.guest_email) === email);
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
