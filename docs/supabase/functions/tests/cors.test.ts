import { assertEquals } from 'std/assert';
import { getCorsHeaders } from '../_shared/cors.ts';

function requestFrom(origin: string) {
  return new Request('https://example.functions.supabase.co/functions/v1/create-reservation', {
    headers: { Origin: origin },
  });
}

function withAllowedOrigins(value: string | null, test: () => void) {
  const previous = Deno.env.get('ECOVILA_ALLOWED_ORIGINS');

  try {
    if (value === null) {
      Deno.env.delete('ECOVILA_ALLOWED_ORIGINS');
    } else {
      Deno.env.set('ECOVILA_ALLOWED_ORIGINS', value);
    }

    test();
  } finally {
    if (previous === undefined) {
      Deno.env.delete('ECOVILA_ALLOWED_ORIGINS');
    } else {
      Deno.env.set('ECOVILA_ALLOWED_ORIGINS', previous);
    }
  }
}

function headerValue(headers: Record<string, string | undefined>, name: string) {
  return headers[name];
}

Deno.test('getCorsHeaders echoes known EcoVila origins by default', () => {
  withAllowedOrigins(null, () => {
    const headers = getCorsHeaders(requestFrom('https://ecovila.md'));

    assertEquals(headerValue(headers, 'Access-Control-Allow-Origin'), 'https://ecovila.md');
    assertEquals(headerValue(headers, 'Vary'), 'Origin');
  });
});

Deno.test('getCorsHeaders does not grant wildcard access to unknown origins', () => {
  withAllowedOrigins(null, () => {
    const headers = getCorsHeaders(requestFrom('https://example.invalid'));

    assertEquals(headerValue(headers, 'Access-Control-Allow-Origin'), undefined);
    assertEquals(headerValue(headers, 'Vary'), 'Origin');
  });
});

Deno.test('getCorsHeaders accepts comma-separated origins from ECOVILA_ALLOWED_ORIGINS', () => {
  withAllowedOrigins('https://preview.ecovila.md, http://localhost:9000', () => {
    const previewHeaders = getCorsHeaders(requestFrom('https://preview.ecovila.md'));
    const defaultHeaders = getCorsHeaders(requestFrom('https://ecovila.md'));

    assertEquals(
      headerValue(previewHeaders, 'Access-Control-Allow-Origin'),
      'https://preview.ecovila.md',
    );
    assertEquals(headerValue(defaultHeaders, 'Access-Control-Allow-Origin'), undefined);
  });
});
