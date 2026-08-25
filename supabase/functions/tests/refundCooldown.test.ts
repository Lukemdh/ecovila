// Refund cooldown (ADR-096). A guest refund is scheduled — not paid out — on
// cancellation, and the reconcile cron executes it 60h later. These pin the two
// mechanics the whole feature rests on: scheduleBookingRefund records a due-dated
// row without ever calling MAIB, and cancelScheduledRefund only aborts a refund
// that has NOT yet fired.
import { assert, assertEquals, assertRejects } from 'std/assert';
import {
  attemptBookingRefund,
  cancelScheduledRefund,
  REFUND_COOLDOWN_HOURS,
  refundEligibleAtIso,
  scheduleBookingRefund,
} from '../_shared/refunds.ts';
import type { RefundQuote } from '../_shared/refundPolicy.ts';

const QUOTE: RefundQuote = {
  gross: 5000,
  net: 4930,
  withheld: 70,
  rateBps: 140,
  version: 'adr-105-1.4pct',
};

function quotedRefundRow(overrides: Record<string, unknown> = {}) {
  return {
    pay_id: 'p1',
    booking_group_id: 'g1',
    amount: QUOTE.net,
    gross_amount: QUOTE.gross,
    withheld_commission: QUOTE.withheld,
    commission_rate_bps: QUOTE.rateBps,
    refund_policy_version: QUOTE.version,
    ...overrides,
  };
}

