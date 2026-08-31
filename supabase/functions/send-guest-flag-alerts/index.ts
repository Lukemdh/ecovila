import { handleCors } from '../_shared/cors.ts';
import { getSiteUrl, optionalEnv } from '../_shared/env.ts';
import { sweepGuestFlagAlerts } from '../_shared/guestFlagAlerts.ts';
import { assertMethod, errorResponse, jsonResponse, requireSharedSecret } from '../_shared/http.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST', 'GET']);
    requireSharedSecret(request);

    const recipient = optionalEnv('ECOVILA_GUEST_FLAG_EMAIL').trim() ||
      optionalEnv('ECOVILA_ALERT_EMAIL').trim();
    if (!recipient) {
      console.error('Guest flag alert recipient is not configured.');
      return jsonResponse({ skipped: true }, {}, request);
    }

    const summary = await sweepGuestFlagAlerts(createServiceClient(), {
      recipient,
      siteUrl: getSiteUrl(),
    });
    return jsonResponse(summary, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});
