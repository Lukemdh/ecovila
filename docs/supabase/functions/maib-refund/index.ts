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

type ServiceClient = ReturnType<typeof createServiceClient>;

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    requireStaffRole(request, ['diana']);

    const body = await readJson(request);
    const payId = optionalString(body?.payId);
    const bookingGroupId = optionalString(body?.bookingGroupId);
    const requestedAmount =
      body?.amount === undefined || body?.amount === null || body?.amount === ''
        ? null
        : Number(body?.amount);
    const reason = (optionalString(body?.reason) || 'crm_cancellation').slice(0, 500);

    if (!payId && !bookingGroupId) {
      throw new HttpError(400, 'payId or bookingGroupId is required.');
    }

    if (requestedAmount !== null && (!Number.isFinite(requestedAmount) || requestedAmount <= 0)) {
      throw new HttpError(400, 'amount must be a positive number.');
    }

    const client = createServiceClient();
    const payment = await findPayment(client, { payId, bookingGroupId });

    if (!payment) {
      throw new HttpError(404, 'MAIB payment was not found.');
    }

    const amount = requestedAmount ?? Number(payment.amount || 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, 'amount must be a positive number.');
    }

    const refundBookingGroupId = payment.booking_group_id || bookingGroupId;

    if (!refundBookingGroupId) {
      throw new HttpError(409, 'Payment is missing a booking group.');
    }

    const existing = await findExistingRefund(client, payment.pay_id);
    if (existing?.status === 'succeeded') {
      return jsonResponse({ ok: true, result: existing.response_payload || {} }, {}, request);
    }

    await upsertRefundRequest(client, {
      payId: payment.pay_id,
      bookingGroupId: refundBookingGroupId,
      amount,
      currency: payment.currency || 'MDL',
      reason,
    });

    const providerPayId = payment.provider_payment_id || payment.pay_id;

    let refund;
    try {
      refund = await refundMaibPayment(providerPayId, amount, reason);
    } catch (error) {
      await markRefundFailed(client, payment.pay_id, error);
      throw error;
    }

    const now = new Date().toISOString();
    const providerRefundId = String(refund?.result?.refundId || refund?.refundId || '').trim() ||
      null;

    const { error: refundError } = await client
      .from('maib_refunds')
      .update({
        status: 'succeeded',
        response_payload: refund,
        provider_refund_id: providerRefundId,
        error_message: null,
        updated_at: now,
      })
      .eq('pay_id', payment.pay_id);

    if (refundError) {
      throw new Error(refundError.message);
    }

    const { error: paymentError } = await client
      .from('maib_payments')
      .update({
        status: 'refunded',
        refund_payload: refund,
        refunded_at: now,
        updated_at: now,
      })
      .eq('pay_id', payment.pay_id);

    if (paymentError) {
      throw new Error(paymentError.message);
    }

    return jsonResponse({ ok: true, result: refund?.result || refund }, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function findPayment(
  client: ServiceClient,
  input: { payId?: string; bookingGroupId?: string },
) {
  if (input.bookingGroupId) {
    const { data, error } = await client
      .from('maib_payments')
      .select(
        'pay_id, provider_payment_id, booking_group_id, amount, currency, status, refunded_at',
      )
      .eq('booking_group_id', input.bookingGroupId)
      .in('status', ['paid', 'refunded'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    return data;
  }

  const { data, error } = await client
    .from('maib_payments')
    .select('pay_id, provider_payment_id, booking_group_id, amount, currency, status, refunded_at')
    .or(`pay_id.eq.${input.payId},provider_payment_id.eq.${input.payId}`)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function findExistingRefund(client: ServiceClient, payId: string) {
  const { data, error } = await client
    .from('maib_refunds')
    .select('status, response_payload')
    .eq('pay_id', payId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function upsertRefundRequest(
  client: ServiceClient,
  input: {
    payId: string;
    bookingGroupId: string;
    amount: number;
    currency: string;
    reason: string;
  },
) {
  const now = new Date().toISOString();
  const { error } = await client
    .from('maib_refunds')
    .upsert({
      pay_id: input.payId,
      booking_group_id: input.bookingGroupId,
      amount: input.amount,
      currency: input.currency,
      status: 'requested',
      reason: input.reason,
      request_payload: { amount: input.amount, reason: input.reason, source: 'crm' },
      updated_at: now,
    }, { onConflict: 'pay_id' });

  if (error) {
    throw new Error(error.message);
  }
}

async function markRefundFailed(client: ServiceClient, payId: string, error: unknown) {
  const { error: updateError } = await client
    .from('maib_refunds')
    .update({
      status: 'failed',
      error_message: error instanceof Error ? error.message : 'Refund failed.',
      updated_at: new Date().toISOString(),
    })
    .eq('pay_id', payId);

  if (updateError) {
    throw new Error(updateError.message);
  }
}

function optionalString(value: unknown) {
  const text = String(value || '').trim();
  return text || '';
}