// Minimal chainable client: serves one row per table for findRefundRow's
// select().eq().maybeSingle(), captures upsert()/insert() payloads, and records
// update() chains. Update filters (eq/neq) are EVALUATED against the stored row
// — matching the real PostgREST guarded updates (ADR-099): the payload applies
// and `data` returns the row only when every filter holds, otherwise the update
// is a no-op resolving to an empty array, exactly like a 0-row UPDATE.
// `onRead(table)` lets a test mutate the store right after a read to simulate a
// concurrent writer landing between a read-check and the guarded write.
function makeClient(
  initial: Record<string, Record<string, unknown>> = {},
  options: {
    onRead?: (table: string) => void;
    updateError?: (
      table: string,
      payload: Record<string, unknown> | null,
    ) => { message: string } | null;
  } = {},
) {
  const store: Record<string, Record<string, unknown> | null> = { ...initial };
  const upserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const updates: Array<
    { table: string; payload: Record<string, unknown> | null; matched: boolean }
  > = [];

  function from(table: string) {
    let pendingUpdate: Record<string, unknown> | null = null;
    const filters: Array<{ op: 'eq' | 'neq'; column: string; value: unknown }> = [];

    function filtersMatch(row: Record<string, unknown> | null) {
      if (!row) {
        return false;
      }
      return filters.every((filter) =>
        filter.op === 'eq'
          ? row[filter.column] === filter.value
          : row[filter.column] !== filter.value
      );
    }

    function resolveUpdate() {
      const matched = filtersMatch(store[table] ?? null);
      updates.push({ table, payload: pendingUpdate, matched });
      const error = options.updateError?.(table, pendingUpdate) || null;
      if (error) return { data: null, error };
      if (matched && pendingUpdate) {
        store[table] = { ...(store[table] || {}), ...pendingUpdate };
      }
      return { data: matched && store[table] ? [store[table]] : [], error: null };
    }

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        if (pendingUpdate) {
          filters.push({ op: 'eq', column, value });
        }
        return builder;
      },
      neq: (column: string, value: unknown) => {
        if (pendingUpdate) {
          filters.push({ op: 'neq', column, value });
        }
        return builder;
      },
      maybeSingle: () => {
        const row = store[table] ? { ...store[table] } : null;
        options.onRead?.(table);
        return Promise.resolve({ data: row, error: null });
      },
      upsert: (payload: Record<string, unknown>) => {
        upserts.push({ table, payload });
        store[table] = { ...(store[table] || {}), ...payload };
        return Promise.resolve({ data: null, error: null });
      },
      insert: (payload: Record<string, unknown>) => {
        inserts.push({ table, payload });
        store[table] = { ...(store[table] || {}), ...payload };
        return Promise.resolve({ data: null, error: null });
      },
      update: (payload: Record<string, unknown>) => {
        pendingUpdate = payload;
        return builder;
      },
      // Reached when an update()... chain (with or without .select()) is awaited.
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        if (pendingUpdate) {
          return Promise.resolve(resolveUpdate()).then(resolve, reject);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  return { client: { from } as never, store, upserts, inserts, updates };
}

Deno.test('refundEligibleAtIso stamps the payout 60 hours out', () => {
  const now = new Date('2026-07-08T10:00:00.000Z');
  assertEquals(REFUND_COOLDOWN_HOURS, 60);
  assertEquals(refundEligibleAtIso(now), '2026-07-10T22:00:00.000Z');
});

Deno.test('scheduleBookingRefund records a requested row with a ~60h eligible_at and never calls MAIB', async () => {
  const { client, inserts } = makeClient();
  const row = await scheduleBookingRefund(client, {
    payId: 'p1',
    bookingGroupId: 'g1',
    quote: QUOTE,
    reason: 'guest_request',
    source: 'test',
  });

  assertEquals(inserts.length, 1);
  const payload = inserts[0].payload;
  assertEquals(payload.status, 'requested');
  assertEquals(payload.pay_id, 'p1');
  assertEquals(payload.amount, 4930);
  assertEquals(payload.gross_amount, 5000);
  assertEquals(payload.withheld_commission, 70);
  assertEquals((payload.request_payload as Record<string, unknown>).scheduled, true);

  const leadMs = new Date(String(payload.eligible_at)).getTime() - Date.now();
  assert(leadMs > 59 * 3600 * 1000 && leadMs <= 60.5 * 3600 * 1000, 'eligible_at ~60h ahead');
  assertEquals(row?.status, 'requested');
  // No MAIB network call happened — scheduleBookingRefund only writes the row.
});

Deno.test('scheduleBookingRefund keeps the original eligible_at so re-initiating never extends the wait', async () => {
  const existingEligible = '2026-07-10T22:00:00.000Z';
  const { client, updates } = makeClient({
    maib_refunds: quotedRefundRow({
      status: 'requested',
      eligible_at: existingEligible,
    }),
  });

  await scheduleBookingRefund(client, {
    payId: 'p1',
    bookingGroupId: 'g1',
    quote: QUOTE,
    reason: 'guest_request',
    source: 'test',
  });

  assertEquals(updates[0].payload?.eligible_at, existingEligible);
});

Deno.test('scheduleBookingRefund never resurrects a settled or aborted refund', async () => {
  for (const status of ['succeeded', 'cancelled']) {
    const { client, upserts, inserts } = makeClient({
      maib_refunds: quotedRefundRow({ status }),
    });
    const row = await scheduleBookingRefund(client, {
      payId: 'p1',
      bookingGroupId: 'g1',
      quote: QUOTE,
      reason: 'guest_request',
      source: 'test',
    });
    assertEquals(upserts.length, 0, `${status} must not be re-upserted`);
    assertEquals(inserts.length, 0, `${status} must not be inserted`);
    assertEquals(row?.status, status);
  }
});

Deno.test('scheduleBookingRefund reads back a spent partial-refund row despite a different request quote', async () => {
  const spent = quotedRefundRow({
    status: 'succeeded',
    amount: 3451,
    gross_amount: 3500,
    withheld_commission: 49,
  });
  const { client, upserts, inserts, updates } = makeClient({ maib_refunds: spent });

  const row = await scheduleBookingRefund(client, {
    payId: 'p1',
    bookingGroupId: 'g1',
    quote: {
      gross: 12_200,
      net: 12_030,
      withheld: 170,
      rateBps: 140,
      version: 'adr-105-1.4pct',
    },
    reason: 'guest_request',
    source: 'test',
  });

  assertEquals(row, spent);
  assertEquals(upserts.length, 0);
  assertEquals(inserts.length, 0);
  assertEquals(updates.length, 0);
});

Deno.test('scheduleBookingRefund accepts different audit labels when the stored money is identical', async () => {
  const { client } = makeClient({
    maib_refunds: quotedRefundRow({
      status: 'requested',
      amount: 36,
      gross_amount: 36,
      withheld_commission: 0,
      commission_rate_bps: 140,
      refund_policy_version: 'legacy-full-refund',
    }),
  });

  const row = await scheduleBookingRefund(client, {
    payId: 'p1',
    bookingGroupId: 'g1',
    quote: {
      gross: 36,
      net: 36,
      withheld: 0,
      rateBps: 0,
      version: 'adr-105-override',
    },
    reason: 'guest_request',
    source: 'test',
  });

  assertEquals(row?.amount, 36);
  assertEquals(row?.commission_rate_bps, 140);
  assertEquals(row?.refund_policy_version, 'legacy-full-refund');
});

Deno.test('cancelScheduledRefund aborts a still-pending refund and drops the refunded marker', async () => {
  const future = new Date(Date.now() + 40 * 3600 * 1000).toISOString();
  const { client, updates } = makeClient({
    maib_refunds: {
      pay_id: 'p1',
      booking_group_id: 'g1',
      status: 'requested',
      eligible_at: future,
    },
  });

  const result = await cancelScheduledRefund(client, 'p1');
  assertEquals(result.ok, true);

  const refundUpdate = updates.find((u) => u.table === 'maib_refunds');
  assertEquals(refundUpdate?.payload?.status, 'cancelled');
  // Money stays with us, so the booking's "refunded" marker is reset for Finance.
  const reservationUpdate = updates.find((u) => u.table === 'reservations');
  assertEquals(reservationUpdate?.payload?.cancellation_reason, 'guest_request');
});

Deno.test('cancelScheduledRefund refuses a refund already settled or past its cooldown', async () => {
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  const cases = [
    { status: 'succeeded', eligible_at: past, reason: 'already_refunded' },
    { status: 'processing', eligible_at: past, reason: 'already_processing' },
    { status: 'requested', eligible_at: past, reason: 'already_processing' },
  ] as const;

  for (const testCase of cases) {
    const { client, updates } = makeClient({
      maib_refunds: {
        pay_id: 'p1',
        booking_group_id: 'g1',
        status: testCase.status,
        eligible_at: testCase.eligible_at,
      },
    });

    const result = await cancelScheduledRefund(client, 'p1');
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.reason, testCase.reason);
    }
    assertEquals(updates.length, 0, `${testCase.status} must not be mutated`);
  }
});

