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
import { complaintStaffAlertSms } from '../_shared/notifications.ts';
import { sendSms } from '../_shared/providers.ts';
import { optionalEnv } from '../_shared/env.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

// Staff phones alerted the moment a new problem is submitted (ADR-097). Baked-in
// defaults so it works with no extra config; override with a comma-separated
// ECOVILA_COMPLAINT_SMS secret if the numbers change. Best-effort — a failed or
// unconfigured SMS never blocks the recorded complaint.
const DEFAULT_COMPLAINT_SMS_RECIPIENTS = ['+37369669638', '+37369899799'];

function complaintSmsRecipients(): string[] {
  const configured = optionalEnv('ECOVILA_COMPLAINT_SMS')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^\+[1-9]\d{9,14}$/.test(value));
  return configured.length ? configured : DEFAULT_COMPLAINT_SMS_RECIPIENTS;
}

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
    const room = category === 'casuta' ? normalizeComplaintRoom(body?.roomNumber) : '';
    if (category === 'casuta') {
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

    // Alert staff by SMS. Awaited (so the edge runtime doesn't drop it after the
    // response) but non-fatal — Promise.allSettled means a bad number or provider
    // hiccup never fails the already-recorded complaint.
    await notifyStaffOfComplaint(category, room, identity.guest_phone);

    return jsonResponse({ ok: true, complaintId: data.id }, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function notifyStaffOfComplaint(category: string, room: string, phone: string | null) {
  const recipients = complaintSmsRecipients();
  const message = complaintStaffAlertSms({ category, roomNumber: room, phone });
  const results = await Promise.allSettled(
    recipients.map((to) => sendSms({ to, message })),
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error('Complaint staff SMS failed', {
        to: recipients[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
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
