import { assert, assertEquals } from 'std/assert';
import {
  buildMaibCheckoutPayload,
  cancelMaibCheckout,
  getMaibCheckout,
  normalizeMaibCheckoutStatus,
} from '../_shared/maib.ts';
import {
  findPaymentLinkAttemptForCallback,
  findPaymentLinkAttemptForCallbackFailOpen,
  type PaymentLinkAttemptRow,
  type PaymentLinkRow,
  reconcilePaymentLinkAttempt,
  settlePaymentLinkAttempt,
} from '../_shared/paymentLinks.ts';
import {
  CARD_SESSION_MINUTES,
  handleStart,
  handleStatus,
  publicStatus,
  waitForReusableAttempt,
} from '../payment-link-public/index.ts';
import {
  effectiveStatus,
  listLinks,
  markRefunded,
  revokeLink,
} from '../payment-link-admin/index.ts';
import { RATE_LIMITS } from '../_shared/rateLimit.ts';

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const LINK_ID = '22222222-2222-4222-8222-222222222222';

function attempt(overrides: Partial<PaymentLinkAttemptRow> = {}): PaymentLinkAttemptRow {
  return {
    id: ATTEMPT_ID,
    payment_link_id: LINK_ID,
    amount: 875,
    currency: 'MDL',
    payment_rail: 'card',
    pay_id: 'checkout-1',
    provider_payment_id: null,
    status: 'pending',
    checkout_url: 'https://pay.test/checkout-1',
    provider_payload: {},
    expires_at: '2026-08-26T12:15:00.000Z',
    processed_at: null,
    manual_review: false,
    created_at: '2026-08-26T12:00:00.000Z',
    updated_at: '2026-08-26T12:00:00.000Z',
    ...overrides,
  };
}

function link(overrides: Partial<PaymentLinkRow> = {}): PaymentLinkRow {
  return {
    id: LINK_ID,
    amount: 875,
    currency: 'MDL',
    payment_rail: 'card',
    label: 'Avans eveniment',
    status: 'active',
    expires_at: '2026-08-26T13:00:00.000Z',
    paid_at: null,
    paid_amount: null,
    revoked_at: null,
    settled_attempt_id: null,
    refunded_at: null,
    refunded_amount: null,
    refund_note: null,
    manual_review: false,
    created_at: '2026-08-26T12:00:00.000Z',
    updated_at: '2026-08-26T12:00:00.000Z',
    ...overrides,
  };
}

type MemoryState = {
  links: PaymentLinkRow[];
  attempts: PaymentLinkAttemptRow[];
};

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
type RpcHandler = (
  fn: string,
  args: Record<string, unknown>,
  state: MemoryState,
) => RpcResult | Promise<RpcResult> | undefined;

function memoryPaymentClient(state: MemoryState, rpcHandler?: RpcHandler) {
  return {
    from(tableName: string) {
      const source = tableName === 'payment_links' ? state.links : state.attempts;
      const filters: Array<(row: object) => boolean> = [];
      let limit = Infinity;
      let orderColumn = '';
      let orderAscending = true;
      let updatePayload: Record<string, unknown> | null = null;

      const filtered = () => {
        const rows = source.filter((row) => filters.every((filter) => filter(row)));
        if (orderColumn) {
          rows.sort((left, right) => {
            const leftValue = String(rowRecord(left)[orderColumn] ?? '');
            const rightValue = String(rowRecord(right)[orderColumn] ?? '');
            return leftValue.localeCompare(rightValue) * (orderAscending ? 1 : -1);
          });
        }
        return rows.slice(0, limit);
      };

      const execute = () => {
        const rows = filtered();
        if (updatePayload) {
          for (const row of rows) Object.assign(row, updatePayload);
        }
        return Promise.resolve({ data: rows, error: null });
      };

      const chain = {
        select(_columns: string) {
          return chain;
        },
        update(payload: unknown) {
          updatePayload = rowRecord(payload);
          return chain;
        },
        insert(_payload: unknown) {
          throw new Error('insert is not implemented by this payment-link test client');
        },
        eq(column: string, value: unknown) {
          filters.push((row) => rowRecord(row)[column] === value);
          return chain;
        },
        is(column: string, value: unknown) {
          filters.push((row) => rowRecord(row)[column] === value);
          return chain;
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.includes(rowRecord(row)[column]));
          return chain;
        },
        lt(column: string, value: unknown) {
          filters.push((row) => String(rowRecord(row)[column] ?? '') < String(value ?? ''));
          return chain;
        },
        order(column: string, options: Record<string, unknown> = {}) {
          orderColumn = column;
          orderAscending = options.ascending !== false;
          return chain;
        },
        limit(count: number) {
          limit = count;
          return chain;
        },
        async maybeSingle() {
          const result = await execute();
          return { data: result.data[0] ?? null, error: null };
        },
        async single() {
          const result = await execute();
          return { data: result.data[0] ?? null, error: null };
        },
        then<TResult1 = { data: object[]; error: null }, TResult2 = never>(
          onfulfilled?:
            | ((value: { data: object[]; error: null }) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return execute().then(onfulfilled, onrejected);
        },
      };
      return chain;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      const handled = await rpcHandler?.(fn, args, state);
      if (handled) return handled;
      if (fn === 'rate_limit_hit') return { data: true, error: null };
      throw new Error(`Unexpected RPC: ${fn}`);
    },
  };
}

function rowRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

async function withMaibEnvironment<T>(
  fetcher: typeof fetch,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = {
    baseUrl: Deno.env.get('MAIB_BASE_URL'),
    clientId: Deno.env.get('MAIB_CLIENT_ID'),
    clientSecret: Deno.env.get('MAIB_CLIENT_SECRET'),
    supabaseUrl: Deno.env.get('SUPABASE_URL'),
  };
  const previousFetch = globalThis.fetch;
  Deno.env.set('MAIB_BASE_URL', 'https://api.test');
  Deno.env.set('MAIB_CLIENT_ID', 'id');
  Deno.env.set('MAIB_CLIENT_SECRET', 'secret');
  Deno.env.set('SUPABASE_URL', 'https://project.test');
  globalThis.fetch = fetcher;
  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('MAIB_BASE_URL', previous.baseUrl);
    restoreEnv('MAIB_CLIENT_ID', previous.clientId);
    restoreEnv('MAIB_CLIENT_SECRET', previous.clientSecret);
    restoreEnv('SUPABASE_URL', previous.supabaseUrl);
  }
}

function miaFetcher(item: Record<string, unknown>) {
  return ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/v2/auth/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({
          ok: true,
          result: { accessToken: 'token', tokenType: 'Bearer' },
        })),
      );
    }
    if (url.includes('/v2/mia/payments?orderId=')) {
      return Promise.resolve(
        new Response(JSON.stringify({
          ok: true,
          result: { items: [item] },
        })),
      );
    }
    throw new Error(`Unexpected MIA URL: ${url}`);
  }) as typeof fetch;
}

function maibFetcher(
  checkoutResult: Record<string, unknown>,
  options: { checkoutStatus?: number; cancelStatus?: number } = {},
) {
  const calls: Array<{ url: string; method: string; body: BodyInit | null | undefined }> = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = String(init?.method || 'GET');
    calls.push({ url, method, body: init?.body });

    if (url.endsWith('/v2/auth/token')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, result: { accessToken: 'token', tokenType: 'Bearer' } }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith('/cancel')) {
      const status = options.cancelStatus ?? 200;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            status === 200
              ? { ok: true, result: { checkoutId: 'checkout-1', status: 'Cancelled' } }
              : { ok: false, errors: [{ errorMessage: 'terminal checkout' }] },
          ),
          { status },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({ ok: options.checkoutStatus !== 500, result: checkoutResult }),
        { status: options.checkoutStatus ?? 200 },
      ),
    );
  }) as typeof fetch;
  return { fetcher, calls };
}

Deno.test('standalone Checkout payload uses attempt orderId without changing booking defaults', () => {
  const standalone = buildMaibCheckoutPayload({
    amount: 875,
    orderId: ATTEMPT_ID,
    itemExternalId: 'ecovila-payment-link',
    description: 'Plată EcoVila',
    guestEmail: '',
    guestName: '',
    guestPhone: '',
    createdAt: '2026-08-26T12:00:00.000Z',
    callbackUrl: 'https://project.test/functions/v1/maib-callback',
    successUrl: 'https://ecovila.md/plata.html?p=link',
    failUrl: 'https://ecovila.md/plata.html?p=link',
  });
  assertEquals(standalone.orderInfo.id, ATTEMPT_ID);
  assertEquals(standalone.orderInfo.items[0].externalId, 'ecovila-payment-link');
  assertEquals(standalone.payerInfo, {});

  const booking = buildMaibCheckoutPayload({
    amount: 875,
    bookingGroupId: LINK_ID,
    description: 'EcoVila reservation',
    guestEmail: 'ana@example.md',
    guestName: 'Ana Pop',
    guestPhone: '+37360000000',
    createdAt: '2026-08-26T12:00:00.000Z',
    callbackUrl: 'https://project.test/functions/v1/maib-callback',
    successUrl: 'https://ecovila.md/confirmare.html',
    failUrl: 'https://ecovila.md/confirmare.html',
  });
  assertEquals(booking.orderInfo.id, LINK_ID);
  assertEquals(booking.orderInfo.items[0].externalId, 'ecovila-booking');
});

Deno.test('payment-link status and start rate limits match ADR-106', () => {
  assertEquals(RATE_LIMITS.paymentLinkStatusIp, {
    bucket: 'payment-link-status:ip',
    limit: 150,
    windowSeconds: 60,
  });
  assertEquals(RATE_LIMITS.paymentLinkStatusLink, {
    bucket: 'payment-link-status:link',
    limit: 40,
    windowSeconds: 60,
  });
  assertEquals(RATE_LIMITS.paymentLinkStartIp, {
    bucket: 'payment-link-start:ip',
    limit: 20,
    windowSeconds: 600,
  });
  assertEquals(RATE_LIMITS.paymentLinkStartLink, {
    bucket: 'payment-link-start:link',
    limit: 10,
    windowSeconds: 600,
  });
});