// The two sides of the cancel-vs-execute race (ADR-099). Both writes are
// guarded on the row's CURRENT status, so whichever lands first wins and the
// loser reports the truth instead of silently overwriting.

Deno.test('attemptBookingRefund refuses a staff-cancelled refund instead of resurrecting it', async () => {
  const { client, store, upserts, inserts } = makeClient({
    maib_refunds: {
      pay_id: 'p1',
      booking_group_id: 'g1',
      status: 'cancelled',
      eligible_at: new Date(Date.now() + 40 * 3600 * 1000).toISOString(),
    },
  });

  const outcome = await attemptBookingRefund(client, {
    payId: 'p1',
    providerPayId: 'prov-1',
    bookingGroupId: 'g1',
    quote: QUOTE,
    reason: 'guest_request',
    source: 'test',
  });

  // The guarded claim matched nothing: no MAIB call, no money moved, and the
  // row still says cancelled. (A blind upsert used to flip it back to live.)
  assertEquals(outcome.ok, false);
  assertEquals(outcome.cancelled, true);
  assertEquals(store.maib_refunds?.status, 'cancelled');
  assertEquals(upserts.length, 0);
  assertEquals(inserts.length, 0);
});

Deno.test('attemptBookingRefund rejects a competing quote without rewriting the stored money', async () => {
  const { client, store } = makeClient({
    maib_refunds: quotedRefundRow({ status: 'requested' }),
  });

  await assertRejects(
    () =>
      attemptBookingRefund(client, {
        payId: 'p1',
        providerPayId: 'prov-1',
        bookingGroupId: 'g1',
        quote: { ...QUOTE, net: 5000, withheld: 0, rateBps: 0, version: 'adr-105-override' },
        reason: 'staff_override',
        source: 'test',
      }),
    Error,
    'different refund quote',
  );

  assertEquals(store.maib_refunds?.amount, QUOTE.net);
  assertEquals(store.maib_refunds?.gross_amount, QUOTE.gross);
});

Deno.test('every retry sends the stored net to MAIB, including unresolved retries', async () => {
  const { client } = makeClient({
    maib_refunds: quotedRefundRow({ status: 'requested', attempts: 0 }),
  });
  const observedAmounts: number[] = [];
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/v2/auth/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({
          ok: true,
          result: { accessToken: 'token', tokenType: 'Bearer' },
        })),
      );
    }

    const body = JSON.parse(String(init?.body || '{}')) as { amount?: number };
    observedAmounts.push(Number(body.amount));
    // Stay unresolved so all three executions genuinely reach the provider.
    return Promise.resolve(
      new Response(JSON.stringify({
        ok: true,
        result: { status: 'PENDING' },
      })),
    );
  }) as typeof fetch;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await attemptBookingRefund(client, {
      payId: 'p1',
      providerPayId: 'provider-p1',
      bookingGroupId: 'g1',
      quote: QUOTE,
      reason: 'retry-test',
      source: 'test',
      providerOptions: {
        fetcher,
        baseUrl: 'https://api.test',
        clientId: 'client',
        clientSecret: 'secret',
      },
    });
    assertEquals(outcome.ok, false);
  }

  assertEquals(observedAmounts, [QUOTE.net, QUOTE.net, QUOTE.net]);
});

