export const CASH_EXPIRY_MINUTES = 30;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INTERNATIONAL_PHONE_PATTERN = /^\+\d{8,15}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ReservationInput = {
  id?: string;
  booking_group_id?: string;
  room_id?: string;
  guest_first_name?: string;
  guest_last_name?: string;
  guest_phone?: string;
  guest_email?: string;
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
};

export type ReservationRow = {
  id?: string;
  booking_group_id?: string;
  room_id: string;
  guest_first_name: string;
  guest_last_name: string;
  guest_phone: string;
  guest_email: string;
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
};

export type ReservationRecord = ReservationRow & {
  id: string;
  room_number?: number;
  room_type?: string;
  rooms?: { number?: number; type?: string } | { number?: number; type?: string }[] | null;
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
  client: any,
  inputs: ReservationInput[],
  options: { now?: Date } = {},
) {
  const rows = buildReservationRows(inputs, options);
  const { data: reservations, error: reservationError } = await client
    .from('reservations')
    .insert(rows)
    .select(
      'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, check_in, check_out, adults, kids_ages, total_price, payment_type, payment_status, room_explicitly_selected, conference_room, notes, cash_expires_at, cash_extended, created_by, rooms(number, type)',
    );

  if (reservationError) {
    throw new Error(reservationError.message || 'Could not create reservation.');
  }

  const normalizedReservations = (reservations || []).map(withRoomFields);
  const tokenRows = buildCancellationTokenRows(normalizedReservations);
  const { data: cancellationTokens, error: tokenError } = await client
    .from('cancellation_tokens')
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

export function withRoomFields(reservation: any) {
  const room = Array.isArray(reservation.rooms) ? reservation.rooms[0] : reservation.rooms;

  return {
    ...reservation,
    room_number: Number(room?.number || reservation.room_number || 0) || undefined,
    room_type: room?.type || reservation.room_type,
  };
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
  const totalPrice = numberInput(input.total_price);

  if (!INTERNATIONAL_PHONE_PATTERN.test(phone)) {
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
    guest_first_name: requiredString(input.guest_first_name, 'Guest first name is required.'),
    guest_last_name: requiredString(input.guest_last_name, 'Guest last name is required.'),
    guest_phone: phone,
    guest_email: email,
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

function numberInput(value: unknown) {
  return typeof value === 'number' ? value : Number(value);
}

function trim(value: unknown) {
  return String(value ?? '').trim();
}