Deno.test('getMaibCheckout reads the authoritative Checkout v2 fields', async () => {
  const { fetcher, calls } = maibFetcher({
    checkoutId: 'checkout-1',
    status: 'Completed',
    amount: 875,
    currency: 'MDL',
    order: { id: ATTEMPT_ID },
    payment: { paymentId: 'payment-1', status: 'Executed' },
  });
  const checkout = await getMaibCheckout('checkout-1', {
    fetcher,
    baseUrl: 'https://api.test',
    clientId: 'id',
    clientSecret: 'secret',
  });

  assertEquals(checkout, {
    status: 'Completed',
    amount: 875,
    currency: 'MDL',
    orderId: ATTEMPT_ID,
    paymentId: 'payment-1',
    paymentStatus: 'Executed',
    raw: {
      ok: true,
      result: {
        checkoutId: 'checkout-1',
        status: 'Completed',
        amount: 875,
        currency: 'MDL',
        order: { id: ATTEMPT_ID },
        payment: { paymentId: 'payment-1', status: 'Executed' },
      },
    },
  });
  assertEquals(calls.at(-1)?.url, 'https://api.test/v2/checkouts/checkout-1');
  assertEquals(calls.at(-1)?.method, 'GET');
});

Deno.test('normalizeMaibCheckoutStatus maps documented checkout terminal states', () => {
  assertEquals(normalizeMaibCheckoutStatus({ status: 'Completed', paymentStatus: '' }), 'paid');
  assertEquals(
    normalizeMaibCheckoutStatus({ status: 'Processing', paymentStatus: 'Executed' }),
    'paid',
  );
  assertEquals(
    normalizeMaibCheckoutStatus({ status: 'Cancelled', paymentStatus: '' }),
    'cancelled',
  );
  assertEquals(normalizeMaibCheckoutStatus({ status: 'Expired', paymentStatus: '' }), 'failed');
  assertEquals(normalizeMaibCheckoutStatus({ status: 'Abandoned', paymentStatus: '' }), 'failed');
  assertEquals(normalizeMaibCheckoutStatus({ status: 'Created', paymentStatus: '' }), 'pending');
});

Deno.test('cancelMaibCheckout sends POST with no body and is always best-effort', async () => {
  const success = maibFetcher({});
  assertEquals(
    await cancelMaibCheckout('checkout-1', 'revoked', {
      fetcher: success.fetcher,
      baseUrl: 'https://api.test',
      clientId: 'id',
      clientSecret: 'secret',
    }),
    true,
  );
  assertEquals(success.calls.at(-1), {
    url: 'https://api.test/v2/checkouts/checkout-1/cancel',
    method: 'POST',
    body: undefined,
  });

  const failure = maibFetcher({}, { cancelStatus: 409 });
  const originalError = console.error;
  console.error = () => {};
  try {
    assertEquals(
      await cancelMaibCheckout('checkout-1', 'late', {
        fetcher: failure.fetcher,
        baseUrl: 'https://api.test',
        clientId: 'id',
        clientSecret: 'secret',
      }),
      false,
    );
  } finally {
    console.error = originalError;
  }
});

Deno.test('settlePaymentLinkAttempt forwards the immutable attempt snapshot inputs to the RPC', async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    from() {
      throw new Error('from should not be called');
    },
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: { outcome: 'settled', manualReview: false }, error: null });
    },
  };
  const result = await settlePaymentLinkAttempt(client as never, {
    attemptId: ATTEMPT_ID,
    providerPaymentId: 'payment-1',
    providerAmount: 875,
    providerCurrency: 'MDL',
    providerPayload: { checkout: { status: 'Completed' } },
    now: '2026-08-26T12:05:00.000Z',
  });

  assertEquals(result.outcome, 'settled');
  assertEquals(calls, [{
    fn: 'settle_payment_link_attempt',
    args: {
      p_attempt_id: ATTEMPT_ID,
      p_provider_payment_id: 'payment-1',
      p_provider_amount: 875,
      p_provider_currency: 'MDL',
      p_provider_payload: { checkout: { status: 'Completed' } },
      p_now: '2026-08-26T12:05:00.000Z',
    },
  }]);
});

