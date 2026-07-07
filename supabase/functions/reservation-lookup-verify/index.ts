import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import {
  createManageToken,
  groupReservations,
  hashLookupCode,
  hashManageToken,
  LOOKUP_MAX_ATTEMPTS,
  MANAGE_TOKEN_TTL_MINUTES,
  minutesFromNow,
  normalizeLookupCode,
  todayIso,
} from '../_shared/reservationManage.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import { assertRateLimit, RATE_LIMITS, rateLimitIp } from '../_shared/rateLimit.ts';
import type { ReservationGroupRow } from '../_shared/reservationManage.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): Promise<SupabaseQueryResult>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  gte(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type LookupCodeRow = {
  id: string;
  phone: string;
  code_hash: string;
  attempts?: number | string | null;
  expires_at: string;
};

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const lookupId = String(body?.lookupId || '').trim();
    const code = normalizeLookupCode(body?.code);

    if (!lookupId || code.length !== 4) {
      throw new HttpError(400, 'lookupId and a 4-digit code are required.');
    }

    const client = createServiceClient();
    // Per-lookupId brute force is capped at 5 below; this bounds how many codes
    // one IP can churn through across lookupIds (ADR-060).
    await assertRateLimit(client, RATE_LIMITS.lookupVerifyIp, rateLimitIp(request));
    const lookup = await findLookup(client, lookupId);

    if (!lookup || new Date(lookup.expires_at).getTime() < Date.now()) {
      throw new HttpError(401, 'Invalid or expired verification code.');
    }

    if (Number(lookup.attempts || 0) >= LOOKUP_MAX_ATTEMPTS) {
      throw new HttpError(429, 'Too many verification attempts.');
    }

    const expectedHash = await hashLookupCode(lookupId, code);
    if (expectedHash !== lookup.code_hash) {
      await client
        .from('reservation_lookup_codes')
        .update({ attempts: Number(lookup.attempts || 0) + 1 })
        .eq('id', lookupId);
      throw new HttpError(401, 'Invalid verification code.');
    }

    // Consume the code: claiming verified_at only while it is still null makes
    // the code single-use, so a correct code cannot be replayed within its TTL
    // to mint additional manage tokens (ADR-090). The .is() filter also makes
    // two concurrent submissions race safely — exactly one wins.
    const { data: claimed, error: claimError } = await table<Array<{ id: string }>>(
      client,
      'reservation_lookup_codes',
    )
      .update({ verified_at: new Date().toISOString() })
      .eq('id', lookupId)
      .is('verified_at', null)
      .select('id');

    if (claimError) throw new Error(claimError.message);
    if (!claimed || !claimed.length) {
      throw new HttpError(401, 'Invalid or expired verification code.');
    }

    const token = createManageToken();
    const tokenHash = await hashManageToken(token);
    const { error: tokenError } = await client
      .from('reservation_manage_tokens')
      .insert({
        token_hash: tokenHash,
        phone: lookup.phone,
        expires_at: minutesFromNow(MANAGE_TOKEN_TTL_MINUTES),
      });

    if (tokenError) throw new Error(tokenError.message);

    const reservations = await findActiveReservations(client, lookup.phone);

    return jsonResponse(
      {
        ok: true,
        manageToken: token,
        reservations: groupReservations(reservations),
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function findLookup(client: SupabaseClient, lookupId: string) {
  const { data, error } = await table<LookupCodeRow>(client, 'reservation_lookup_codes')
    .select('id, phone, code_hash, attempts, expires_at')
    .eq('id', lookupId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function findActiveReservations(client: SupabaseClient, phone: string) {
  const { data, error } = await table<ReservationGroupRow[]>(client, 'reservations')
    .select(
      'id, booking_group_id, guest_phone, check_in, check_out, total_price, payment_type, payment_status, created_at, cancelled_at, rooms(number, type)',
    )
    .eq('guest_phone', phone)
    .in('payment_status', ['pending', 'paid'])
    .is('cancelled_at', null)
    .gte('check_out', todayIso())
    .order('check_in', { ascending: true });

  if (error) throw new Error(error.message);
  return data || [];
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
