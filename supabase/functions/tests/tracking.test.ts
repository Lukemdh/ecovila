import { assertEquals, assertNotEquals, assertStringIncludes } from 'std/assert';

Deno.test('tracking hashes email and phone server-side without exposing raw PII in provider payloads', async () => {
  const {
    buildGoogleClickConversion,
    buildMetaConversionEvent,
    hashUserData,
  } = await import('../_shared/tracking.ts');

  const user = await hashUserData({
    email: ' Ana.Example@Example.MD ',
    phone: '+373 60 120 220',
  });
  const meta = buildMetaConversionEvent({
    eventName: 'Purchase',
    eventId: 'evt_123',
    eventSourceUrl: 'https://ecovila.md/confirmare.html',
    value: 3100,
    currency: 'MDL',
    userData: user,
  });
  const google = buildGoogleClickConversion({
    customerId: '1234567890',
    conversionActionId: '987654321',
    eventId: 'evt_123',
    conversionDateTime: '2026-06-03 12:00:00+03:00',
    value: 3100,
    currency: 'MDL',
    userData: user,
  });
  const serialized = JSON.stringify({ meta, google });

  assertEquals(user.emailHash?.length, 64);
  assertEquals(user.phoneHash?.length, 64);
  assertNotEquals(user.emailHash, 'ana.example@example.md');
  assertNotEquals(user.phoneHash, '37360120220');
  assertStringIncludes(serialized, 'Purchase');
  assertStringIncludes(serialized, 'MDL');
  assertStringIncludes(serialized, 'evt_123');
  assertEquals(serialized.includes('Ana.Example'), false);
  assertEquals(serialized.includes('+373'), false);
  assertEquals(serialized.includes('060120220'), false);
});
