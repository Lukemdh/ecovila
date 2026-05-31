import { assertEquals } from 'std/assert';

Deno.test('verifyMaibCallbackSignature validates raw body HMAC and replay window', async () => {
  const { createMaibCallbackSignature, verifyMaibCallbackSignature } = await import(
    '../_shared/maib.ts'
  );
  const rawBody =
    '{"checkoutId":"checkout-a","paymentId":"payment-a","paymentStatus":"Executed","orderId":"order-a"}';
  const timestamp = '1761032516817';
  const key = 'signature-key';
  const signature = await createMaibCallbackSignature(rawBody, timestamp, key);
  const headers = new Headers({
    'X-Signature': `sha256=${signature}`,
    'X-Signature-Timestamp': timestamp,
  });

  assertEquals(
    await verifyMaibCallbackSignature(rawBody, headers, key, {
      now: Number(timestamp) + 60_000,
      toleranceMs: 5 * 60_000,
    }),
    true,
  );
  assertEquals(
    await verifyMaibCallbackSignature(`${rawBody} `, headers, key, {
      now: Number(timestamp) + 60_000,
      toleranceMs: 5 * 60_000,
    }),
    false,
  );
  assertEquals(
    await verifyMaibCallbackSignature(rawBody, headers, key, {
      now: Number(timestamp) + 6 * 60_000,
      toleranceMs: 5 * 60_000,
    }),
    false,
  );
});

Deno.test('normalizeMaibCallbackStatus accepts Maib zero processing codes as paid', async () => {
  const {
    getMaibCallbackStatus,
    isMaibCallbackApproved,
    normalizeMaibCallbackStatus,
  } = await import('../_shared/maib.ts');
  const sandboxCallback = {
    checkoutId: '670ff6f5-21ea-423d-83eb-88d507371df0',
    paymentId: '49d55bbb-c8eb-49a7-8fe8-33e921f8261f',
    orderId: 'e9a964a1-6c0c-4c94-89c6-06c409ca2cc9',
    paymentStatus: 'Executed',
    processingStatus: 'OK',
    processingStatusCode: '000',
    paymentMethod: 'Card',
  };

  assertEquals(
    normalizeMaibCallbackStatus({
      ...sandboxCallback,
      processingStatusCode: '00',
    }),
    'paid',
  );
  assertEquals(normalizeMaibCallbackStatus(sandboxCallback), 'paid');
  assertEquals(getMaibCallbackStatus(sandboxCallback), 'paid');
  assertEquals(isMaibCallbackApproved(sandboxCallback), true);
});

Deno.test('normalizeMaibCallbackStatus does not fail unknown or non-terminal callbacks', async () => {
  const { normalizeMaibCallbackStatus } = await import('../_shared/maib.ts');

  assertEquals(normalizeMaibCallbackStatus({ paymentStatus: 'Failed' }), 'failed');
  assertEquals(normalizeMaibCallbackStatus({ paymentStatus: 'Cancelled' }), 'cancelled');
  assertEquals(normalizeMaibCallbackStatus({ paymentStatus: 'Canceled' }), 'cancelled');
  assertEquals(normalizeMaibCallbackStatus({ paymentStatus: 'Initialized' }), 'pending');
  assertEquals(
    normalizeMaibCallbackStatus({
      paymentStatus: 'Executed',
      processingStatus: 'OK',
      processingStatusCode: '05',
    }),
    'pending',
  );
});

Deno.test('buildMaibCheckoutPayload maps EcoVila booking context to Checkout v2 body', async () => {
  const { buildMaibCheckoutPayload } = await import('../_shared/maib.ts');

  assertEquals(
    buildMaibCheckoutPayload({
      amount: 3100,
      bookingGroupId: '00000000-0000-4000-8000-000000000001',
      description: 'EcoVila reservation 00000000-0000-4000-8000-000000000001',
      guestEmail: 'ana@example.md',
      guestName: 'Ana Munteanu',
      guestPhone: '+37360123456',
      language: 'ro',
      createdAt: '2026-05-26T00:00:00.000Z',
      callbackUrl: 'https://project.supabase.co/functions/v1/maib-callback',
      successUrl: 'https://ecovila.md/confirmare.html?id=reservation-a&payment=success',
      failUrl: 'https://ecovila.md/confirmare.html?id=reservation-a&payment=failed',
      ip: '203.0.113.10',
      userAgent: 'Unit Test',
    }),
    {
      amount: 3100,
      currency: 'MDL',
      orderInfo: {
        id: '00000000-0000-4000-8000-000000000001',
        description: 'EcoVila reservation 00000000-0000-4000-8000-000000000001',
        date: '2026-05-26T00:00:00.000Z',
        orderAmount: 3100,
        orderCurrency: 'MDL',
        deliveryAmount: null,
        deliveryCurrency: null,
        items: [
          {
            externalId: 'ecovila-booking',
            title: 'EcoVila reservation 00000000-0000-4000-8000-000000000001',
            amount: 3100,
            currency: 'MDL',
            quantity: 1,
            displayOrder: 1,
          },
        ],
      },
      payerInfo: {
        name: 'Ana Munteanu',
        email: 'ana@example.md',
        phone: '+37360123456',
        ip: '203.0.113.10',
        userAgent: 'Unit Test',
      },
      language: 'ro',
      callbackUrl: 'https://project.supabase.co/functions/v1/maib-callback',
      successUrl: 'https://ecovila.md/confirmare.html?id=reservation-a&payment=success',
      failUrl: 'https://ecovila.md/confirmare.html?id=reservation-a&payment=failed',
    },
  );
});

Deno.test('buildMaibCheckoutPayload omits empty optional payer fields', async () => {
  const { buildMaibCheckoutPayload } = await import('../_shared/maib.ts');
  const payload = buildMaibCheckoutPayload({
    amount: 2600,
    bookingGroupId: '00000000-0000-4000-8000-000000000001',
    description: 'EcoVila reservation 00000000-0000-4000-8000-000000000001',
    guestEmail: 'ana@example.md',
    guestName: 'Ana Munteanu',
    guestPhone: '+37360123456',
    callbackUrl: 'https://project.supabase.co/functions/v1/maib-callback',
    successUrl: 'https://ecovila.md/confirmare.html?id=reservation-a&payment=success',
    failUrl: 'https://ecovila.md/confirmare.html?id=reservation-a&payment=failed',
  });

  assertEquals(Object.hasOwn(payload.payerInfo, 'ip'), false);
  assertEquals(Object.hasOwn(payload.payerInfo, 'userAgent'), false);
});
