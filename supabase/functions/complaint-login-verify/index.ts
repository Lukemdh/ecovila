import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import { LOOKUP_MAX_ATTEMPTS, minutesFromNow } from '../_shared/reservationManage.ts';
import {
  COMPLAINT_SESSION_TTL_MINUTES,
  createComplaintSessionToken,
  hashComplaintCode,
  hashComplaintSessionToken,
  normalizeComplaintCode,
} from '../_shared/complaints.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import { assertRateLimit, RATE_LIMITS, rateLimitIp } from '../_shared/rateLimit.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): Promise<SupabaseQueryResult>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type LoginCodeRow = {
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
    const loginId = String(body?.loginId || '').trim();
    const code = normalizeComplaintCode(body?.code);

    if (!loginId || code.length !== 4) {
      throw new HttpError(400, 'loginId and a 4-digit code are required.');
    }

    const client = createServiceClient();
    await assertRateLimit(client, RATE_LIMITS.complaintLoginVerifyIp, rateLimitIp(request));
    const login = await findLogin(client, loginId);

    if (!login || new Date(login.expires_at).getTime() < Date.now()) {
      throw new HttpError(401, 'Invalid or expired verification code.');
    }

    if (Number(login.attempts || 0) >= LOOKUP_MAX_ATTEMPTS) {
      throw new HttpError(429, 'Too many verification attempts.');
    }

    const expectedHash = await hashComplaintCode(loginId, code);
    if (expectedHash !== login.code_hash) {
      await client
        .from('reservation_lookup_codes')
        .update({ attempts: Number(login.attempts || 0) + 1 })
        .eq('id', loginId);
      throw new HttpError(401, 'Invalid verification code.');
    }

    await client
      .from('reservation_lookup_codes')
      .update({ verified_at: new Date().toISOString() })
      .eq('id', loginId);

    const complaintToken = createComplaintSessionToken();
    const tokenHash = await hashComplaintSessionToken(complaintToken);
    const { error: sessionError } = await client
      .from('complaint_sessions')
      .insert({
        token_hash: tokenHash,
        phone: login.phone,
        expires_at: minutesFromNow(COMPLAINT_SESSION_TTL_MINUTES),
      });

    if (sessionError) throw new Error(sessionError.message);

    return jsonResponse({ ok: true, complaintToken }, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function findLogin(client: SupabaseClient, loginId: string) {
  const { data, error } = await table<LoginCodeRow>(client, 'reservation_lookup_codes')
    .select('id, phone, code_hash, attempts, expires_at')
    .eq('id', loginId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