Deno.test('two executors keep a succeeded ledger when the later provider result is pending', async () => {
  let releasePending: (() => void) | null = null;
  const successWritten = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  const { client, store } = makeClient(
    { maib_refunds: quotedRefundRow({ status: 'requested' }) },
    {
      updateError: (table, payload) => {
        if (table === 'maib_refunds' && payload?.status === 'succeeded') {
          releasePending?.();
        }
        return null;
      },
    },
  );
  const observedAmounts: number[] = [];
  let providerCall = 0;
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/v2/auth/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({
          ok: true,
          result: { accessToken: 'token', tokenType: 'Bearer' },
        })),
      );
    }
    observedAmounts.push(JSON.parse(String(init?.body || '{}')).amount);
    providerCall += 1;
    if (providerCall === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { status: 'OK' } })),
      );
    }
    return successWritten.then(() =>
      new Response(JSON.stringify({ ok: true, result: { status: 'PENDING' } }))
    );
  }) as typeof fetch;
  const input = {
    payId: 'p1',
    providerPayId: 'provider-p1',
    bookingGroupId: 'g1',
    quote: QUOTE,
    reason: 'race-test',
    source: 'test',
    providerOptions: {
      fetcher,
      baseUrl: 'https://api.test',
      clientId: 'client',
      clientSecret: 'secret',
    },
  };

  const outcomes = await Promise.all([
    attemptBookingRefund(client, input),
    attemptBookingRefund(client, input),
  ]);

  assertEquals(outcomes.map((outcome) => outcome.ok), [true, false]);
  assertEquals(observedAmounts, [QUOTE.net, QUOTE.net]);
  assertEquals(store.maib_refunds?.status, 'succeeded');
  assertEquals(store.maib_refunds?.amount, QUOTE.net);
});

Deno.test('a crash after MAIB success retries the same stored net and resolves REVERSED', async () => {
  let failSuccessWrite = true;
  const { client, store } = makeClient(
    { maib_refunds: quotedRefundRow({ status: 'requested' }) },
    {
      updateError: (table, payload) => {
        if (table === 'maib_refunds' && payload?.status === 'succeeded' && failSuccessWrite) {
          failSuccessWrite = false;
          return { message: 'simulated crash before ledger success write' };
        }
        return null;
      },
    },
  );
  const observedAmounts: number[] = [];
  let providerAttempt = 0;
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/v2/auth/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({
          ok: true,
          result: { accessToken: 'token', tokenType: 'Bearer' },
        })),
      );
    }
    observedAmounts.push(JSON.parse(String(init?.body || '{}')).amount);
    providerAttempt += 1;
    return Promise.resolve(
      new Response(JSON.stringify({
        ok: true,
        result: { status: providerAttempt === 1 ? 'OK' : 'REVERSED' },
      })),
    );
  }) as typeof fetch;
  const input = {
    payId: 'p1',
    providerPayId: 'provider-p1',
    bookingGroupId: 'g1',
    quote: QUOTE,
    reason: 'retry-test',
    source: 'test',
    providerOptions: {
      fetcher,
      baseUrl: 'https://api.test',
      clientId: 'client',
      clientSecret: 'secret',
    },
  };

  await assertRejects(
    () => attemptBookingRefund(client, input),
    Error,
    'simulated crash',
  );
  assertEquals(store.maib_refunds?.status, 'processing');

  const retried = await attemptBookingRefund(client, input);
  assertEquals(retried.ok, true);
  assertEquals(retried.alreadyRefunded, true);
  assertEquals(observedAmounts, [QUOTE.net, QUOTE.net]);
});

Deno.test('cancelScheduledRefund reports already_processing when the refund is claimed mid-cancel', async () => {
  const future = new Date(Date.now() + 40 * 3600 * 1000).toISOString();
  const { client, store, updates } = makeClient(
    {
      maib_refunds: {
        pay_id: 'p1',
        booking_group_id: 'g1',
        status: 'requested',
        eligible_at: future,
      },
    },
    {
      // Simulate an execution claim landing between the pre-check read and the
      // guarded write: the read still sees 'requested', the write must not.
      onRead: (tableName) => {
        if (tableName === 'maib_refunds' && store.maib_refunds) {
          store.maib_refunds = { ...store.maib_refunds, status: 'processing' };
        }
      },
    },
  );

  const result = await cancelScheduledRefund(client, 'p1');

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason, 'already_processing');
  }
  // The refund stays live and the booking's refunded marker is NOT reset.
  assertEquals(store.maib_refunds?.status, 'processing');
  assert(!updates.some((update) => update.table === 'reservations'), 'marker must not reset');
});
