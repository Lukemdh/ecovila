import { assertRejects } from 'std/assert';

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
