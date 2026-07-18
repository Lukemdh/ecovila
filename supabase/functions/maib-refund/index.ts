import { handleCors } from '../_shared/cors.ts';
import {
  assertMethod,
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireStaffRole,
} from '../_shared/http.ts';
import {
  alertRefundProblem,
  attemptBookingRefund,
  findRefundRow,
} from '../_shared/refunds.ts';
import { refundPaidChanges } from '../_shared/reservationChanges.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';

type ServiceClient = ReturnType<typeof createServiceClient>;

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    await requireStaffRole(request, ['diana']);

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

    // A full refund (no custom amount) is a cancellation, so any paid "add
    // guests" differences are reversed too — each as its own MAIB transaction.
    // A partial refund touches only the requested amount.
    const refundDifferences = requestedAmount === null;

    const existing = await findRefundRow(client, payment.pay_id);
    if (existing?.status === 'succeeded') {
      // MAIB allows exactly ONE refund per payment. A retried FULL refund is
      // idempotent (return the recorded result and still settle any outstanding
      // differences), but a new PARTIAL amount after a completed refund cannot
      // ever execute — say so instead of returning a fake success (ADR-088).
      if (requestedAmount !== null) {
        throw new HttpError(
          409,
          'Această plată a fost deja restituită — MAIB permite o singură restituire per plată.',
        );
      }

      const differenceRefunds = await refundPaidChanges(client, refundBookingGroupId, reason);
      return jsonResponse(
        { ok: true, result: existing.response_payload || {}, differenceRefunds },
        {},
        request,
      );
    }

    const outcome = await attemptBookingRefund(client, {
      payId: payment.pay_id,
      providerPayId: payment.provider_payment_id || payment.pay_id,
      bookingGroupId: refundBookingGroupId,
      amount,
      currency: payment.currency || 'MDL',
      reason,
      source: 'maib-refund',
      // Staff pressing "Restituie" is a deliberate decision to pay, even for a
      // scheduled refund they previously aborted (ADR-096/099) — override the
      // 'cancelled' guard that blocks every automatic execution path.
      allowCancelled: true,
    });

    if (!outcome.ok) {
      // Unconfirmed (declined, non-OK status, or provider error). The row stays
      // unresolved for the reconcile-refunds cron; staff are alerted now.
      await alertRefundProblem(client, {
        payId: payment.pay_id,
        bookingGroupId: refundBookingGroupId,
        amount,
        reason,
        detail: outcome.error ||
          `Răspuns MAIB fără confirmare (status: ${outcome.providerStatus || 'necunoscut'}).`,
        source: 'maib-refund',
      }).catch((alertError) => console.error('Refund alert failed', alertError));

      return jsonResponse(
        {
          ok: false,
          pending: true,
          providerStatus: outcome.providerStatus || null,
          error: outcome.error || null,
          message:
            'Restituirea nu s-a confirmat încă — sistemul o reîncearcă automat la 30 de minute.',
        },
        {},
        request,
      );
    }

    const differenceRefunds = refundDifferences
      ? await refundPaidChanges(client, refundBookingGroupId, reason)
      : [];

    return jsonResponse(
      {
        ok: true,
        result: (outcome.payload as Record<string, unknown>)?.result || outcome.payload,
        alreadyRefunded: Boolean(outcome.alreadyRefunded),
        differenceRefunds,
      },
      {},
      request,
    );
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
    .eq('pay_id', input.payId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (data) {
    return data;
  }

  const { data: byProviderId, error: providerError } = await client
    .from('maib_payments')
    .select('pay_id, provider_payment_id, booking_group_id, amount, currency, status, refunded_at')
    .eq('provider_payment_id', input.payId)
    .maybeSingle();

  if (providerError) {
    throw new Error(providerError.message);
  }

  return byProviderId;
}

function optionalString(value: unknown) {
  const text = String(value || '').trim();
  return text || '';
}
