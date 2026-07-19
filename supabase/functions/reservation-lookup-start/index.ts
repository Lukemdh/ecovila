import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, readJson } from '../_shared/http.ts';
import { sendSms } from '../_shared/providers.ts';
import {
  assertValidPhone,
  composeLookupCodeSms,
  createLookupCode,
  getClientIp,
  hashLookupCode,
  LOOKUP_CODE_TTL_MINUTES,
  minutesFromNow,
  normalizeSmsLanguage,
  todayIso,
} from '../_shared/reservationManage.ts';
import { EXCLUDE_LIVE_HOLDS_FILTER } from '../_shared/reservations.ts';
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
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  or(filters: string): QueryBuilder<T>;
  single(): Promise<QueryResult<T>>;
};

type LookupCodeInsertRow = {
  id: string;
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

    // Per-phone (existing, ADR-059) and per-IP (ADR-060). Either tripping returns
    // the rateLimited shape the browser already handles — it stops the guest on
    // the phone step with a wait message instead of advancing to a code step that
    // can never verify.
    const [recentCount, ipAllowed] = await Promise.all([
      countRecentLookupAttempts(client, phone),
      enforceRateLimit(client, RATE_LIMITS.lookupStartIp, rateLimitIp(request)),
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

    const lookupId = data.id;
    const codeHash = await hashLookupCode(lookupId, code);
    const { error: updateError } = await client
      .from('reservation_lookup_codes')
      .update({ code_hash: codeHash })
      .eq('id', lookupId);

    if (updateError) throw new Error(updateError.message);

    const hasReservations = await hasActiveReservations(client, phone);
    if (hasReservations) {
      await sendSms({ to: phone, message: composeLookupCodeSms(code, language) });
    }

    // `hasReservations` lets the browser stop the guest on the phone step with a
    // clear "no reservation for this number" message instead of advancing to a
    // code step when no SMS was ever sent. Note: this reveals whether a phone has
    // a booking (enumeration trade-off accepted by the product owner).
    return jsonResponse(
      {
        ok: true,
        lookupId,
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

async function countRecentLookupAttempts(client: SupabaseClient, phone: string) {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count, error } = await table(client, 'reservation_lookup_codes')
    .select('id', { count: 'exact', head: true })
    .eq('phone', phone)
    .gte('created_at', since);

  if (error) throw new Error(error.message);
  return count || 0;
}

async function hasActiveReservations(client: SupabaseClient, phone: string) {
  const { count, error } = await table(client, 'reservations')
    .select('id', { count: 'exact', head: true })
    .eq('guest_phone', phone)
    .in('payment_status', ['pending', 'paid'])
    .is('cancelled_at', null)
    // Same filter as reservation-lookup-verify: if only verification hid live
    // holds, this counter would send an OTP and then show an empty list.
    .or(EXCLUDE_LIVE_HOLDS_FILTER)
    .gte('check_out', todayIso());

  if (error) throw new Error(error.message);
  return Boolean(count);
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