Deno.test('reconcilePaymentLinkAttempt re-reads MAIB before settling a card capture', async () => {
  const previous = {
    baseUrl: Deno.env.get('MAIB_BASE_URL'),
    clientId: Deno.env.get('MAIB_CLIENT_ID'),
    clientSecret: Deno.env.get('MAIB_CLIENT_SECRET'),
  };
  const previousFetch = globalThis.fetch;
  Deno.env.set('MAIB_BASE_URL', 'https://api.test');
  Deno.env.set('MAIB_CLIENT_ID', 'id');
  Deno.env.set('MAIB_CLIENT_SECRET', 'secret');

  const maib = maibFetcher({
    status: 'Completed',
    amount: 875,
    currency: 'MDL',
    order: { id: ATTEMPT_ID },
    payment: { paymentId: 'payment-1', status: 'Executed' },
  });
  globalThis.fetch = maib.fetcher;
  const rpcCalls: Array<Record<string, unknown>> = [];
  const client = {
    from() {
      throw new Error('from should not be called');
    },
    rpc(_fn: string, args: Record<string, unknown>) {
      rpcCalls.push(args);
      return Promise.resolve({
        data: { outcome: 'settled', manualReview: false, alert: false },
        error: null,
      });
    },
  };

  try {
    const result = await reconcilePaymentLinkAttempt(
      client as never,
      attempt(),
      'unit-test',
    );
    assertEquals(result.status, 'paid');
    assertEquals(result.outcome, 'settled');
    assertEquals(rpcCalls.length, 1);
    assertEquals(rpcCalls[0].p_attempt_id, ATTEMPT_ID);
    assertEquals(rpcCalls[0].p_provider_amount, 875);
    assertEquals(rpcCalls[0].p_provider_currency, 'MDL');
    const payload = rpcCalls[0].p_provider_payload as Record<string, unknown>;
    assertEquals(Object.hasOwn(payload, 'result'), false, 'raw provider dump must not be stored');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('MAIB_BASE_URL', previous.baseUrl);
    restoreEnv('MAIB_CLIENT_ID', previous.clientId);
    restoreEnv('MAIB_CLIENT_SECRET', previous.clientSecret);
  }
});

Deno.test('payment-link MAIB lookup failure leaves the stored attempt untouched for retry', async () => {
  const previous = {
    baseUrl: Deno.env.get('MAIB_BASE_URL'),
    clientId: Deno.env.get('MAIB_CLIENT_ID'),
    clientSecret: Deno.env.get('MAIB_CLIENT_SECRET'),
  };
  const previousFetch = globalThis.fetch;
  const originalError = console.error;
  Deno.env.set('MAIB_BASE_URL', 'https://api.test');
  Deno.env.set('MAIB_CLIENT_ID', 'id');
  Deno.env.set('MAIB_CLIENT_SECRET', 'secret');
  globalThis.fetch = maibFetcher({}, { checkoutStatus: 500 }).fetcher;
  console.error = () => {};
  let rpcCalled = false;
  const client = {
    from() {
      throw new Error('stored attempt must not be updated on lookup failure');
    },
    rpc() {
      rpcCalled = true;
      return Promise.resolve({ data: null, error: null });
    },
  };

  try {
    const result = await reconcilePaymentLinkAttempt(client as never, attempt(), 'unit-test');
    assertEquals(result.status, 'pending');
    assertEquals(rpcCalled, false);
  } finally {
    console.error = originalError;
    globalThis.fetch = previousFetch;
    restoreEnv('MAIB_BASE_URL', previous.baseUrl);
    restoreEnv('MAIB_CLIENT_ID', previous.clientId);
    restoreEnv('MAIB_CLIENT_SECRET', previous.clientSecret);
  }
});

Deno.test('card callback recovers and persists a checkout id missing after process death', async () => {
  const state: MemoryState = {
    links: [link()],
    attempts: [attempt({
      pay_id: null,
      status: 'creating',
      checkout_url: null,
      expires_at: null,
    })],
  };
  const client = memoryPaymentClient(state, (fn, _args, memory) => {
    if (fn !== 'settle_payment_link_attempt') return undefined;
    Object.assign(memory.links[0], {
      status: 'paid',
      paid_at: '2026-08-26T12:05:00.000Z',
      paid_amount: 875,
      settled_attempt_id: ATTEMPT_ID,
    });
    Object.assign(memory.attempts[0], { status: 'paid' });
    return {
      data: { outcome: 'settled', manualReview: false, alert: false },
      error: null,
    };
  });
  const maib = maibFetcher({
    status: 'Completed',
    amount: 875,
    currency: 'MDL',
    order: { id: ATTEMPT_ID },
    payment: { paymentId: 'payment-recovered', status: 'Executed' },
  });

  await withMaibEnvironment(maib.fetcher, async () => {
    const result = await reconcilePaymentLinkAttempt(
      client as never,
      state.attempts[0],
      'maib-callback',
      { checkoutId: 'checkout-recovered' },
    );
    assertEquals(result.status, 'paid');
    assertEquals(state.attempts[0].pay_id, 'checkout-recovered');
    assert(
      maib.calls.some((call) => call.url.endsWith('/v2/checkouts/checkout-recovered')),
    );
  });
});

