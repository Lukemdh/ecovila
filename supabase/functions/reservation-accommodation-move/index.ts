import { handleCors } from '../_shared/cors.ts';
import { getSiteUrl } from '../_shared/env.ts';
import {
  assertMethod,
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireStaffRole,
} from '../_shared/http.ts';
import { normalizeEmailLang, reservationAccommodationMoveSms } from '../_shared/notifications.ts';
import { sendSms } from '../_shared/providers.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReservationContext = {
  id: string;
  booking_group_id: string | null;
  guest_phone: string;
  guest_language: string | null;
};

type MoveRpcRow = {
  room_number?: number | string | null;
  room_type?: string | null;
  payment_link_id?: string | null;
};

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type RpcClient = SupabaseClient & {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<SupabaseQueryResult<unknown>>;
};

export async function handler(request: Request) {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    await requireStaffRole(request, ['diana']);

    const body = await readJson(request);
    const reservationId = requiredUuid(body?.reservationId, 'reservationId');
    const expectedSourceRoomId = requiredUuid(
      body?.expectedSourceRoomId ?? body?.sourceRoomId,
      'expectedSourceRoomId',
    );
    const targetRoomId = requiredUuid(body?.targetRoomId, 'targetRoomId');
    if (expectedSourceRoomId === targetRoomId) {
      throw new HttpError(400, 'Source and target accommodations must be different.');
    }

    const amount = optionalAmount(body?.amount);
    const paymentRail = amount === null ? null : requiredRail(body?.paymentRail);
    const expiresInHours = amount === null ? null : normalizeExpiry(body?.expiresInHours);
    const label = amount === null ? null : normalizeLabel(body?.label);
    const now = new Date();
    const expiresAt = expiresInHours === null
      ? null
      : new Date(now.getTime() + expiresInHours * 60 * 60 * 1000).toISOString();

    const client = createServiceClient();
    const reservation = await loadReservationContext(client, reservationId);
    const { data, error } = await (client as RpcClient).rpc('move_reservation_accommodation', {
      p_reservation_id: reservationId,
      p_expected_source_room_id: expectedSourceRoomId,
      p_target_room_id: targetRoomId,
      p_amount: amount,
      p_payment_rail: paymentRail,
      p_expires_at: expiresAt,
      p_label: label,
      p_now: now.toISOString(),
    });
    if (error) throw error;

    const moved = firstRpcRow(data);
    const roomNumber = numberOrNull(moved.room_number);
    const roomType = String(moved.room_type || '').trim();
    const linkId = moved.payment_link_id || null;
    let smsSent = false;
    let smsError: string | null = null;

    if (body?.notify === true) {
      try {
        if (!roomType) throw new Error('Target accommodation type is missing.');
        await sendSms({
          to: reservation.guest_phone,
          message: reservationAccommodationMoveSms({
            language: normalizeEmailLang(reservation.guest_language),
            roomType,
          }),
        });
        smsSent = true;
      } catch (error) {
        smsError = error instanceof Error ? error.message : 'SMS provider request failed.';
        console.error('Accommodation-move SMS failed', error);
      }
    }

    return jsonResponse(
      {
        ok: true,
        bookingGroupId: reservation.booking_group_id,
        roomNumber,
        roomType,
        linkId,
        // Built here, not in the browser: the CRM may be opened on localhost or a
        // staging host, and a link derived from location.origin would be copied
        // into a guest's chat pointing at a host they cannot reach. Same source of
        // truth as payment-link-admin (ADR-106).
        payUrl: linkId ? `${getSiteUrl()}/plata.html?p=${linkId}` : null,
        smsSent,
        smsError,
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(toMoveHttpError(error), request);
  }
}

if (import.meta.main) Deno.serve(handler);

async function loadReservationContext(
  client: SupabaseClient,
  reservationId: string,
): Promise<ReservationContext> {
  const { data, error } = await table<ReservationContext>(client, 'reservations')
    .select('id, booking_group_id, guest_phone, guest_language')
    .eq('id', reservationId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Could not load the reservation.');
  if (!data) {
    throw new HttpError(
      409,
      'Rezervarea nu mai este activă — a fost anulată sau eliberată între timp. Calendarul se va actualiza.',
    );
  }
  return data;
}

export function toMoveHttpError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (!isQueryError(error)) return error;

  if (error.code === '23P01') {
    return new HttpError(
      409,
      'Cazarea selectată tocmai a fost ocupată pentru aceste date. Reîncearcă.',
    );
  }
  if (error.code === 'P0002') {
    return new HttpError(
      409,
      'Rezervarea nu mai este activă — a fost anulată sau eliberată între timp. Calendarul se va actualiza.',
    );
  }
  if (error.code === 'P0001') {
    const message = String(error.message || '');
    if (message.includes('paid reservation')) {
      return new HttpError(409, 'Diferența poate fi facturată numai pentru o rezervare achitată.');
    }
    if (message.includes('different room type')) {
      return new HttpError(409, 'Diferența poate fi emisă numai la schimbarea tipului de cazare.');
    }
    if (message.includes('Target accommodation is inactive')) {
      return new HttpError(
        409,
        'Cazarea selectată nu mai este activă. Actualizează calendarul și reîncearcă.',
      );
    }
    if (message.includes('pending reservation change')) {
      return new HttpError(
        409,
        'Rezervarea are o modificare de oaspeți în așteptare. Finalizeaz-o sau anuleaz-o înainte de mutare.',
      );
    }
    return new HttpError(
      409,
      'Mutarea nu poate fi efectuată în starea actuală. Actualizează calendarul și reîncearcă.',
    );
  }

  return error;
}

function firstRpcRow(data: unknown): MoveRpcRow {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    throw new Error('Accommodation move returned no result.');
  }
  return row as MoveRpcRow;
}

function requiredUuid(value: unknown, field: string): string {
  const id = String(value || '').trim();
  if (!UUID_PATTERN.test(id)) {
    throw new HttpError(400, `${field} must be a valid UUID.`);
  }
  return id;
}

function optionalAmount(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) {
    throw new HttpError(400, 'amount must be an integer between 1 and 1000000.');
  }
  return amount;
}

function requiredRail(value: unknown): 'mia' | 'card' {
  const rail = String(value || '').trim().toLowerCase();
  if (rail !== 'mia' && rail !== 'card') {
    throw new HttpError(400, 'paymentRail must be mia or card.');
  }
  return rail;
}

function normalizeExpiry(value: unknown): null | 1 | 3 | 8 {
  if (value === undefined || value === null || value === '') return null;
  const hours = Number(value);
  if (hours !== 1 && hours !== 3 && hours !== 8) {
    throw new HttpError(400, 'expiresInHours must be null, 1, 3, or 8.');
  }
  return hours;
}

function normalizeLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const label = String(value).trim();
  if (!label) return null;
  if (Array.from(label).length > 120) {
    throw new HttpError(400, 'label must be at most 120 characters.');
  }
  return label;
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isQueryError(error: unknown): error is { code?: string; message?: string } {
  return Boolean(error && typeof error === 'object');
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
