import { handleCors } from '../_shared/cors.ts';
import { assertMethod, errorResponse, jsonResponse, readJson } from '../_shared/http.ts';
import { dispatchTrackingEvent, hashUserData } from '../_shared/tracking.ts';

const ALLOWED_EVENTS = new Set([
  'PageView',
  'ViewContent',
  'Search',
  'InitiateCheckout',
  'AddPaymentInfo',
  'Lead',
]);

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const eventName = String(body?.eventName || '').trim();

    if (!ALLOWED_EVENTS.has(eventName)) {
      return jsonResponse({ ok: true, skipped: true, reason: 'unsupported-event' }, {}, request);
    }

    if (!body?.consent?.marketing) {
      return jsonResponse({ ok: true, skipped: true, reason: 'no-consent' }, {}, request);
    }

    const eventId = String(body?.eventId || crypto.randomUUID()).trim();
    const userData = await hashUserData({
      email: body?.email,
      phone: body?.phone,
    });

    const result = await dispatchTrackingEvent({
      eventName,
      eventId,
      eventSourceUrl: sanitizeSourceUrl(body?.eventSourceUrl),
      value: Number.isFinite(Number(body?.value)) ? Number(body.value) : null,
      currency: String(body?.currency || 'MDL'),
      fbp: optionalString(body?.fbp),
      fbc: optionalString(body?.fbc),
      userAgent: request.headers.get('User-Agent') || '',
      userData,
    });

    return jsonResponse({ ok: true, eventName, eventId, result }, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});

function optionalString(value: unknown) {
  return String(value || '').trim() || undefined;
}

function sanitizeSourceUrl(value: unknown) {
  try {
    const url = new URL(String(value || 'https://ecovila.md/'));
    return `${url.origin}${url.pathname}`;
  } catch (_error) {
    return 'https://ecovila.md/';
  }
}
