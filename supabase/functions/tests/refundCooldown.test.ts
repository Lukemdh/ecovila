// Refund cooldown (ADR-096). A guest refund is scheduled — not paid out — on
// cancellation, and the reconcile cron executes it 60h later. These pin the two
// mechanics the whole feature rests on: scheduleBookingRefund records a due-dated
// row without ever calling MAIB, and cancelScheduledRefund only aborts a refund
// that has NOT yet fired.
import { assert, assertEquals } from 'std/assert';
import {
  cancelScheduledRefund,
  refundEligibleAtIso,
  REFUND_COOLDOWN_HOURS,
  scheduleBookingRefund,
} from '../_shared/refunds.ts';

// Minimal chainable client: serves one maib_refunds row for findRefundRow's
// select().eq().maybeSingle(), captures upsert() payloads, and records
// update().eq().eq() chains (the builder is thenable so an awaited update lands
// in `updates`). Enough to exercise the scheduling/cancel mechanics without a DB.
function makeClient(initial: Record<string, Record<string, unknown>> = {}) {
  const store: Record<string, Record<string, unknown> | null> = { ...initial };
  const upserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; payload: Record<string, unknown> | null }> = [];

  function from(table: string) {
    let pendingUpdate: Record<string, unknown> | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: () => Promise.resolve({ data: store[table] ?? null, error: null }),
      upsert: (payload: Record<string, unknown>) => {
        upserts.push({ table, payload });
        store[table] = { ...(store[table] || {}), ...payload };
        return Promise.resolve({ data: null, error: null });
      },
      update: (payload: Record<string, unknown>) => {
        pendingUpdate = payload;
        return builder;
      },
      // Reached only when an update().eq()... chain is awaited.
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        updates.push({ table, payload: pendingUpdate });
        if (pendingUpdate) {
          store[table] = { ...(store[table] || {}), ...pendingUpdate };
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  return { client: { from } as never, store, upserts, updates };
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
