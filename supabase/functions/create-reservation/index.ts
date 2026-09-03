import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import { buildManageTokenRow } from '../_shared/reservationManage.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  createReservationsWithTokens,
  normalizeInternationalPhone,
} from '../_shared/reservations.ts';
import { assignAutomaticRooms, findRoomAvailabilityConflict } from '../_shared/roomAssignment.ts';
import { verifyReservationGroupPricing } from '../_shared/pricingGuard.ts';
import {
  assertRateLimits,
  RATE_LIMITS,
  RateLimitError,
  rateLimitIp,
} from '../_shared/rateLimit.ts';
import type { ReservationInput } from '../_shared/reservations.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

export async function handleCreateReservation(request: Request) {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  let failureClient: SupabaseClient | null = null;
  let failureRows: unknown = null;

  try {
    const client = createServiceClient();
    failureClient = client;
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const reservations = Array.isArray(body?.reservations) ? body.reservations : body;
    failureRows = reservations;

    // A pending reservation holds inventory, so an unauthenticated flood here is
    // an inventory-denial vector. Bound it per IP and per guest phone (ADR-060).
    // The phone is normalized BEFORE keying the bucket — otherwise "060...",
    // "+37360..." and spaced variants of one number each get their own budget.
    const guestPhone = normalizeInternationalPhone(
      (Array.isArray(reservations) ? reservations[0]?.guest_phone : reservations?.guest_phone) ||
        '',
    );
    await assertRateLimits(client, [
      { rule: RATE_LIMITS.createReservationIp, key: rateLimitIp(request) },
      { rule: RATE_LIMITS.createReservationPhone, key: guestPhone },
    ]);

    const result = await createReservationsWithTokens(
      client,
      reservations as ReservationInput[],
      {
        // Best-effort optimization: if auto-assignment fails for any reason, keep
        // the client-supplied room ids so a booking is never lost to it (ADR-054).
        assignRooms: async (rows) => {
          try {
            return await assignAutomaticRooms(client, rows);
          } catch (error) {
            console.error('Room auto-assignment failed; using client room ids', error);
            return rows;
          }
        },
        priceGuard: (rows) => verifyReservationGroupPricing(client, rows),
        // This hook runs after assignment and pricing and directly before the
        // insert, so it checks the exact room ids the database will receive.
        beforeInsert: async (rows) => {
          failureRows = rows;
          const conflict = await findRoomAvailabilityConflict(client, rows);
          if (conflict) {
            throw conflict;
          }
        },
        // The preflight is intentionally not treated as an inventory lock. The
        // exclusion constraint remains authoritative, and this second read turns
        // its race-loser result into the same actionable guest response.
        onRoomConflict: async (rows) => {
          const conflict = await findRoomAvailabilityConflict(client, rows, {
            forceConflict: true,
          });
          return conflict || fallbackRoomConflict(rows);
        },
      },
    );
    const primaryPhone = result.reservations[0]?.guest_phone || '';
    const manageToken = await buildManageTokenRow(primaryPhone);
    const { error: manageTokenError } = await client
      .from('reservation_manage_tokens')
      .insert(manageToken.row);

    if (manageTokenError) {
      throw new Error(manageTokenError.message || 'Could not create reservation manage token.');
    }

    return jsonResponse(
      {
        primaryReservationId: result.primaryReservationId,
        bookingGroupId: result.bookingGroupId,
        reservationIds: result.reservations.map((reservation) => reservation.id),
        manageToken: manageToken.token,
        paymentType: result.reservations[0]?.payment_type || '',
        notificationResults: [],
      },
      {},
      request,
    );
  } catch (error) {
    try {
      await reportBookingFailure(failureClient, failureRows, error);
    } catch (reportingError) {
      console.error(JSON.stringify({
        event: 'booking_failure_reporting_failed',
        sqlstate: errorSqlstate(reportingError) || null,
      }));
    }
    return errorResponse(error, request);
  }
}

if (import.meta.main) {
  Deno.serve(handleCreateReservation);
}

export type FailureReason =
  | 'rooms_unavailable'
  | 'rate_limited'
  | 'invalid_request'
  | 'server_error';

type FailureInsertBuilder = {
  insert(payload: Record<string, unknown>): PromiseLike<SupabaseQueryResult>;
};

type RoomTypeRow = {
  id?: string | null;
  type?: string | null;
};

type RoomTypeQuery = PromiseLike<SupabaseQueryResult<RoomTypeRow[]>> & {
  select(columns: string): RoomTypeQuery;
  in(column: string, values: string[]): RoomTypeQuery;
};

