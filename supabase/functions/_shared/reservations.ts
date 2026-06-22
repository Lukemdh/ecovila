import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

export const CASH_EXPIRY_MINUTES = 30;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Full international number: a non-zero country code plus the national part,
// 10–15 digits after the "+". The non-zero lead and 10-digit floor reject a bare
// Moldovan national number that lost its "+373" (e.g. "+60843453") instead of
// accepting it as a "foreign" number — every country we serve needs ≥11.
const INTERNATIONAL_PHONE_PATTERN = /^\+[1-9]\d{9,14}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTML_CONTROL_PATTERN = /[<>]/;
const SUPPORTED_LANGUAGES = new Set(['ro', 'ru', 'en']);

export type ReservationInput = {
  id?: string;
  booking_group_id?: string;
  room_id?: string;
  guest_first_name?: string;
  guest_last_name?: string;
  guest_phone?: string;
  guest_email?: string;
  guest_language?: string;
  check_in?: string;
  check_out?: string;
  adults?: number;
  kids_ages?: number[];
  total_price?: number;
  payment_type?: 'cash' | 'card';
  payment_status?: string;
  room_explicitly_selected?: boolean;
  conference_room?: boolean;
  notes?: string | null;
  cash_expires_at?: string | null;
  cash_extended?: boolean;
  created_by?: string;
  tracking_event_id?: string | null;
  tracking_fbp?: string | null;
  tracking_fbc?: string | null;
  tracking_user_agent?: string | null;
  tracking_source_url?: string | null;
};

export type ReservationRow = {
  id?: string;
  booking_group_id?: string;
  room_id: string;
  guest_first_name: string;
  guest_last_name: string;
  guest_phone: string;
  guest_email: string;
  guest_language: string;
  check_in: string;
  check_out: string;
  adults: number;
  kids_ages: number[];
  total_price: number;
  payment_type: 'cash' | 'card';
  payment_status: 'pending';
  room_explicitly_selected: boolean;
  conference_room: false;
  notes: null;
  cash_expires_at: string | null;
  cash_extended: false;
  created_by: 'guest';
  tracking_event_id?: string | null;
  tracking_fbp?: string | null;
  tracking_fbc?: string | null;
  tracking_user_agent?: string | null;
  tracking_source_url?: string | null;
};

export type ReservationRecord = ReservationRow & {
  id: string;
  room_number?: number;
  room_type?: string;
  rooms?: { number?: number; type?: string } | { number?: number; type?: string }[] | null;
};

type RoomRelation = {
  number?: number | string | null;
  type?: string | null;
};

type ReservationRoomFields = {
  rooms?: RoomRelation | RoomRelation[] | null;
  room_number?: number | string | null;
  room_type?: string | null;
};

type InsertSelectBuilder<T> = {
  select(columns: string): Promise<SupabaseQueryResult<T[]>>;
};

type InsertTable<T> = {
  insert(payload: unknown): InsertSelectBuilder<T>;
};

export type CancellationTokenRow = {
  reservation_id: string;
  token: string;
};

export function buildReservationRows(inputs: ReservationInput[], options: { now?: Date } = {}) {
  if (!Array.isArray(inputs) || inputs.length < 1) {
    throw new Error('At least one reservation row is required.');
  }

  const now = options.now || new Date();
  const bookingGroupId = inputs[0].booking_group_id || crypto.randomUUID();

  return inputs.map((input) => normalizeReservationInput(input, now, bookingGroupId));
}

export function buildCancellationTokenRows(
  reservations: Array<{ id?: string }>,
  createToken: () => string = createSecureToken,
) {
  return reservations.map((reservation) => {
    const reservationId = requiredString(reservation.id, 'Reservation id is required.');
    const token = createToken();

    if (token.length < 32) {
      throw new Error('Cancellation token must be at least 32 characters.');
    }

    return {
      reservation_id: reservationId,
      token,
    };
  });
}

