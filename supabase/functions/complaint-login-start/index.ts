import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, readJson } from '../_shared/http.ts';
import { sendSms } from '../_shared/providers.ts';
import {
  assertValidPhone,
  composeLookupCodeSms,
  createLookupCode,
  getClientIp,
  LOOKUP_CODE_TTL_MINUTES,
  minutesFromNow,
  normalizeSmsLanguage,
} from '../_shared/reservationManage.ts';
import { hashComplaintCode } from '../_shared/complaints.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';
import { enforceRateLimit, RATE_LIMITS, rateLimitIp } from '../_shared/rateLimit.ts';

type QueryResult<T = unknown> = SupabaseQueryResult<T> & {
  count?: number | null;
};

type QueryBuilder<T = unknown> = PromiseLike<QueryResult<T>> & {
  select(columns: string, options?: Record<string, unknown>): QueryBuilder<T>;
  insert(payload: unknown): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  gte(column: string, value: unknown): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  single(): Promise<QueryResult<T>>;
};

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const phone = assertValidPhone(body?.phone);
    const language = normalizeSmsLanguage(body?.language);
    const client = createServiceClient();

    // Per-phone (mirrors reservation-lookup-start) + per-IP. Either tripping
    // returns the rateLimited shape the browser already handles — it stops the
    // guest on the phone step instead of advancing to a code step.
    const [recentCount, ipAllowed] = await Promise.all([
      countRecentLoginAttempts(client, phone),
      enforceRateLimit(client, RATE_LIMITS.complaintLoginStartIp, rateLimitIp(request)),
    ]);

    if (recentCount >= 5 || !ipAllowed) {
      return jsonResponse({ ok: true, rateLimited: true }, {}, request);
    }

    const code = createLookupCode();
    const expiresAt = minutesFromNow(LOOKUP_CODE_TTL_MINUTES);
    const { data, error } = await client
      .from('reservation_lookup_codes')
      .insert({
        phone,
        code_hash: '',
        expires_at: expiresAt,
        ip_address: getClientIp(request),
        user_agent: request.headers.get('user-agent') || '',
      })
      .select('id')
      .single();

    if (error) throw new Error(error.message);

    const loginId = data.id;
    const codeHash = await hashComplaintCode(loginId, code);
    const { error: updateError } = await client
      .from('reservation_lookup_codes')
      .update({ code_hash: codeHash })
      .eq('id', loginId);

    if (updateError) throw new Error(updateError.message);

    // Only real guests (a phone with at least one PAID reservation, any date)
    // can leave a complaint. hasReservations lets the browser stop with a clear
    // "no reservation for this number" message and no SMS is sent otherwise.
    // Note: like the reservation lookup, this reveals whether a phone is a guest
    // (enumeration trade-off accepted by the product owner).
    const hasReservations = await hasPaidReservation(client, phone);
    if (hasReservations) {
      await sendSms({ to: phone, message: composeLookupCodeSms(code, language) });
    }

    return jsonResponse(
      {
        ok: true,
        loginId,
        hasReservations,
        expiresInSeconds: LOOKUP_CODE_TTL_MINUTES * 60,
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function countRecentLoginAttempts(client: SupabaseClient, phone: string) {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count, error } = await table(client, 'reservation_lookup_codes')
    .select('id', { count: 'exact', head: true })
    .eq('phone', phone)
    .gte('created_at', since);

  if (error) throw new Error(error.message);
  return count || 0;
}

async function hasPaidReservation(client: SupabaseClient, phone: string) {
  const { count, error } = await table(client, 'reservations')
    .select('id', { count: 'exact', head: true })
    .eq('guest_phone', phone)
    .eq('payment_status', 'paid');

  if (error) throw new Error(error.message);
  return Boolean(count);
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
