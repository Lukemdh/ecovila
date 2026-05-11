import { withCors } from './cors.ts';
import { requiredEnv } from './env.ts';

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: withCors({
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    }),
  });
}

export function errorResponse(error: unknown) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Unexpected server error.';

  return jsonResponse({ error: message }, { status });
}

export function assertMethod(request: Request, methods: string[]) {
  if (!methods.includes(request.method)) {
    throw new HttpError(405, `Method ${request.method} is not allowed.`);
  }
}

export async function readJson(request: Request) {
  try {
    return await request.json();
  } catch (_error) {
    throw new HttpError(400, 'Expected a valid JSON request body.');
  }
}

export function requireSharedSecret(request: Request, envName = 'ECOVILA_CRON_SECRET') {
  const expected = requiredEnv(envName);
  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length)
    : '';
  const provided = request.headers.get('x-ecovila-secret') || bearer;

  if (!provided || !constantTimeEqual(provided, expected)) {
    throw new HttpError(401, 'Invalid function secret.');
  }
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return result === 0;
}
