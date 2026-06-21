import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import {
  assertValidComplaintCategory,
  composeCasutaDescription,
  normalizeComplaintDescription,
  normalizeComplaintLanguage,
  normalizeComplaintRoom,
  normalizeOptionalPhone,
} from '../_shared/complaints.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import { assertRateLimit, RATE_LIMITS, rateLimitIp } from '../_shared/rateLimit.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
  single(): Promise<SupabaseQueryResult<T>>;
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

    const category = assertValidComplaintCategory(body?.category);
    const language = normalizeComplaintLanguage(body?.language);

    // Validate the guest's own text first (1..2000), then prefix the cabin number
    // for casuta reports so staff read "Căsuța <n> — …" with no extra column.
    let description = normalizeComplaintDescription(body?.description);
    if (category === 'casuta') {
      const room = normalizeComplaintRoom(body?.roomNumber);
      if (!room) {
        throw new HttpError(400, 'A cabin number is required for a căsuța complaint.');
      }
      description = composeCasutaDescription(room, description);
    }

    const client = createServiceClient();
    // The complaint form is now unauthenticated, so the per-IP bucket is the only
    // gate against spam — keep it ahead of the insert.
    await assertRateLimit(client, RATE_LIMITS.complaintSubmitIp, rateLimitIp(request));

    // An optional follow-up phone is the only identity the guest may leave. When it
    // matches a paid reservation we also attach the first name + booking so staff
    // can call back; no phone => a fully unattributed report.
    const phone = normalizeOptionalPhone(body?.phone);
    const identity = phone
      ? await resolveIdentity(client, phone)
      : { guest_phone: null, guest_first_name: null, reservation_id: null };

    const { data, error } = await table<{ id: string }>(client, 'complaints')
      .insert({
        category,
        description,
        is_anonymous: false,
        language,
        ...identity,
      })
      .select('id')
      .single();

    if (error) throw new Error(error.message);
    if (!data?.id) throw new Error('Could not record the complaint.');

    return jsonResponse({ ok: true, complaintId: data.id }, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});

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
