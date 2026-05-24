import { handleCors } from '../_shared/cors.ts';
import {
  assertMethod,
  errorResponse,
  jsonResponse,
  readJson,
  requireStaffRole,
} from '../_shared/http.ts';
import { sendSms } from '../_shared/providers.ts';

Deno.serve(async (request) => {
  const cors = handleCors(request);
  if (cors) {
    return cors;
  }

  try {
    assertMethod(request, ['POST']);
    requireStaffRole(request, ['diana']);
    const body = await readJson(request);
    const result = await sendSms({
      to: String(body?.to || ''),
      message: String(body?.message || ''),
    });

    return jsonResponse({ ok: true, result });
  } catch (error) {
    return errorResponse(error);
  }
});