Deno.test('callback lookup resolves payment links first by provider id and returns null when unmatched', async () => {
  const rows = [attempt()];
  const client = {
    from(table: string) {
      assertEquals(table, 'payment_link_attempts');
      let column = '';
      let value = '';
      const chain = {
        select() {
          return chain;
        },
        eq(nextColumn: string, nextValue: string) {
          column = nextColumn;
          value = nextValue;
          return chain;
        },
        maybeSingle() {
          const row = rows.find((candidate) =>
            String(candidate[column as keyof PaymentLinkAttemptRow] || '') === value
          );
          return Promise.resolve({ data: row || null, error: null });
        },
      };
      return chain;
    },
  };

  const matched = await findPaymentLinkAttemptForCallback(client as never, {
    payId: 'checkout-1',
    orderId: 'not-used',
  });
  assertEquals(matched?.id, ATTEMPT_ID);

  const unmatched = await findPaymentLinkAttemptForCallback(client as never, {
    payId: 'unknown-checkout',
    orderId: 'not-a-uuid',
  });
  assertEquals(unmatched, null);
});

Deno.test('reservation callback still settles when payment-link lookup throws', async () => {
  const client = {
    from() {
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        maybeSingle() {
          return Promise.resolve({
            data: null,
            error: { message: 'payment_link_attempts is not in the schema cache' },
          });
        },
      };
      return chain;
    },
  };
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => errors.push(args);
  let reservationSettled = false;

  try {
    const paymentLinkAttempt = await findPaymentLinkAttemptForCallbackFailOpen(
      client as never,
      { payId: 'reservation-checkout', orderId: LINK_ID },
      'maib-callback',
    );
    if (!paymentLinkAttempt) {
      // This is the callback's existing unmatched branch: reservation/change
      // routing continues after the additive payment-link lookup fails.
      reservationSettled = true;
    }
  } finally {
    console.error = originalError;
  }

  assertEquals(reservationSettled, true);
  assertEquals(errors.length, 1);
});

Deno.test('payment-link display ordering keeps money and in-flight attempts ahead of terminal link state', () => {
  const now = new Date('2026-08-26T14:00:00.000Z');
  const expired = link({ expires_at: '2026-08-26T13:00:00.000Z' });
  const pending = attempt({ expires_at: '2026-08-26T12:15:00.000Z' });

  assertEquals(CARD_SESSION_MINUTES, 30);
  assertEquals(publicStatus(expired, pending, now), 'pending');
  assertEquals(effectiveStatus(expired, pending, now), 'pending');
  assertEquals(publicStatus({ ...expired, status: 'paid' }, pending, now), 'paid');
  assertEquals(
    effectiveStatus({ ...expired, manual_review: true }, pending, now),
    'review',
  );
});

Deno.test('expired link plus pending attempt stays pending when the authoritative lookup fails', async () => {
  const state: MemoryState = {
    links: [link({ expires_at: '2020-01-01T00:00:00.000Z' })],
    attempts: [attempt({ expires_at: '2020-01-01T00:00:00.000Z' })],
  };
  const client = memoryPaymentClient(state);
  const originalError = console.error;
  console.error = () => {};
  try {
    await withMaibEnvironment(
      maibFetcher({}, { checkoutStatus: 500 }).fetcher,
      async () => {
        const response = await handleStatus(
          client as never,
          new Request('https://ecovila.test/status', {
            headers: { 'cf-connecting-ip': '203.0.113.10' },
          }),
          { linkId: LINK_ID },
        );
        assertEquals(response.status, 'pending');
        assertEquals(state.attempts[0].status, 'pending');
      },
    );
  } finally {
    console.error = originalError;
  }
});

Deno.test('late card capture on a revoked link reconciles to review and preserves revokedAt', async () => {
  const revokedAt = '2026-08-26T12:03:00.000Z';
  const state: MemoryState = {
    links: [link({ status: 'revoked', revoked_at: revokedAt })],
    attempts: [attempt({ status: 'cancelled', processed_at: revokedAt })],
  };
  const client = memoryPaymentClient(state, (fn, _args, memory) => {
    if (fn !== 'settle_payment_link_attempt') return undefined;
    Object.assign(memory.links[0], {
      status: 'paid',
      paid_at: '2026-08-26T12:04:00.000Z',
      paid_amount: 875,
      settled_attempt_id: ATTEMPT_ID,
      manual_review: true,
    });
    Object.assign(memory.attempts[0], { status: 'paid', manual_review: true });
    return {
      data: {
        outcome: 'late_capture',
        manualReview: true,
        alert: false,
        linkId: LINK_ID,
        attemptId: ATTEMPT_ID,
      },
      error: null,
    };
  });
  const maib = maibFetcher({
    status: 'Completed',
    amount: 875,
    currency: 'MDL',
    order: { id: ATTEMPT_ID },
    payment: { paymentId: 'payment-late', status: 'Executed' },
  });

  await withMaibEnvironment(maib.fetcher, async () => {
    const response = await handleStatus(
      client as never,
      new Request('https://ecovila.test/status'),
      { linkId: LINK_ID },
    );
    assertEquals(response.status, 'review');
    assertEquals(state.links[0].revoked_at, revokedAt);
  });
});

