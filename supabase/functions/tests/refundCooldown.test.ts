// Refund cooldown (ADR-096). A guest refund is scheduled — not paid out — on
// cancellation, and the reconcile cron executes it 60h later. These pin the two
// mechanics the whole feature rests on: scheduleBookingRefund records a due-dated
// row without ever calling MAIB, and cancelScheduledRefund only aborts a refund
// that has NOT yet fired.
import { assert, assertEquals } from 'std/assert';
import {
  attemptBookingRefund,
  cancelScheduledRefund,
  refundEligibleAtIso,
  REFUND_COOLDOWN_HOURS,
  scheduleBookingRefund,
} from '../_shared/refunds.ts';

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
  options: { onRead?: (table: string) => void } = {},
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
        filter.op === 'eq' ? row[filter.column] === filter.value : row[filter.column] !== filter.value
      );
    }

    function resolveUpdate() {
      const matched = filtersMatch(store[table] ?? null);
      updates.push({ table, payload: pendingUpdate, matched });
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
  const { client, upserts } = makeClient();
  const row = await scheduleBookingRefund(client, {
    payId: 'p1',
    bookingGroupId: 'g1',
    amount: 5000,
    reason: 'guest_request',
    source: 'test',
  });

  assertEquals(upserts.length, 1);
  const payload = upserts[0].payload;
  assertEquals(payload.status, 'requested');
  assertEquals(payload.pay_id, 'p1');
  assertEquals(payload.amount, 5000);
  assertEquals((payload.request_payload as Record<string, unknown>).scheduled, true);

  const leadMs = new Date(String(payload.eligible_at)).getTime() - Date.now();
  assert(leadMs > 59 * 3600 * 1000 && leadMs <= 60.5 * 3600 * 1000, 'eligible_at ~60h ahead');
  assertEquals(row?.status, 'requested');
  // No MAIB network call happened — scheduleBookingRefund only writes the row.
});

Deno.test('scheduleBookingRefund keeps the original eligible_at so re-initiating never extends the wait', async () => {
  const existingEligible = '2026-07-10T22:00:00.000Z';
  const { client, upserts } = makeClient({
    maib_refunds: {
      pay_id: 'p1',
      booking_group_id: 'g1',
      status: 'requested',
      eligible_at: existingEligible,
    },
  });

  await scheduleBookingRefund(client, {
    payId: 'p1',
    bookingGroupId: 'g1',
    amount: 5000,
    reason: 'guest_request',
    source: 'test',
  });

  assertEquals(upserts[0].payload.eligible_at, existingEligible);
});

Deno.test('scheduleBookingRefund never resurrects a settled or aborted refund', async () => {
  for (const status of ['succeeded', 'cancelled']) {
    const { client, upserts } = makeClient({
      maib_refunds: { pay_id: 'p1', booking_group_id: 'g1', status },
    });
    const row = await scheduleBookingRefund(client, {
      payId: 'p1',
      bookingGroupId: 'g1',
      amount: 5000,
      reason: 'guest_request',
      source: 'test',
    });
    assertEquals(upserts.length, 0, `${status} must not be re-upserted`);
    assertEquals(row?.status, status);
  }
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
    amount: 5000,
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
