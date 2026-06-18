import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import {
  findChangeById,
  reconcileMiaChange,
  storedChangeStatus,
} from '../_shared/reservationChanges.ts';

// Browser poll for the "add guests" difference payment, keyed by the change id
// (an unguessable server-minted UUID). For MIA it re-confirms against MAIB and
// applies the party change on payment; for card it returns the stored status
// (the card callback applies). The response carries only a coarse status, the
// QR url and the amount — never guest data.
Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const changeId = String(body?.changeId || '').trim();

    if (!changeId) {
      throw new HttpError(400, 'changeId is required.');
    }

    const client = createServiceClient();
    const change = await findChangeById(client, changeId);

    if (!change) {
      return jsonResponse({ ok: true, status: 'not_found' }, {}, request);
    }

    if (change.payment_rail === 'mia') {
      const result = await reconcileMiaChange(client, changeId, 'change-status');
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
    }

    return jsonResponse(
      {
        ok: true,
        status: storedChangeStatus(change),
        qrUrl: change.checkout_url ?? null,
        expiresAt: change.expires_at ?? null,
        amount: change.difference_amount ?? null,
        currency: 'MDL',
      },
      {},
      request,
    );
  } catch (error) {
    return errorResponse(error, request);
  }
});
