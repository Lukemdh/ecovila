import { optionalEnv } from './env.ts';

export const DEFAULT_ALLOWED_ORIGINS = [
  'https://ecovila.md',
  'https://www.ecovila.md',
  'https://admin.ecovila.md',
  'null',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

export const corsHeaders = {
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, x-supabase-api-version, apikey, content-type, x-ecovila-secret, x-signature, x-signature-timestamp',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export type CorsOptions = {
  allowedOrigins?: string[];
};

export function allowedCorsOrigins() {
  const configured = optionalEnv('ECOVILA_ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

export function getCorsHeaders(request?: Request, options: CorsOptions = {}) {
  const allowedOrigins = options.allowedOrigins || allowedCorsOrigins();
  const origin = request?.headers.get('origin') || '';
  const headers = {
    ...corsHeaders,
    Vary: 'Origin',
  };

  if (!origin || !allowedOrigins.includes(origin)) {
    return headers;
  }

  return {
    ...headers,
    'Access-Control-Allow-Origin': origin,
  };
}

export function handleCors(request: Request, options: CorsOptions = {}) {
  if (request.method !== 'OPTIONS') {
    return null;
  }

  return new Response('ok', {
    status: 200,
    headers: getCorsHeaders(request, options),
  });
}

export function withCors(headers?: HeadersInit, request?: Request, options: CorsOptions = {}) {
  return {
    ...getCorsHeaders(request, options),
    ...(headers || {}),
  };
}
