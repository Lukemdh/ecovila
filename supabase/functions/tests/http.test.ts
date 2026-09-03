import { assertEquals, assertRejects } from 'std/assert';

Deno.test('errorResponse without detail keeps the legacy JSON body byte-identical', async () => {
  const { errorResponse, HttpError } = await import('../_shared/http.ts');
  const response = errorResponse(new HttpError(409, 'Conflict.'));

  if (response.status !== 409) {
    throw new Error(`Expected status 409, received ${response.status}.`);
  }
  const body = await response.text();
  if (body !== '{"error":"Conflict."}') {
    throw new Error(`Legacy error JSON changed: ${body}`);
  }
});

Deno.test('errorResponse detail carrying an error key cannot override the message', async () => {
  const { errorResponse, HttpError } = await import('../_shared/http.ts');
  const response = errorResponse(
    new HttpError(409, 'Contract error message.', {
      error: 'Detail error should not override.',
      code: 'test_code',
    }),
  );

  assertEquals(response.status, 409);
  const body = await response.json();
  assertEquals(body.error, 'Contract error message.');
  assertEquals(body.code, 'test_code');
});

function jwtWithPayload(payload: Record<string, unknown>) {
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.forged`;
}

function base64Url(value: string) {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

Deno.test('requireStaffRole rejects forged role claims when verification fails', async () => {
  const { HttpError, requireStaffRole } = await import('../_shared/http.ts');
  const requireStaffRoleWithOptions = requireStaffRole as (
    request: Request,
    allowedRoles: string[],
    options: { verifyJwt: () => Promise<never> },
  ) => Promise<string> | string;
  const request = new Request('https://example.functions.supabase.co/functions/v1/send-email', {
    headers: {
      Authorization: `Bearer ${
        jwtWithPayload({
          app_metadata: { role: 'diana' },
        })
      }`,
    },
  });

  await assertRejects(
    () =>
      Promise.resolve(
        requireStaffRoleWithOptions(request, ['diana'], {
          verifyJwt: () => Promise.reject(new HttpError(401, 'Invalid authorization token.')),
        }),
      ),
    HttpError,
    'Invalid authorization token.',
  );
});