function fallbackRoomConflict(rows: ReservationInput[]) {
  const first = rows[0];
  return new HttpError(
    409,
    'Vila selectată tocmai a fost ocupată pentru datele selectate. Alege din nou.',
    {
      code: 'rooms_unavailable',
      roomType: '',
      explicitPick: Boolean(first?.room_explicitly_selected),
      takenRoomNumbers: [],
      freeRoomNumbers: [],
      soldOut: true,
    },
  );
}

async function reportBookingFailure(
  client: SupabaseClient | null,
  value: unknown,
  error: unknown,
) {
  const rows = failureInputRows(value);
  const first = rows[0] || {};
  const sqlstate = errorSqlstate(error);
  const reason = failureReason(error);
  const detail = error instanceof HttpError ? error.detail : undefined;
  let roomType = typeof detail?.roomType === 'string' ? detail.roomType : '';

  if (!roomType && client) {
    roomType = await lookupRoomType(client, rows);
  }

  const checkIn = safeIsoDate(first.check_in);
  const checkOut = safeIsoDate(first.check_out);
  const units = rows.length || null;
  const explicitlySelected = typeof detail?.explicitPick === 'boolean'
    ? detail.explicitPick
    : rows.length
    ? rows.some((row) => row.room_explicitly_selected === true)
    : null;
  const guestLanguage = ['ro', 'ru', 'en'].includes(String(first.guest_language || ''))
    ? String(first.guest_language)
    : null;

  console.error(JSON.stringify({
    event: 'booking_create_failure',
    sqlstate: sqlstate || null,
    room_type: roomType || null,
    check_in: checkIn,
    check_out: checkOut,
    units,
  }));

  if (!client) {
    return;
  }

  try {
    const { error: persistenceError } =
      await (client.from('booking_failures') as FailureInsertBuilder).insert({
        reason,
        sqlstate: sqlstate || null,
        room_type: roomType || null,
        check_in: checkIn,
        check_out: checkOut,
        units,
        room_explicitly_selected: explicitlySelected,
        guest_language: guestLanguage,
        detail: safeFailureDetail(error, reason, sqlstate),
      });

    if (persistenceError) {
      throw persistenceError;
    }
  } catch (persistenceError) {
    console.error(JSON.stringify({
      event: 'booking_failure_persist_failed',
      sqlstate: errorSqlstate(persistenceError) || null,
    }));
  }
}

function failureInputRows(value: unknown): Array<Record<string, unknown>> {
  const values = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  return values.filter((row): row is Record<string, unknown> =>
    Boolean(row) && typeof row === 'object'
  );
}

async function lookupRoomType(client: SupabaseClient, rows: Array<Record<string, unknown>>) {
  const roomIds = [
    ...new Set(
      rows.map((row) => row.room_id).filter((id): id is string =>
        typeof id === 'string' && id.length > 0
      ),
    ),
  ];
  if (roomIds.length === 0) {
    return '';
  }

  try {
    const { data, error } = await (client.from('rooms') as RoomTypeQuery)
      .select('id, type')
      .in('id', roomIds);
    if (error) {
      return '';
    }
    const typesById = new Map((data || []).map((room) => [room.id, room.type]));
    const firstType = typesById.get(roomIds[0]);
    return typeof firstType === 'string' ? firstType : '';
  } catch (_error) {
    return '';
  }
}

export function failureReason(error: unknown): FailureReason {
  if (
    error instanceof HttpError &&
    error.detail?.code === 'rooms_unavailable'
  ) {
    return 'rooms_unavailable';
  }
  if (error instanceof RateLimitError || (error instanceof HttpError && error.status === 429)) {
    return 'rate_limited';
  }
  if (error instanceof HttpError && error.status < 500) {
    return 'invalid_request';
  }
  return 'server_error';
}

function errorSqlstate(error: unknown) {
  if (!error || typeof error !== 'object') {
    return '';
  }
  const candidate = error as { sqlstate?: unknown; code?: unknown };
  const value = candidate.sqlstate || candidate.code;
  return typeof value === 'string' ? value : '';
}

function safeIsoDate(value: unknown): string | null {
  const text = typeof value === 'string' ? value : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }
  try {
    const parsed = new Date(`${text}T00:00:00.000Z`);
    return parsed.toISOString().slice(0, 10) === text ? text : null;
  } catch (_error) {
    return null;
  }
}

function safeFailureDetail(error: unknown, reason: FailureReason, sqlstate: string) {
  if (error instanceof HttpError) {
    return error.message.slice(0, 500);
  }
  if (sqlstate) {
    return `Database operation failed with SQLSTATE ${sqlstate}.`;
  }
  return reason === 'server_error'
    ? 'Unexpected reservation creation failure.'
    : 'Reservation request rejected.';
}