export async function createReservationsWithTokens(
  client: SupabaseClient,
  inputs: ReservationInput[],
  options: {
    now?: Date;
    assignRooms?: (rows: ReservationRow[]) => Promise<ReservationRow[]>;
    priceGuard?: (rows: ReservationRow[]) => Promise<ReservationRow[]>;
  } = {},
) {
  let rows = buildReservationRows(inputs, options);

  // Auto-assign rooms before the price guard so the guard validates the final
  // room ids. Price depends only on the villa type (unchanged by assignment),
  // so the order is safe. See ADR-054.
  if (options.assignRooms) {
    rows = await options.assignRooms(rows);
  }

  if (options.priceGuard) {
    rows = await options.priceGuard(rows);
  }
  const { data: reservations, error: reservationError } = await insertTable<ReservationRecord>(
    client,
    'reservations',
  )
    .insert(rows)
    .select(
      'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, adults, kids_ages, total_price, payment_type, payment_status, room_explicitly_selected, conference_room, notes, cash_expires_at, cash_extended, created_by, rooms(number, type)',
    );

  if (reservationError) {
    throw new Error(reservationError.message || 'Could not create reservation.');
  }

  const normalizedReservations = (reservations || []).map(withRoomFields);
  const tokenRows = buildCancellationTokenRows(normalizedReservations);
  const { data: cancellationTokens, error: tokenError } = await insertTable<CancellationTokenRow>(
    client,
    'cancellation_tokens',
  )
    .insert(tokenRows)
    .select('reservation_id, token');

  if (tokenError) {
    throw new Error(tokenError.message || 'Could not create cancellation tokens.');
  }

  return {
    reservations: normalizedReservations,
    cancellationTokens: cancellationTokens || [],
    primaryReservationId: normalizedReservations[0]?.id || '',
    bookingGroupId: normalizedReservations[0]?.booking_group_id || rows[0].booking_group_id || '',
  };
}

export function normalizeInternationalPhone(value: unknown) {
  const compact = trim(value).replace(/[\s().-]/g, '');

  if (/^0\d{8}$/.test(compact)) {
    return `+373${compact.slice(1)}`;
  }

  if (/^\d{8}$/.test(compact)) {
    return `+373${compact}`;
  }

  if (/^373\d{8}$/.test(compact)) {
    return `+${compact}`;
  }

  return compact;
}

// Country-specific phone length guard. Moldova (+373) numbers carry 8 national
// digits, Romania (+40) and Ukraine (+380) carry 9. Any other country must be a
// full international number (see INTERNATIONAL_PHONE_PATTERN). Keep this in sync
// with the identical client helper in checkout.js / anulare.js / booking.js.
export function hasValidPhoneLength(phone: string): boolean {
  if (phone.startsWith('+373')) return /^\+373\d{8}$/.test(phone);
  if (phone.startsWith('+380')) return /^\+380\d{9}$/.test(phone);
  if (phone.startsWith('+40')) return /^\+40\d{9}$/.test(phone);
  return INTERNATIONAL_PHONE_PATTERN.test(phone);
}

export function withRoomFields<T extends ReservationRoomFields>(reservation: T) {
  const room = Array.isArray(reservation.rooms) ? reservation.rooms[0] : reservation.rooms;

  return {
    ...reservation,
    room_number: Number(room?.number || reservation.room_number || 0) || undefined,
    room_type: room?.type || reservation.room_type,
  };
}

function insertTable<T>(client: SupabaseClient, table: string) {
  return client.from(table) as InsertTable<T>;
}

function normalizeReservationInput(input: ReservationInput, now: Date, bookingGroupId: string) {
  if (input.payment_status && input.payment_status !== 'pending') {
    throw new Error('Only pending guest reservations can be created publicly.');
  }

  if (input.created_by && input.created_by !== 'guest') {
    throw new Error('Only guest reservations can be created publicly.');
  }

  if (input.notes != null && trim(input.notes)) {
    throw new Error('Public reservations cannot include private notes.');
  }

  if (input.conference_room) {
    throw new Error('Conference room reservations must be created by staff.');
  }

  const adults = numberInput(input.adults);
  if (!Number.isInteger(adults) || adults < 1) {
    throw new Error('At least one adult is required for public reservations.');
  }

  const paymentType = input.payment_type;
  if (paymentType !== 'cash' && paymentType !== 'card') {
    throw new Error('Payment type must be cash or card.');
  }

  const checkIn = isoDate(input.check_in, 'Check-in date is required.');
  const checkOut = isoDate(input.check_out, 'Check-out date is required.');
  if (checkOut <= checkIn) {
    throw new Error('Check-out must be after check-in.');
  }

  const kidsAges = normalizeKidsAges(input.kids_ages);
  const phone = normalizeInternationalPhone(input.guest_phone);
  const email = trim(input.guest_email).toLowerCase();
  const guestLanguage = normalizeLanguage(input.guest_language);
  const totalPrice = numberInput(input.total_price);

  if (!hasValidPhoneLength(phone)) {
    throw new Error('Guest phone must use a valid international format.');
  }

  if (!EMAIL_PATTERN.test(email)) {
    throw new Error('Guest email must be valid.');
  }

  if (!Number.isInteger(totalPrice) || totalPrice < 0) {
    throw new Error('Total price must be a non-negative integer.');
  }

  const row: ReservationRow = {
    room_id: requiredString(input.room_id, 'Room id is required.'),
    guest_first_name: guestNameField(input.guest_first_name, 'Guest first name is required.'),
    guest_last_name: guestNameField(input.guest_last_name, 'Guest last name is required.'),
    guest_phone: phone,
    guest_email: email,
    guest_language: guestLanguage,
    check_in: checkIn,
    check_out: checkOut,
    adults,
    kids_ages: kidsAges,
    total_price: totalPrice,
    payment_type: paymentType,
    payment_status: 'pending',
    room_explicitly_selected: Boolean(input.room_explicitly_selected),
    conference_room: false,
    notes: null,
    cash_expires_at: paymentType === 'cash' ? cashExpiry(now) : null,
    cash_extended: false,
    created_by: 'guest',
  };

  for (
    const key of [
      'tracking_event_id',
      'tracking_fbp',
      'tracking_fbc',
      'tracking_user_agent',
      'tracking_source_url',
    ] as const
  ) {
    const value = optionalTrackingValue(input[key]);
    if (value) {
      row[key] = value;
    }
  }

  if (input.id) {
    row.id = trim(input.id);
  }

  row.booking_group_id = bookingGroupId;

  return orderReservationRow(row);
}

