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

Deno.test('getMaibCallbackAmount reads the captured amount from known payload fields', async () => {
  const { getMaibCallbackAmount } = await import('../_shared/maib.ts');

  assertEquals(getMaibCallbackAmount({ amount: 3100 }), 3100);
  assertEquals(getMaibCallbackAmount({ amount: '3100.50' }), 3100.5);
  assertEquals(getMaibCallbackAmount({ orderAmount: 2600 }), 2600);
  assertEquals(getMaibCallbackAmount({ result: { amount: 1800 } }), 1800);
  assertEquals(getMaibCallbackAmount({ amount: 'not-a-number' }), null);
  assertEquals(getMaibCallbackAmount({}), null);
});

Deno.test('buildMaibMiaQrPayload builds a dynamic fixed-amount MIA QR request', async () => {
  const { buildMaibMiaQrPayload } = await import('../_shared/maib.ts');

  assertEquals(
    buildMaibMiaQrPayload({
      amount: 3100,
      orderId: '00000000-0000-4000-8000-000000000001',
      description: 'EcoVila reservation 00000000-0000-4000-8000-000000000001',
      callbackUrl: 'https://project.supabase.co/functions/v1/maib-mia-callback',
      expiresAt: '2026-06-17T10:05:00.000Z',
    }),
    {
      type: 'Dynamic',
      amountType: 'Fixed',
      amount: 3100,
      currency: 'MDL',
      orderId: '00000000-0000-4000-8000-000000000001',
      description: 'EcoVila reservation 00000000-0000-4000-8000-000000000001',
      callbackUrl: 'https://project.supabase.co/functions/v1/maib-mia-callback',
      expiresAt: '2026-06-17T10:05:00.000Z',
    },
  );
});

Deno.test('normalizeMaibMiaPaymentStatus maps MIA payment states', async () => {
  const { normalizeMaibMiaPaymentStatus, isMaibMiaPaymentExecuted } = await import(
    '../_shared/maib.ts'
  );

  assertEquals(normalizeMaibMiaPaymentStatus({ status: 'Executed' }), 'paid');
  assertEquals(normalizeMaibMiaPaymentStatus({ status: 'Declined' }), 'failed');
  assertEquals(normalizeMaibMiaPaymentStatus({ status: 'Cancelled' }), 'cancelled');
  assertEquals(normalizeMaibMiaPaymentStatus({ status: 'Pending' }), 'pending');
  assertEquals(normalizeMaibMiaPaymentStatus({}), 'pending');
  assertEquals(isMaibMiaPaymentExecuted({ status: 'Executed' }), true);
  assertEquals(isMaibMiaPaymentExecuted({ status: 'Pending' }), false);
});

Deno.test('getMaibMiaCallback* helpers read flat and nested ids', async () => {
  const { getMaibMiaCallbackOrderId, getMaibMiaCallbackQrId } = await import('../_shared/maib.ts');

  assertEquals(getMaibMiaCallbackOrderId({ orderId: 'order-1' }), 'order-1');
  assertEquals(getMaibMiaCallbackOrderId({ result: { orderId: 'order-2' } }), 'order-2');
  assertEquals(getMaibMiaCallbackOrderId({}), '');
  assertEquals(getMaibMiaCallbackQrId({ qrId: 'qr-1' }), 'qr-1');
  assertEquals(getMaibMiaCallbackQrId({ result: { qrId: 'qr-2' } }), 'qr-2');
});

Deno.test('createMaibMiaQr posts a dynamic QR body and parses the result', async () => {
  const { createMaibMiaQr } = await import('../_shared/maib.ts');
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetcher = ((url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : null });

    if (href.endsWith('/v2/auth/token')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, result: { accessToken: 'tok', tokenType: 'Bearer' } }),
          { status: 200 },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            qrId: 'qr-1',
            orderId: 'group-1',
            url: 'https://mia-qr.bnm.md/1/m/BNM/AGR',
            expiresAt: '2026-06-17T10:05:00.000Z',
          },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const result = await createMaibMiaQr(
    {
      amount: 3100,
      orderId: 'group-1',
      description: 'EcoVila reservation group-1',
      callbackUrl: 'https://x/functions/v1/maib-mia-callback',
      expiresAt: '2026-06-17T10:05:00.000Z',
    },
    { fetcher, baseUrl: 'https://api.test', clientId: 'id', clientSecret: 'secret' },
  );

  assertEquals(result.qrId, 'qr-1');
  assertEquals(result.url, 'https://mia-qr.bnm.md/1/m/BNM/AGR');

  const qrCall = calls.find((call) => call.url.endsWith('/v2/mia/qr'));
  assertEquals((qrCall?.body as Record<string, unknown>)?.type, 'Dynamic');
  assertEquals((qrCall?.body as Record<string, unknown>)?.amountType, 'Fixed');
  assertEquals((qrCall?.body as Record<string, unknown>)?.orderId, 'group-1');
});

Deno.test('getMaibMiaPaymentByOrderId prefers the executed payment attempt', async () => {
  const { getMaibMiaPaymentByOrderId } = await import('../_shared/maib.ts');
  const fetcher = ((url: string | URL) => {
    const href = String(url);
    if (href.endsWith('/v2/auth/token')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, result: { accessToken: 'tok', tokenType: 'Bearer' } }),
          { status: 200 },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            totalCount: 2,
            items: [
              {
                payId: 'p-pending',
                status: 'Pending',
                amount: 3100,
                currency: 'MDL',
                orderId: 'g',
                qrId: 'qr',
              },
              {
                payId: 'p-exec',
                status: 'Executed',
                amount: 3100,
                currency: 'MDL',
                orderId: 'g',
                qrId: 'qr',
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const payment = await getMaibMiaPaymentByOrderId('g', {
    fetcher,
    baseUrl: 'https://api.test',
    clientId: 'id',
    clientSecret: 'secret',
  });

  assertEquals(payment?.payId, 'p-exec');
  assertEquals(payment?.status, 'Executed');
  assertEquals(payment?.amount, 3100);
});
