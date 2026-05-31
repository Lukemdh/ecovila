import { handleCors } from '../_shared/cors.ts';
import {
  assertMethod,
  errorResponse,
  jsonResponse,
  readJson,
  requireStaffRole,
} from '../_shared/http.ts';
import { sendEmail } from '../_shared/providers.ts';

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    requireStaffRole(request, ['diana']);
    const body = await readJson(request);
    const result = await sendEmail({
      to: body?.to,
      subject: String(body?.subject || ''),
      html: String(body?.html || ''),
      text: body?.text ? String(body.text) : undefined,
    });

    return jsonResponse({ ok: true, result }, {}, request);
  } catch (error) {
    return errorResponse(error, request);
  }
});