function orderReservationRow(row: ReservationRow) {
  const ordered: ReservationRow = {
    ...(row.id ? { id: row.id } : {}),
    ...(row.booking_group_id ? { booking_group_id: row.booking_group_id } : {}),
    room_id: row.room_id,
    guest_first_name: row.guest_first_name,
    guest_last_name: row.guest_last_name,
    guest_phone: row.guest_phone,
    guest_email: row.guest_email,
    guest_language: row.guest_language,
    check_in: row.check_in,
    check_out: row.check_out,
    adults: row.adults,
    kids_ages: row.kids_ages,
    total_price: row.total_price,
    payment_type: row.payment_type,
    payment_status: 'pending',
    room_explicitly_selected: row.room_explicitly_selected,
    conference_room: false,
    notes: null,
    cash_expires_at: row.cash_expires_at,
    cash_extended: false,
    created_by: 'guest',
    ...(row.tracking_event_id ? { tracking_event_id: row.tracking_event_id } : {}),
    ...(row.tracking_fbp ? { tracking_fbp: row.tracking_fbp } : {}),
    ...(row.tracking_fbc ? { tracking_fbc: row.tracking_fbc } : {}),
    ...(row.tracking_user_agent ? { tracking_user_agent: row.tracking_user_agent } : {}),
    ...(row.tracking_source_url ? { tracking_source_url: row.tracking_source_url } : {}),
  };

  return ordered;
}

function cashExpiry(now: Date) {
  return new Date(now.getTime() + CASH_EXPIRY_MINUTES * 60 * 1000).toISOString();
}

function createSecureToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeKidsAges(value: unknown) {
  const ages = Array.isArray(value) ? value : [];

  return ages.map((age) => {
    const normalized = numberInput(age);

    if (!Number.isInteger(normalized) || normalized < 0 || normalized > 18) {
      throw new Error('Child ages must be whole numbers from 0 to 18.');
    }

    return normalized;
  });
}

function optionalTrackingValue(value: unknown) {
  const normalized = trim(value);

  if (!normalized || HTML_CONTROL_PATTERN.test(normalized)) {
    return '';
  }

  return normalized.slice(0, 500);
}

function isoDate(value: unknown, message: string) {
  const text = trim(value);

  if (!ISO_DATE_PATTERN.test(text)) {
    throw new Error(message);
  }

  const date = new Date(`${text}T00:00:00.000Z`);
  if (date.toISOString().slice(0, 10) !== text) {
    throw new Error(message);
  }

  return text;
}

function requiredString(value: unknown, message: string) {
  const text = trim(value);

  if (!text) {
    throw new Error(message);
  }

  return text;
}

function guestNameField(value: unknown, message: string) {
  const text = requiredString(value, message);

  if (HTML_CONTROL_PATTERN.test(text)) {
    throw new Error('Guest names cannot include HTML control characters.');
  }

  return text;
}

function numberInput(value: unknown) {
  return typeof value === 'number' ? value : Number(value);
}

function trim(value: unknown) {
  return String(value ?? '').trim();
}

function normalizeLanguage(value: unknown) {
  const language = trim(value).toLowerCase();
  return SUPPORTED_LANGUAGES.has(language) ? language : 'ro';
}
