import { createClient } from '@supabase/supabase-js';
import { withCors } from './cors.ts';
import { requiredEnv } from './env.ts';

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function jsonResponse(body: unknown, init: ResponseInit = {}, request?: Request) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: withCors({
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    }, request),
  });
}

export function errorResponse(error: unknown, request?: Request) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Unexpected server error.';

  return jsonResponse({ error: message }, { status }, request);
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

type StaffClaims = {
  app_metadata?: {
    role?: unknown;
  } | null;
};

type StaffTokenVerifier = (token: string) => Promise<StaffClaims>;

type StaffRoleOptions = {
  verifyJwt?: StaffTokenVerifier;
};

type StaffAuthClient = {
  auth: {
    getUser(token: string): Promise<{
      data?: {
        user?: {
          app_metadata?: Record<string, unknown> | null;
        } | null;
      } | null;
      error?: {
        message?: string;
      } | null;
    }>;
  };
};

let staffAuthClient: StaffAuthClient | null = null;

export async function requireStaffRole(
  request: Request,
  allowedRoles: string[],
  options: StaffRoleOptions = {},
) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length)
    : '';
  const claims = await (options.verifyJwt || verifyStaffJwt)(token);
  const role = String(claims?.app_metadata?.role || '');

  if (!role || !allowedRoles.includes(role)) {
    throw new HttpError(403, 'Insufficient staff permissions.');
  }

  return role;
}

async function verifyStaffJwt(token: string): Promise<StaffClaims> {
  if (!token) {
    throw new HttpError(401, 'Missing authorization token.');
  }

  const { data, error } = await getStaffAuthClient().auth.getUser(token);

  if (error || !data?.user) {
    throw new HttpError(401, 'Invalid authorization token.');
  }

  return {
    app_metadata: data.user.app_metadata || {},
  };
}

function getStaffAuthClient() {
  if (!staffAuthClient) {
    staffAuthClient = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_ANON_KEY'), {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }

  return staffAuthClient;
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
