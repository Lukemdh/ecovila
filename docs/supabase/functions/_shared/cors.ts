export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-ecovila-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function handleCors(request: Request) {
  if (request.method !== 'OPTIONS') {
    return null;
  }

  return new Response('ok', {
    status: 200,
    headers: corsHeaders,
  });
}

export function withCors(headers?: HeadersInit) {
  return {
    ...corsHeaders,
    ...(headers || {}),
  };
}
