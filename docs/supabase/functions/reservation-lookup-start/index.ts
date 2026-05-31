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
  todayIso,
} from '../_shared/reservationManage.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const phone = assertValidPhone(body?.phone);
    const client = createServiceClient();
    const recentCount = await countRecentLookupAttempts(client, phone);

    if (recentCount >= 5) {
      return jsonResponse({ ok: true, rateLimited: true });
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
      await sendSms({ to: phone, message: composeLookupCodeSms(code) });
    }

    return jsonResponse({
      ok: true,
      lookupId,
      expiresInSeconds: LOOKUP_CODE_TTL_MINUTES * 60,
    });
  } catch (error) {
    return errorResponse(error);
  }
});

async function countRecentLookupAttempts(client: any, phone: string) {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count, error } = await client
    .from('reservation_lookup_codes')
    .select('id', { count: 'exact', head: true })
    .eq('phone', phone)
    .gte('created_at', since);

  if (error) throw new Error(error.message);
  return count || 0;
}

async function hasActiveReservations(client: any, phone: string) {
  const { count, error } = await client
    .from('reservations')
    .select('id', { count: 'exact', head: true })
    .eq('guest_phone', phone)
    .in('payment_status', ['pending', 'paid'])
    .is('cancelled_at', null)
    .gte('check_out', todayIso());

  if (error) throw new Error(error.message);
  return Boolean(count);
}