Deno.test('superseded card attempt on an active link is re-read and flagged as late capture', async () => {
  const now = Date.now();
  const state: MemoryState = {
    links: [link({ expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString() })],
    attempts: [attempt({
      status: 'cancelled',
      expires_at: new Date(now - 60 * 1000).toISOString(),
      processed_at: new Date(now - 60 * 1000).toISOString(),
    })],
  };
  const client = memoryPaymentClient(state, (fn, _args, memory) => {
    if (fn !== 'settle_payment_link_attempt') return undefined;
    Object.assign(memory.links[0], {
      status: 'paid',
      paid_at: new Date().toISOString(),
      paid_amount: 875,
      settled_attempt_id: ATTEMPT_ID,
      manual_review: true,
    });
    Object.assign(memory.attempts[0], { status: 'paid', manual_review: true });
    return {
      data: {
        outcome: 'late_capture',
        manualReview: true,
        alert: false,
        linkId: LINK_ID,
        attemptId: ATTEMPT_ID,
      },
      error: null,
    };
  });
  const maib = maibFetcher({
    status: 'Completed',
    amount: 875,
    currency: 'MDL',
    order: { id: ATTEMPT_ID },
    payment: { paymentId: 'payment-superseded', status: 'Executed' },
  });

  await withMaibEnvironment(maib.fetcher, async () => {
    const response = await handleStatus(
      client as never,
      new Request('https://ecovila.test/status'),
      { attemptId: ATTEMPT_ID },
    );
    assertEquals(response.status, 'review');
    assert(maib.calls.some((call) => call.url.endsWith('/v2/checkouts/checkout-1')));
  });
});

Deno.test('superseded card attempt is still re-read after a sibling paid the link', async () => {
  const otherAttemptId = '33333333-3333-4333-8333-333333333333';
  const now = Date.now();
  const state: MemoryState = {
    links: [link({
      status: 'paid',
      paid_at: new Date(now - 30 * 1000).toISOString(),
      paid_amount: 875,
      settled_attempt_id: otherAttemptId,
    })],
    attempts: [attempt({
      status: 'cancelled',
      expires_at: new Date(now - 60 * 1000).toISOString(),
      processed_at: new Date(now - 60 * 1000).toISOString(),
    })],
  };
  const client = memoryPaymentClient(state, (fn, _args, memory) => {
    if (fn !== 'settle_payment_link_attempt') return undefined;
    Object.assign(memory.links[0], { manual_review: true });
    Object.assign(memory.attempts[0], { status: 'paid', manual_review: true });
    return {
      data: {
        outcome: 'duplicate_capture',
        manualReview: true,
        alert: false,
        linkId: LINK_ID,
        attemptId: ATTEMPT_ID,
        settledAttemptId: otherAttemptId,
      },
      error: null,
    };
  });
  const maib = maibFetcher({
    status: 'Completed',
    amount: 875,
    currency: 'MDL',
    order: { id: ATTEMPT_ID },
    payment: { paymentId: 'payment-duplicate', status: 'Executed' },
  });

  await withMaibEnvironment(maib.fetcher, async () => {
    const response = await handleStatus(
      client as never,
      new Request('https://ecovila.test/status'),
      { attemptId: ATTEMPT_ID },
    );
    assertEquals(response.status, 'review');
    assert(maib.calls.some((call) => call.url.endsWith('/v2/checkouts/checkout-1')));
  });
});

Deno.test('long-dead terminal card attempt is not re-read on every poll', async () => {
  const state: MemoryState = {
    links: [link({ expires_at: '2099-01-01T00:00:00.000Z' })],
    attempts: [attempt({
      status: 'failed',
      expires_at: '2020-01-01T00:00:00.000Z',
      processed_at: '2020-01-01T00:00:00.000Z',
    })],
  };
  let providerCalled = false;

  await withMaibEnvironment(
    ((input: string | URL | Request) => {
      providerCalled = true;
      throw new Error(`Provider must not be called for ${String(input)}`);
    }) as typeof fetch,
    async () => {
      const response = await handleStatus(
        memoryPaymentClient(state) as never,
        new Request('https://ecovila.test/status'),
        { attemptId: ATTEMPT_ID },
      );
      assertEquals(response.status, 'active');
      assertEquals(providerCalled, false);
    },
  );
});

Deno.test('MIA reconciliation uses normalized amount and defaults omitted currency to MDL', async () => {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const client = {
    from() {
      throw new Error('from should not be called');
    },
    rpc(_fn: string, args: Record<string, unknown>) {
      rpcCalls.push(args);
      return Promise.resolve({
        data: { outcome: 'settled', manualReview: false, alert: false },
        error: null,
      });
    },
  };

  await withMaibEnvironment(
    miaFetcher({
      payId: 'mia-payment-1',
      qrId: 'mia-qr-1',
      orderId: ATTEMPT_ID,
      status: 'Executed',
      amount: '875',
      // MAIB may omit currency; the adapter contract defaults it to MDL.
    }),
    async () => {
      const result = await reconcilePaymentLinkAttempt(
        client as never,
        attempt({ payment_rail: 'mia', pay_id: 'mia-qr-1' }),
        'mia-unit-test',
      );
      assertEquals(result.status, 'paid');
      assertEquals(rpcCalls[0].p_provider_amount, 875);
      assertEquals(rpcCalls[0].p_provider_currency, 'MDL');
    },
  );
});

