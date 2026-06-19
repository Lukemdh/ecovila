import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import {
  assertValidComplaintCategory,
  hashComplaintSessionToken,
  normalizeComplaintDescription,
  normalizeComplaintLanguage,
} from '../_shared/complaints.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import { assertRateLimit, RATE_LIMITS, rateLimitIp } from '../_shared/rateLimit.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
  single(): Promise<SupabaseQueryResult<T>>;
};

type SessionRow = {
  token_hash: string;
  phone: string;
  expires_at: string;
};

type ReservationRow = {
  id: string;
  guest_first_name: string | null;
};

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);

    const complaintToken = String(body?.complaintToken || '').trim();
    if (!complaintToken) {
      throw new HttpError(401, 'A valid complaint session is required.');
    }

    const category = assertValidComplaintCategory(body?.category);
    const description = normalizeComplaintDescription(body?.description);
    const language = normalizeComplaintLanguage(body?.language);
    const isAnonymous = body?.isAnonymous === true;

    const client = createServiceClient();
    await assertRateLimit(client, RATE_LIMITS.complaintSubmitIp, rateLimitIp(request));

    const session = await findSession(client, complaintToken);
    if (!session || new Date(session.expires_at).getTime() < Date.now()) {
      throw new HttpError(401, 'Your complaint session has expired. Please sign in again.');
    }

    // Fully anonymous: never persist the identity. Otherwise attach the guest's
    // first name and most-recent paid reservation for staff context.
    const identity = isAnonymous
      ? { guest_phone: null, guest_first_name: null, reservation_id: null }
      : await resolveIdentity(client, session.phone);

    const { data, error } = await table<{ id: string }>(client, 'complaints')
      .insert({
        category,
        description,
        is_anonymous: isAnonymous,
        language,
        ...identity,
      })
      .select('id')
      .single();

    if (error) throw new Error(error.message);
    if (!data?.id) throw new Error('Could not record the complaint.');

    await client
      .from('complaint_sessions')
      .update({ last_used_at: new Date().toISOString() })
      .eq('token_hash', session.token_hash);

    return jsonResponse({ ok: true, complaintId: data.id }, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function findSession(client: SupabaseClient, token: string) {
  const tokenHash = await hashComplaintSessionToken(token);
  const { data, error } = await table<SessionRow>(client, 'complaint_sessions')
    .select('token_hash, phone, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function resolveIdentity(client: SupabaseClient, phone: string) {
  const { data, error } = await table<ReservationRow>(client, 'reservations')
    .select('id, guest_first_name')
    .eq('guest_phone', phone)
    .eq('payment_status', 'paid')
    .order('check_in', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return {
    guest_phone: phone,
    guest_first_name: data?.guest_first_name || null,
    reservation_id: data?.id || null,
  };
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
