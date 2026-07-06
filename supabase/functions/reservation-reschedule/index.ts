import { handleCors } from '../_shared/cors.ts';
import {
  assertMethod,
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireStaffRole,
} from '../_shared/http.ts';
import { sendSms } from '../_shared/providers.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import { hasValidPhoneLength, normalizeInternationalPhone } from '../_shared/reservations.ts';
import { planReschedule } from '../_shared/reservationReschedule.ts';
import type { RescheduleGroupRow } from '../_shared/reservationReschedule.ts';
import { normalizeEmailLang, reservationRescheduleSms } from '../_shared/notifications.ts';
import type { AssignmentReservation, AssignmentRoom } from '../_shared/roomAssignment.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// Match roomAssignment's free-window cap so the tightest-window ordering sees the
// same neighbours it would during a fresh booking.
const RESERVATION_WINDOW_DAYS = 61;
const HTML_CONTROL_PATTERN = /[<>]/;

type RoomRelation = { number?: number | string | null; type?: string | null };

type GroupReservationRow = {
  id: string;
  booking_group_id: string | null;
  room_id: string;
  guest_first_name: string | null;
  guest_last_name: string | null;
  guest_phone: string;
  guest_language: string | null;
  check_in: string;
  check_out: string;
  adults: number;
  kids_ages: number[] | null;
  notes: string | null;
  created_at: string;
  rooms?: RoomRelation | RoomRelation[] | null;
};

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, values: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
  lt(column: string, value: unknown): QueryBuilder<T>;
};

