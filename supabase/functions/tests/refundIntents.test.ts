import { assertEquals, assertRejects } from 'std/assert';
import {
  buildRefundPreviewQuote,
  prepareFullRefundIntent,
  refundCountsTowardGuestNotice,
  shouldSweepPaidChangeRefunds,
} from '../_shared/refundIntents.ts';
import { HttpError } from '../_shared/http.ts';

function intentClient(data: unknown, error: unknown = null) {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      rpc(name: string, params: Record<string, unknown>) {
        calls.push({ name, params });
        return Promise.resolve({ data, error });
      },
    } as never,
  };
}

Deno.test('full refund intent is one RPC that returns the main and every difference quote', async () => {
  const mock = intentClient([{
    main_status: 'requested',
    main_eligible_at: '2026-08-28T12:00:00.000Z',
    main_amount: 986,
    main_gross_amount: 1000,
    main_withheld: 14,
    main_rate_bps: 140,
    main_policy_version: 'adr-105-1.4pct',
    change_quotes: [
      { changeId: 'a', gross: 500, net: 493, withheld: 7, rateBps: 140, version: 'adr-105-1.4pct' },
      { changeId: 'b', gross: 700, net: 691, withheld: 9, rateBps: 140, version: 'adr-105-1.4pct' },
    ],
  }]);
  const result = await prepareFullRefundIntent(mock.client, {
    payId: 'pay-1',
    bookingGroupId: 'group-1',
    quote: { gross: 1000, net: 986, withheld: 14, rateBps: 140, version: 'adr-105-1.4pct' },
    reason: 'guest_request',
    source: 'test',
  });

  assertEquals(mock.calls.length, 1);
  assertEquals(mock.calls[0].name, 'prepare_full_refund_intent');
  assertEquals(result.refundScheduled, true);
  assertEquals(result.changeQuotes.map((entry) => entry.quote.net), [493, 691]);
});

Deno.test('full refund intent maps a transactional quote conflict to HTTP 409', async () => {
  const mock = intentClient(null, { code: 'P0001', message: 'different quote' });
  const error = await assertRejects(
    () =>
      prepareFullRefundIntent(mock.client, {
        payId: 'pay-1',
        bookingGroupId: 'group-1',
        quote: { gross: 1000, net: 986, withheld: 14, rateBps: 140, version: 'adr-105-1.4pct' },
        reason: 'guest_request',
        source: 'test',
      }),
    HttpError,
    'different quote',
  );
  assertEquals(error.status, 409);
});

Deno.test('only full cancellation rows release paid differences to the orphan sweep', () => {
  assertEquals(
    shouldSweepPaidChangeRefunds({
      reason: 'crm_partial_cancellation',
      status: 'succeeded',
      eligible_at: null,
    }),
    false,
  );
  assertEquals(
    shouldSweepPaidChangeRefunds({
      reason: 'guest_request',
      status: 'succeeded',
      eligible_at: null,
    }),
    true,
  );
  assertEquals(
    shouldSweepPaidChangeRefunds({
      reason: 'crm_cancellation',
      status: 'succeeded',
      eligible_at: null,
    }),
    true,
  );
});

Deno.test('cancelled refund rows never contribute to a guest notice but retryable failures do', () => {
  assertEquals(refundCountsTowardGuestNotice('cancelled'), false);
  assertEquals(refundCountsTowardGuestNotice('failed'), true);
  assertEquals(refundCountsTowardGuestNotice('processing'), true);
  assertEquals(refundCountsTowardGuestNotice('succeeded'), true);
});

Deno.test('refund preview is null when the payment refund slot is spent or aborted', () => {
  const payment = { amount: 12_200, status: 'paid', refunded_at: null };
  assertEquals(buildRefundPreviewQuote(payment, 'succeeded', [100]), null);
  assertEquals(buildRefundPreviewQuote(payment, 'cancelled', [100]), null);
});

Deno.test('refund preview is null for already-refunded and uncaptured payments', () => {
  assertEquals(
    buildRefundPreviewQuote(
      { amount: 12_200, status: 'paid', refunded_at: '2026-08-24T12:00:00.000Z' },
      null,
      [],
    ),
    null,
  );
  for (const status of ['refunded', 'created', 'pending', 'failed']) {
    assertEquals(
      buildRefundPreviewQuote({ amount: 12_200, status, refunded_at: null }, null, []),
      null,
    );
  }
});

Deno.test('refund preview aggregates every quotable authorization for a plain paid payment', () => {
  const previous = Deno.env.get('ECOVILA_REFUND_COMMISSION_BPS');
  Deno.env.set('ECOVILA_REFUND_COMMISSION_BPS', '140');
  try {
    assertEquals(
      buildRefundPreviewQuote(
        { amount: 12_200, status: 'paid', refunded_at: null },
        null,
        [100],
      ),
      {
        gross: 12_300,
        net: 12_129,
        withheld: 171,
        rateBps: 140,
        version: 'adr-105-1.4pct',
      },
    );
  } finally {
    if (previous === undefined) Deno.env.delete('ECOVILA_REFUND_COMMISSION_BPS');
    else Deno.env.set('ECOVILA_REFUND_COMMISSION_BPS', previous);
  }
});

Deno.test('refund preview skips invalid display-only amounts and degrades to null', () => {
  assertEquals(
    buildRefundPreviewQuote({ amount: 0, status: 'paid', refunded_at: null }, null, []),
    null,
  );
  assertEquals(
    buildRefundPreviewQuote({ amount: 12.5, status: 'paid', refunded_at: null }, null, [0, -4]),
    null,
  );
});
