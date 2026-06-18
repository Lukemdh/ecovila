import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse } from '../_shared/http.ts';
import {
  getMaibMiaCallbackOrderId,
  getMaibMiaCallbackQrId,
  parseMaibCallback,
} from '../_shared/maib.ts';
import { reconcileMiaBookingGroup } from '../_shared/miaReconcile.ts';
import {
  findChangeById,
  findChangeByPayId,
  reconcileMiaChange,
} from '../_shared/reservationChanges.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

const CHANGE_ORDER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type BookingGroupRow = { booking_group_id: string };

// MAIB notifies us a MIA QR was paid. We do NOT trust the payload (no signature
// key in play): it only tells us *which* order to re-check, and
// reconcileMiaBookingGroup re-reads the authoritative status from MAIB before
// settling anything.
Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    const rawBody = await request.text();
    const payload = parseMaibCallback(rawBody) as Record<string, unknown>;

    const client = createServiceClient();
    const orderId = getMaibMiaCallbackOrderId(payload);
    const qrId = getMaibMiaCallbackQrId(payload);

    // A "add guests" MIA difference is tracked in reservation_changes (order id
    // = change id, qr id = its pay_id). Route it to the change reconcile, which
    // re-reads MAIB and applies the party change once paid.
    const change = await resolveMiaChange(client, orderId, qrId);
    if (change) {
      const result = await reconcileMiaChange(client, change.id, 'maib-mia-callback');
      console.info('MIA change callback processed', {
        changeId: change.id,
        status: result.status,
        applied: Boolean(result.applied),
        amountMismatch: Boolean(result.amountMismatch),
      });
      return jsonResponse(
        { ok: true, status: result.status, applied: Boolean(result.applied) },
        {},
        request,
      );
    }

    let bookingGroupId = orderId;

    if (!bookingGroupId && qrId) {
      bookingGroupId = await bookingGroupIdForQr(client, qrId);
    }

    if (!bookingGroupId) {
      throw new HttpError(400, 'Missing MIA order or qr id.');
    }

    const result = await reconcileMiaBookingGroup(client, bookingGroupId, 'maib-mia-callback');
    console.info('MIA callback processed', {
      bookingGroupId,
      status: result.status,
      matched: result.matched ?? 0,
      amountMismatch: Boolean(result.amountMismatch),
      requiresManualReview: Boolean(result.requiresManualReview),
    });

    return jsonResponse(
      { ok: true, status: result.status, matched: result.matched ?? 0 },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});

async function resolveMiaChange(client: SupabaseClient, orderId: string, qrId: string) {
  if (orderId && CHANGE_ORDER_ID_RE.test(orderId)) {
    const byId = await findChangeById(client, orderId);
    if (byId && byId.payment_rail === 'mia') return byId;
  }
  if (qrId) {
    const byPay = await findChangeByPayId(client, qrId);
    if (byPay && byPay.payment_rail === 'mia') return byPay;
  }
  return null;
}

async function bookingGroupIdForQr(client: SupabaseClient, qrId: string) {
  // For MIA rows the QR id is stored as the primary key pay_id.
  const { data, error } = await (client.from('maib_payments') as QueryBuilder<BookingGroupRow>)
    .select('booking_group_id')
    .eq('pay_id', qrId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data?.booking_group_id || '';
}
