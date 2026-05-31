import { handleCors } from '../_shared/cors.ts';
import {
  assertMethod,
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireStaffRole,
} from '../_shared/http.ts';
import { refundMaibPayment } from '../_shared/maib.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    requireStaffRole(request, ['diana']);

    const body = await readJson(request);
    const payId = requiredString(body?.payId, 'payId is required.');
    const amount = Number(body?.amount);
    const reason = requiredString(body?.reason, 'reason is required.').slice(0, 500);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, 'amount must be a positive number.');
    }

    const client = createServiceClient();
    const payment = await findPayment(client, payId);
    const providerPayId = payment?.provider_payment_id || payId;
    const refund = await refundMaibPayment(providerPayId, amount, reason);
    const now = new Date().toISOString();
    const { error } = await client
      .from('maib_payments')
      .update({
        status: 'refunded',
        refund_payload: refund,
        refunded_at: now,
        updated_at: now,
      })
      .eq('pay_id', payment?.pay_id || payId);

    if (error) {
      throw new Error(error.message);
    }

    return jsonResponse({ ok: true, result: refund?.result || refund });
  } catch (error) {
    return errorResponse(error);
  }
});

async function findPayment(client: any, payId: string) {
  const { data, error } = await client
    .from('maib_payments')
    .select('pay_id, provider_payment_id')
    .or(`pay_id.eq.${payId},provider_payment_id.eq.${payId}`)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

function requiredString(value: unknown, message: string) {
  const text = String(value || '').trim();
  if (!text) {
    throw new HttpError(400, message);
  }
  return text;
}
