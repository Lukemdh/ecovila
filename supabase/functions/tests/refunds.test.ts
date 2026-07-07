// ADR-088: a MAIB refund is only "done" when the provider says so. These tests
// pin the interpretation rules the whole refund pipeline keys on.
import { assertEquals } from 'std/assert';
import { interpretMaibRefundResponse } from '../_shared/refunds.ts';

Deno.test('interpretMaibRefundResponse treats result.status OK as completed', () => {
  const verdict = interpretMaibRefundResponse({
    ok: true,
    result: { payId: 'p1', status: 'OK', refundId: 42 },
  });
  assertEquals(verdict.completed, true);
  assertEquals(verdict.alreadyRefunded, false);
  assertEquals(verdict.providerStatus, 'OK');
  assertEquals(verdict.refundId, '42');
});

Deno.test('interpretMaibRefundResponse treats REVERSED as already refunded, not a new completion', () => {
  const verdict = interpretMaibRefundResponse({
    ok: true,
    result: { payId: 'p1', status: 'REVERSED' },
  });
  assertEquals(verdict.completed, false);
  assertEquals(verdict.alreadyRefunded, true);
  assertEquals(verdict.providerStatus, 'REVERSED');
});

Deno.test('interpretMaibRefundResponse leaves any other status unresolved (insufficient funds shape)', () => {
  for (const status of ['FAILED', 'PENDING', 'DECLINED', 'error']) {
    const verdict = interpretMaibRefundResponse({ ok: true, result: { status } });
    assertEquals(verdict.completed, false, `status ${status} must not complete`);
    assertEquals(verdict.alreadyRefunded, false);
    assertEquals(verdict.providerStatus, status.toUpperCase());
  }
});

Deno.test('interpretMaibRefundResponse keeps the legacy no-status response as completed', () => {
  // Pre-ADR-088 responses carried no status field; treating them as completed
  // preserves the behavior of every refund that genuinely worked.
  const verdict = interpretMaibRefundResponse({ ok: true, result: { refundId: 'r-9' } });
  assertEquals(verdict.completed, true);
  assertEquals(verdict.refundId, 'r-9');
});

Deno.test('interpretMaibRefundResponse tolerates malformed bodies', () => {
  for (const body of [null, undefined, 'nope', 42, {}]) {
    const verdict = interpretMaibRefundResponse(body);
    assertEquals(verdict.completed, true);
    assertEquals(verdict.alreadyRefunded, false);
    assertEquals(verdict.refundId, null);
  }
});
