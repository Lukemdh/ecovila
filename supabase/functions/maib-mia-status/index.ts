import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import { reconcileMiaBookingGroup } from '../_shared/miaReconcile.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';

// Browser poll for the MIA QR payment page. Returns the QR url + live payment
// status for a booking group. Keyed by the booking group id, an unguessable
// server-minted UUID; the response exposes only the QR url and a coarse status,
// never guest data. Each call re-confirms payment against MAIB, so a paid guest
// is settled even if they close the tab before the next poll.
Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const bookingGroupId = String(body?.bookingGroupId || '').trim();

    if (!bookingGroupId) {
      throw new HttpError(400, 'bookingGroupId is required.');
    }

    const client = createServiceClient();
    const result = await reconcileMiaBookingGroup(client, bookingGroupId, 'maib-mia-status');

    return jsonResponse(
      {
        ok: true,
        status: result.status,
        qrUrl: result.qrUrl ?? null,
        expiresAt: result.expiresAt ?? null,
        amount: result.amount ?? null,
        currency: result.currency ?? 'MDL',
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});