// The shared SupabaseClient type only declares `from`; the runtime client also has
// `rpc`. Same narrowing cast the rate limiter uses (_shared/rateLimit.ts).
type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<SupabaseQueryResult<unknown>>;
};

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    // Reschedule is a write; only Diana edits bookings. Angela's CRM is read-only.
    await requireStaffRole(request, ['diana']);

    const body = await readJson(request);
    const reservationId = String(body?.reservationId || '').trim();
    const bookingGroupId = String(body?.bookingGroupId || '').trim();
    if (!reservationId && !bookingGroupId) {
      throw new HttpError(400, 'reservationId or bookingGroupId is required.');
    }

    const checkIn = isoDate(body?.check_in, 'Check-in date is required (YYYY-MM-DD).');
    const checkOut = isoDate(body?.check_out, 'Check-out date is required (YYYY-MM-DD).');
    if (checkOut <= checkIn) {
      throw new HttpError(400, 'Check-out must be after check-in.');
    }

    const client = createServiceClient();
    const groupRows = await loadGroupRows(client, { reservationId, bookingGroupId });
    if (!groupRows.length) {
      throw new HttpError(404, 'No active reservation was found to reschedule.');
    }

    // The opened row is the one whose party/notes the modal edits; group-wide
    // fields (dates, room, name, phone) apply to every villa in the booking.
    const opened = reservationId
      ? groupRows.find((row) => row.id === reservationId) || groupRows[0]
      : groupRows[0];

    const oldCheckIn = String(opened.check_in);
    const oldCheckOut = String(opened.check_out);
    const datesChanged = oldCheckIn !== checkIn || oldCheckOut !== checkOut;

    // Decide the villa for each row BEFORE writing anything, so a "no villa
    // available" outcome leaves the booking untouched.
    const [rooms, reservations] = await Promise.all([
      loadActiveRooms(client),
      loadActiveReservationsWindow(client, checkIn, checkOut),
    ]);
    const groupRowIds = new Set(groupRows.map((row) => row.id));
    const otherReservations = reservations.filter((row) => !groupRowIds.has(String(row.id)));

    const plan = planReschedule({
      rooms,
      reservations: otherReservations,
      groupRows: groupRows.map(toPlanRow),
      checkIn,
      checkOut,
    });

    if (!plan.ok) {
      const label = villaTypeLabel(plan.unavailableType);
      throw new HttpError(
        409,
        `Nu există nicio vilă de tip ${label} liberă pentru ${checkIn} – ${checkOut}.`,
      );
    }

    const roomById = new Map(plan.assignments.map((entry) => [entry.id, entry.room_id]));
    const openedRoomId = roomById.get(opened.id) || opened.room_id;
    const openedRoomNumber = rooms.find((room) => room.id === openedRoomId)?.number ?? null;
    const sharedFields = buildSharedFields(body, checkIn, checkOut);
    const openedExtras = buildOpenedRowFields(body);
    let roomChanged = false;

    // Build every row's patch, then apply them all in ONE transaction
    // (reschedule_reservation_group). A villa grabbed by a concurrent booking
    // between the plan and the commit rolls the WHOLE move back (23P01) instead of
    // leaving a multi-villa group half-moved. Each patch's key PRESENCE means
    // "set it"; absent keys leave the stored value untouched (see the builders).
    const patches = groupRows.map((row) => {
      const roomId = roomById.get(row.id) || row.room_id;
      if (roomId !== row.room_id) roomChanged = true;
      const patch: Record<string, unknown> = { id: row.id, ...sharedFields, room_id: roomId };
      if (row.id === opened.id) Object.assign(patch, openedExtras);
      return patch;
    });

    const { error } = await (client as RpcClient).rpc('reschedule_reservation_group', {
      p_patches: patches,
    });
    if (error) {
      // 23P01 = exclusion_violation: a villa was taken between the plan and the
      // commit. The transaction already rolled back, so nothing moved — retry.
      if (String((error as { code?: string }).code) === '23P01') {
        throw new HttpError(
          409,
          'Una dintre vile tocmai a fost ocupată pentru aceste date. Reîncearcă.',
        );
      }
      throw new Error(error.message || 'Could not update the reservation.');
    }

    // Tell the guest only when the dates actually moved. Best-effort: the move is
    // already saved, so a failed SMS must not undo it — surface it as a warning.
    let smsSent = false;
    let smsError: string | null = null;
    if (datesChanged) {
      try {
        await sendSms({
          to: opened.guest_phone,
          message: reservationRescheduleSms({
            language: normalizeEmailLang(opened.guest_language),
            checkIn,
            checkOut,
          }),
        });
        smsSent = true;
      } catch (error) {
        smsError = error instanceof Error ? error.message : 'SMS provider request failed.';
        console.error('Reschedule SMS failed', error);
      }
    }

    return jsonResponse(
      { ok: true, datesChanged, roomChanged, roomNumber: openedRoomNumber, smsSent, smsError },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function loadGroupRows(
  client: SupabaseClient,
  input: { reservationId: string; bookingGroupId: string },
): Promise<GroupReservationRow[]> {
  const columns =
    'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_language, check_in, check_out, adults, kids_ages, notes, created_at, rooms(number, type)';

  // Resolve the booking group from the opened reservation when no group id was
  // passed, so a single-row booking and a multi-villa group take the same path.
  let groupId = input.bookingGroupId;
  if (!groupId && input.reservationId) {
    const { data, error } = await table<{ booking_group_id: string | null }[]>(
      client,
      'reservations',
    )
      .select('booking_group_id')
      .eq('id', input.reservationId);
    if (error) throw new Error(error.message);
    groupId = String(data?.[0]?.booking_group_id || '');
  }

  const query = table<GroupReservationRow[]>(client, 'reservations')
    .select(columns)
    .is('cancelled_at', null)
    .in('payment_status', ['pending', 'paid']);

  const { data, error } = groupId
    ? await query.eq('booking_group_id', groupId)
    : await query.eq('id', input.reservationId);

  if (error) throw new Error(error.message);
  return data || [];
}

async function loadActiveRooms(client: SupabaseClient): Promise<AssignmentRoom[]> {
  const { data, error } = await table<AssignmentRoom[]>(client, 'rooms')
    .select('id, number, type, is_active');
  if (error) throw new Error(error.message || 'Could not load rooms.');
  return (data || []).filter((room) => room.is_active !== false);
}

async function loadActiveReservationsWindow(
  client: SupabaseClient,
  checkIn: string,
  checkOut: string,
): Promise<Array<AssignmentReservation & { id: string }>> {
  const minDate = addDaysISO(checkIn, -RESERVATION_WINDOW_DAYS);
  const maxDate = addDaysISO(checkOut, RESERVATION_WINDOW_DAYS);
  const { data, error } = await table<Array<AssignmentReservation & { id: string }>>(
    client,
    'reservations',
  )
    .select('id, room_id, check_in, check_out, payment_status, cancelled_at')
    .is('cancelled_at', null)
    .in('payment_status', ['pending', 'paid'])
    .gt('check_out', minDate)
    .lt('check_in', maxDate);
  if (error) throw new Error(error.message || 'Could not load reservations.');
  return data || [];
}

function toPlanRow(row: GroupReservationRow): RescheduleGroupRow {
  const relation = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
  const type = String(relation?.type || '');
  if (!type) {
    throw new HttpError(409, 'Reservation has no villa type and cannot be moved automatically.');
  }
  return { id: row.id, room_id: row.room_id, room_type: type };
}

function buildSharedFields(body: unknown, checkIn: string, checkOut: string) {
  const fields: Record<string, unknown> = { check_in: checkIn, check_out: checkOut };
  const data = body as Record<string, unknown>;

  const firstName = optionalName(data.guest_first_name);
  const lastName = optionalName(data.guest_last_name);
  if (firstName !== undefined) fields.guest_first_name = firstName;
  if (lastName !== undefined) fields.guest_last_name = lastName;

  if (data.guest_phone !== undefined && String(data.guest_phone).trim() !== '') {
    const phone = normalizeInternationalPhone(data.guest_phone);
    if (!hasValidPhoneLength(phone)) {
      throw new HttpError(400, 'Guest phone must include a valid country code.');
    }
    fields.guest_phone = phone;
  }

  return fields;
}

function buildOpenedRowFields(body: unknown) {
  const fields: Record<string, unknown> = {};
  const data = body as Record<string, unknown>;

  if (data.adults !== undefined) {
    const adults = Number(data.adults);
    if (!Number.isInteger(adults) || adults < 0) {
      throw new HttpError(400, 'Adults must be a whole number of 0 or more.');
    }
    fields.adults = adults;
  }

  if (data.kids_ages !== undefined) {
    fields.kids_ages = normalizeKidsAges(data.kids_ages);
  }

  if (data.notes !== undefined) {
    const notes = String(data.notes ?? '').trim();
    fields.notes = notes ? notes : null;
  }

  return fields;
}

function normalizeKidsAges(value: unknown): number[] {
  const ages = Array.isArray(value) ? value : [];
  return ages.map((age) => {
    const normalized = Number(age);
    if (!Number.isInteger(normalized) || normalized < 0 || normalized > 18) {
      throw new HttpError(400, 'Child ages must be whole numbers from 0 to 18.');
    }
    return normalized;
  });
}

function optionalName(value: unknown): string | undefined {
  // Empty/absent → leave the stored name untouched (skip), so clearing the field
  // never blanks a required column. Only a non-empty value is validated and saved.
  if (value === undefined) return undefined;
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (HTML_CONTROL_PATTERN.test(text)) {
    throw new HttpError(400, 'Guest names cannot include HTML control characters.');
  }
  return text;
}

function villaTypeLabel(type: string): string {
  if (type === 'small') return 'Căsuță mică';
  if (type === 'large') return 'Căsuță mare';
  if (type === 'hotel') return 'Cameră în hotel';
  return type;
}

function isoDate(value: unknown, message: string): string {
  const text = String(value ?? '').trim();
  if (!ISO_DATE_PATTERN.test(text)) {
    throw new HttpError(400, message);
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new HttpError(400, message);
  }
  return text;
}

function addDaysISO(value: string, days: number): string {
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return new Date(epoch + days * DAY_MS).toISOString().slice(0, 10);
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
