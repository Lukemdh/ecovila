import { assertEquals, assertThrows } from 'std/assert';
import { HttpError } from '../_shared/http.ts';
import {
  activeCommissionBps,
  quoteRefund,
  REFUND_POLICY_VERSION,
  REFUND_POLICY_VERSION_OVERRIDE,
} from '../_shared/refundPolicy.ts';

const ENV_NAME = 'ECOVILA_REFUND_COMMISSION_BPS';

function withRate(value: string | null, run: () => void) {
  const before = Deno.env.get(ENV_NAME);
  try {
    if (value === null) Deno.env.delete(ENV_NAME);
    else Deno.env.set(ENV_NAME, value);
    run();
  } finally {
    if (before === undefined) Deno.env.delete(ENV_NAME);
    else Deno.env.set(ENV_NAME, before);
  }
}

Deno.test('refund commission ships inert and rejects unsafe configured basis points', () => {
  withRate(null, () => assertEquals(activeCommissionBps(), 0));
  withRate('140', () => assertEquals(activeCommissionBps(), 140));
  withRate('-5', () => assertEquals(activeCommissionBps(), 0));
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    withRate('1400', () => assertEquals(activeCommissionBps(), 0));
    withRate('20000', () => assertEquals(activeCommissionBps(), 0));
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(warnings.length, 2);
  withRate('not-a-number', () => assertEquals(activeCommissionBps(), 0));
});

Deno.test('quoteRefund can reuse one snapshotted rate across a cancellation', () => {
  withRate('140', () => {
    const snapshot = activeCommissionBps();
    Deno.env.set(ENV_NAME, '0');
    assertEquals(quoteRefund(5000, { rateBps: snapshot }).withheld, 70);
    assertEquals(quoteRefund(1000, { rateBps: snapshot }).withheld, 14);
  });
});

Deno.test('quoteRefund ceils the net so the withheld amount never exceeds 1.4%', () => {
  withRate('140', () => {
    assertEquals(quoteRefund(36), {
      gross: 36,
      net: 36,
      withheld: 0,
      rateBps: 140,
      version: REFUND_POLICY_VERSION,
    });
    assertEquals(quoteRefund(108), {
      gross: 108,
      net: 107,
      withheld: 1,
      rateBps: 140,
      version: REFUND_POLICY_VERSION,
    });
    assertEquals(quoteRefund(5000), {
      gross: 5000,
      net: 4930,
      withheld: 70,
      rateBps: 140,
      version: REFUND_POLICY_VERSION,
    });
  });
});

Deno.test('quoteRefund override returns the full gross with an auditable version', () => {
  withRate('140', () => {
    assertEquals(quoteRefund(5000, { withhold: false }), {
      gross: 5000,
      net: 5000,
      withheld: 0,
      rateBps: 0,
      version: REFUND_POLICY_VERSION_OVERRIDE,
    });
  });
});

Deno.test('quoteRefund rejects non-positive and non-integer gross amounts', () => {
  for (const amount of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const error = assertThrows(() => quoteRefund(amount), HttpError);
    assertEquals(error.status, 400);
  }
});
