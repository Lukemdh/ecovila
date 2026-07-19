import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import { groupReservations, hashManageToken } from '../_shared/reservationManage.ts';
import { assertRateLimit, RATE_LIMITS, rateLimitIp } from '../_shared/rateLimit.ts';
import { EXCLUDE_LIVE_HOLDS_FILTER } from '../_shared/reservations.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { ReservationGroupRow } from '../_shared/reservationManage.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  or(filters: string): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type ManageTokenRow = {
  phone: string;
  expires_at: string;
};

type PrimaryReservationRow = {
  booking_group_id: string;
};

type ReservationDetailRow = ReservationGroupRow & {
  booking_group_id: string;
  check_in: string;
  check_out: string;
  room_id?: string | null;
  guest_first_name?: string | null;
  guest_last_name?: string | null;
  guest_phone?: string | null;
  guest_email?: string | null;
  guest_language?: string | null;
  adults?: number | string | null;
  kids_ages?: unknown[] | null;
  cash_expires_at?: string | null;
  cash_extended?: boolean | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
};

type MaibPaymentRow = {
  pay_id?: string | null;
  provider_payment_id?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  payment_rail?: string | null;
  status?: string | null;
  refunded_at?: string | null;
};

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const token = String(body?.manageToken || '').trim();
    const reservationId = String(body?.reservationId || '').trim();

    if (!token || !reservationId) {
      throw new HttpError(400, 'manageToken and reservationId are required.');
    }

    const client = createServiceClient();
    // Token-gated; an IP cap blunts token-guessing / DB-probe floods (ADR-060).
    await assertRateLimit(client, RATE_LIMITS.manageActionIp, rateLimitIp(request));
    const manageToken = await validateManageToken(client, token);
    const reservations = await findReservationGroup(client, reservationId, manageToken.phone);

    if (!reservations.length) {
      throw new HttpError(404, 'Reservation was not found.');
    }

    const payment = await findMaibPayment(client, reservations[0].booking_group_id);

    return jsonResponse(
      {
        ok: true,
        reservation: groupReservations(reservations)[0],
        reservations,
        payment,
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function validateManageToken(client: SupabaseClient, token: string) {
  const tokenHash = await hashManageToken(token);
  const { data, error } = await table<ManageTokenRow>(client, 'reservation_manage_tokens')
    .select('phone, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data || new Date(data.expires_at).getTime() < Date.now()) {
    throw new HttpError(401, 'Invalid or expired manage token.');
  }

  await table(client, 'reservation_manage_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('token_hash', tokenHash);

  return data;
}

async function findReservationGroup(client: SupabaseClient, reservationId: string, phone: string) {
  const { data: primary, error: primaryError } = await table<PrimaryReservationRow>(
    client,
    'reservations',
  )
    .select('booking_group_id')
    .eq('id', reservationId)
    .eq('guest_phone', phone)
    // A manage token is phone-scoped, so filtering the OTP list alone would
    // still let a token holder open a live staff hold by its id. Internal
    // blocks are invisible to the guest on every rail (ADR-100).
    .or(EXCLUDE_LIVE_HOLDS_FILTER)
    .maybeSingle();

  if (primaryError) throw new Error(primaryError.message);
  if (!primary) return [];

  const { data, error } = await table<ReservationDetailRow[]>(client, 'reservations')
    .select(
      'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, adults, kids_ages, total_price, payment_type, payment_status, cash_expires_at, cash_extended, created_at, cancelled_at, cancellation_reason, rooms(number, type)',
    )
    .eq('booking_group_id', primary.booking_group_id)
    .eq('guest_phone', phone)
    .order('check_in', { ascending: true });

  if (error) throw new Error(error.message);
  return data || [];
}

async function findMaibPayment(client: SupabaseClient, bookingGroupId: string) {
  const { data, error } = await table<MaibPaymentRow>(client, 'maib_payments')
    .select('pay_id, provider_payment_id, amount, currency, payment_rail, status, refunded_at')
    .eq('booking_group_id', bookingGroupId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
