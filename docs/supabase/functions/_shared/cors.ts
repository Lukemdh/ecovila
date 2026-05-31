export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, x-supabase-api-version, apikey, content-type, x-ecovila-secret, x-signature, x-signature-timestamp',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export type CorsOptions = {
  allowedOrigins?: string[];
};

export function getCorsHeaders(request?: Request, options: CorsOptions = {}) {
  const allowedOrigins = options.allowedOrigins || [];
  const origin = request?.headers.get('origin') || '';

  if (!allowedOrigins.length) {
    return corsHeaders;
  }

  return {
    ...corsHeaders,
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
    Vary: 'Origin',
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
