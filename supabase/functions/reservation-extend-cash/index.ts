import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import { hashManageToken } from '../_shared/reservationManage.ts';
import { assertRateLimit, RATE_LIMITS, rateLimitIp } from '../_shared/rateLimit.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type ManageTokenRow = {
  phone: string;
  expires_at: string;
};

type CashReservationRow = {
  booking_group_id: string;
  cash_expires_at?: string | null;
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
    const primary = await findCashReservation(client, reservationId, manageToken.phone);

    if (!primary?.cash_expires_at) {
      throw new HttpError(404, 'Cash reservation was not found.');
    }

    const newExpiry = new Date(new Date(primary.cash_expires_at).getTime() + 30 * 60 * 1000)
      .toISOString();
    const { data, error } = await table<CashReservationRow[]>(client, 'reservations')
      .update({
        cash_expires_at: newExpiry,
        cash_extended: true,
      })
      .eq('booking_group_id', primary.booking_group_id)
      .eq('guest_phone', manageToken.phone)
      .eq('payment_type', 'cash')
      .eq('payment_status', 'pending')
      .eq('cash_extended', false)
      .gt('cash_expires_at', new Date().toISOString())
      .is('cancelled_at', null)
      .select('cash_expires_at');

    if (error) throw new Error(error.message);
    if (!data?.length) {
      throw new HttpError(409, 'Cash reservation cannot be extended.');
    }

    return jsonResponse(
      {
        ok: true,
        cash_expires_at: data[0].cash_expires_at || newExpiry,
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

async function findCashReservation(client: SupabaseClient, reservationId: string, phone: string) {
  const { data, error } = await table<CashReservationRow>(client, 'reservations')
    .select('booking_group_id, cash_expires_at')
    .eq('id', reservationId)
    .eq('guest_phone', phone)
    .eq('payment_type', 'cash')
    .eq('payment_status', 'pending')
    .eq('cash_extended', false)
    .gt('cash_expires_at', new Date().toISOString())
    .is('cancelled_at', null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