for (
  const outcome of ['duplicate_capture', 'late_capture', 'amount_mismatch'] as const
) {
  Deno.test(`${outcome} reconciliation sends exactly one staff alert`, async () => {
    const alerts: string[] = [];
    const client = {
      from() {
        throw new Error('from should not be called');
      },
      rpc() {
        return Promise.resolve({
          data: { outcome, manualReview: true, alert: true, linkId: LINK_ID },
          error: null,
        });
      },
    };
    const maib = maibFetcher({
      status: 'Completed',
      amount: outcome === 'amount_mismatch' ? 900 : 875,
      currency: 'MDL',
      order: { id: ATTEMPT_ID },
      payment: { paymentId: `payment-${outcome}`, status: 'Executed' },
    });

    await withMaibEnvironment(maib.fetcher, async () => {
      const result = await reconcilePaymentLinkAttempt(
        client as never,
        attempt(),
        `test-${outcome}`,
        {
          sendAlert(subject) {
            alerts.push(subject);
            return Promise.resolve({ sent: true });
          },
        },
      );
      assertEquals(result.outcome, outcome);
      assertEquals(result.status, 'review');
      assertEquals(alerts.length, 1);
    });
  });
}

Deno.test('already settlement and a plain paid re-delivery do not send staff alerts', async () => {
  const alerts: string[] = [];
  let rpcCalls = 0;
  const client = {
    from() {
      throw new Error('from should not be called');
    },
    rpc() {
      rpcCalls += 1;
      return Promise.resolve({
        data: { outcome: 'already', manualReview: false, alert: false },
        error: null,
      });
    },
  };
  const sendAlert = (subject: string) => {
    alerts.push(subject);
    return Promise.resolve({ sent: true });
  };
  const maib = maibFetcher({
    status: 'Completed',
    amount: 875,
    currency: 'MDL',
    order: { id: ATTEMPT_ID },
    payment: { paymentId: 'payment-1', status: 'Executed' },
  });

  await withMaibEnvironment(maib.fetcher, async () => {
    const already = await reconcilePaymentLinkAttempt(
      client as never,
      attempt(),
      'already-test',
      { sendAlert },
    );
    const redelivery = await reconcilePaymentLinkAttempt(
      client as never,
      attempt({ status: 'paid', processed_at: '2026-08-26T12:05:00.000Z' }),
      'redelivery-test',
      { sendAlert },
    );
    assertEquals(already.outcome, 'already');
    assertEquals(redelivery.outcome, 'already');
    assertEquals(rpcCalls, 1);
    assertEquals(alerts, []);
  });
});

Deno.test('two waitForReusableAttempt callers reuse the same concurrently-created checkout', async () => {
  const creating = attempt({
    status: 'creating',
    pay_id: null,
    checkout_url: null,
    expires_at: null,
    created_at: new Date().toISOString(),
  });
  const state: MemoryState = { links: [link()], attempts: [creating] };
  const client = memoryPaymentClient(state);
  let waits = 0;
  const releaseCreation = async () => {
    waits += 1;
    Object.assign(creating, {
      status: 'pending',
      pay_id: 'checkout-shared',
      checkout_url: 'https://pay.test/checkout-shared',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    await Promise.resolve();
  };

  const [first, second] = await Promise.all([
    waitForReusableAttempt(client as never, LINK_ID, releaseCreation),
    waitForReusableAttempt(client as never, LINK_ID, releaseCreation),
  ]);
  assertEquals(first?.pay_id, 'checkout-shared');
  assertEquals(second?.pay_id, 'checkout-shared');
  assert(waits >= 1);
});

Deno.test('a checkout minted while the link becomes revoked is cancelled after mint', async () => {
  const state: MemoryState = {
    links: [link({ expires_at: '2099-01-01T00:00:00.000Z' })],
    attempts: [],
  };
  const client = memoryPaymentClient(state, (fn, _args, memory) => {
    if (fn !== 'claim_payment_link_attempt') return undefined;
    const claimed = attempt({
      status: 'creating',
      pay_id: null,
      checkout_url: null,
      expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    memory.attempts.push(claimed);
    return {
      data: [{
        attempt_id: claimed.id,
        payment_link_id: claimed.payment_link_id,
        amount: claimed.amount,
        currency: claimed.currency,
        payment_rail: claimed.payment_rail,
        pay_id: null,
        provider_payment_id: null,
        status: 'creating',
        checkout_url: null,
        provider_payload: {},
        expires_at: null,
        processed_at: null,
        manual_review: false,
        created_at: claimed.created_at,
        updated_at: claimed.updated_at,
        superseded_pay_id: null,
        superseded_payment_rail: null,
      }],
      error: null,
    };
  });
  let cancelCalls = 0;
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/v2/auth/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({
          ok: true,
          result: { accessToken: 'token', tokenType: 'Bearer' },
        })),
      );
    }
    if (url.endsWith('/v2/checkouts') && init?.method === 'POST') {
      Object.assign(state.links[0], {
        status: 'revoked',
        revoked_at: new Date().toISOString(),
      });
      return Promise.resolve(
        new Response(JSON.stringify({
          ok: true,
          result: {
            checkoutId: 'checkout-race',
            checkoutUrl: 'https://pay.test/checkout-race',
          },
        })),
      );
    }
    if (url.endsWith('/v2/checkouts/checkout-race/cancel')) {
      cancelCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} })));
    }
    if (url.endsWith('/v2/checkouts/checkout-race')) {
      return Promise.resolve(
        new Response(JSON.stringify({
          ok: true,
          result: { status: 'Cancelled', amount: 875, currency: 'MDL' },
        })),
      );
    }
    throw new Error(`Unexpected checkout URL: ${url}`);
  }) as typeof fetch;

  await withMaibEnvironment(fetcher, async () => {
    const before = Date.now();
    const response = await handleStart(
      client as never,
      new Request('https://ecovila.test/start', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.11' },
      }),
      { linkId: LINK_ID },
    );
    assertEquals(rowRecord(response).status, 'revoked');
    assertEquals(cancelCalls, 1);
    const expiry = new Date(state.attempts[0].expires_at || '').getTime();
    assert(expiry >= before + 29 * 60 * 1000);
    assert(expiry <= Date.now() + 30 * 60 * 1000);
  });
});

Deno.test('admin revoke cancels and re-reads the provider before returning the link', async () => {
  const state: MemoryState = { links: [link()], attempts: [attempt()] };
  const revokedAt = '2026-08-26T12:06:00.000Z';
  const client = memoryPaymentClient(state, (fn, _args, memory) => {
    if (fn !== 'revoke_payment_link') return undefined;
    Object.assign(memory.links[0], { status: 'revoked', revoked_at: revokedAt });
    Object.assign(memory.attempts[0], { status: 'cancelled', processed_at: revokedAt });
    return {
      data: [{ pay_id: 'checkout-1', payment_rail: 'card' }],
      error: null,
    };
  });
  const maib = maibFetcher({ status: 'Cancelled', amount: 875, currency: 'MDL' });

  await withMaibEnvironment(maib.fetcher, async () => {
    const result = await revokeLink(client as never, { id: LINK_ID });
    assertEquals(result.link.effectiveStatus, 'revoked');
    assertEquals(result.link.revokedAt, revokedAt);
    assertEquals(state.attempts[0].status, 'cancelled');
    assert(maib.calls.some((call) => call.url.endsWith('/checkout-1/cancel')));
    assert(maib.calls.some((call) => call.url.endsWith('/checkouts/checkout-1')));
  });
});

Deno.test('admin markRefunded persists the refund and returns its public fields', async () => {
  const state: MemoryState = {
    links: [link({
      status: 'paid',
      paid_at: '2026-08-26T12:05:00.000Z',
      paid_amount: 875,
      settled_attempt_id: ATTEMPT_ID,
    })],
    attempts: [attempt({ status: 'paid' })],
  };
  const client = memoryPaymentClient(state, (fn, args, memory) => {
    if (fn !== 'mark_payment_link_refunded') return undefined;
    Object.assign(memory.links[0], {
      refunded_at: '2026-08-26T12:10:00.000Z',
      refunded_amount: args.p_amount,
      refund_note: args.p_note,
    });
    return { data: memory.links[0], error: null };
  });

  const result = await markRefunded(client as never, {
    id: LINK_ID,
    amount: 400,
    note: 'Restituire parțială',
  });
  assertEquals(result.link.refundedAmount, 400);
  assertEquals(result.link.refundNote, 'Restituire parțială');
  assertEquals(result.link.effectiveStatus, 'paid');
});

Deno.test('admin list paginates, keeps revokedAt on paid review rows, and shows expired pending attempts as pending', async () => {
  const secondLinkId = '33333333-3333-4333-8333-333333333333';
  const state: MemoryState = {
    links: [
      link({
        id: secondLinkId,
        status: 'paid',
        paid_at: '2026-08-26T12:05:00.000Z',
        paid_amount: 875,
        revoked_at: '2026-08-26T12:03:00.000Z',
        manual_review: true,
        created_at: '2026-08-26T12:01:00.000Z',
      }),
      link({ expires_at: '2020-01-01T00:00:00.000Z' }),
    ],
    attempts: [
      attempt({
        payment_link_id: secondLinkId,
        status: 'paid',
        manual_review: true,
        created_at: '2026-08-26T12:01:00.000Z',
      }),
      attempt({ pay_id: null, expires_at: '2020-01-01T00:00:00.000Z' }),
    ],
  };
  const result = await listLinks(memoryPaymentClient(state) as never, { limit: 2 });

  assertEquals(result.links.length, 2);
  assertEquals(result.links[0].effectiveStatus, 'review');
  assertEquals(result.links[0].revokedAt, '2026-08-26T12:03:00.000Z');
  assertEquals(result.links[1].effectiveStatus, 'pending');
  assertEquals(result.nextBefore, null);
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    Deno.env.delete(name);
  } else {
    Deno.env.set(name, value);
  }
}
