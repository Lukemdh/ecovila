import { optionalEnv } from './env.ts';
import { HttpError } from './http.ts';

export const REFUND_COMMISSION_RATE_BPS = 140;
export const REFUND_POLICY_VERSION = 'adr-105-1.4pct';
export const REFUND_POLICY_VERSION_OVERRIDE = 'adr-105-override';
export const REFUND_POLICY_VERSION_LEGACY = 'legacy-full-refund';

export type RefundQuote = {
  gross: number;
  net: number;
  withheld: number;
  rateBps: number;
  version: string;
};

export function activeCommissionBps(): number {
  const configured = Number(optionalEnv('ECOVILA_REFUND_COMMISSION_BPS'));
  if (!Number.isFinite(configured)) return 0;
  if (configured > REFUND_COMMISSION_RATE_BPS) {
    // The public promise is capped at 1.4%. A mistyped secret must fail inert,
    // not silently turn a disclosure typo into money withheld from guests.
    console.warn(
      `Ignoring ECOVILA_REFUND_COMMISSION_BPS=${configured}; maximum is ${REFUND_COMMISSION_RATE_BPS}.`,
    );
    return 0;
  }
  return Math.max(0, Math.trunc(configured));
}

export function quoteRefund(
  gross: number,
  opts: { withhold?: boolean; rateBps?: number } = {},
): RefundQuote {
  if (!Number.isInteger(gross) || gross <= 0) {
    throw new HttpError(400, 'Refund gross amount must be a positive integer.');
  }

  if (opts.withhold === false) {
    return {
      gross,
      net: gross,
      withheld: 0,
      rateBps: 0,
      version: REFUND_POLICY_VERSION_OVERRIDE,
    };
  }

  // Cancellation paths pass a snapshot so every separate authorization uses
  // one policy decision even if the environment changes while the request runs.
  const rateBps = opts.rateBps ?? activeCommissionBps();
  if (
    !Number.isInteger(rateBps) || rateBps < 0 ||
    rateBps > REFUND_COMMISSION_RATE_BPS
  ) {
    throw new HttpError(500, 'Refund commission snapshot is invalid.');
  }
  const net = Math.min(
    gross,
    Math.max(1, Math.ceil((gross * (10_000 - rateBps)) / 10_000)),
  );
  return {
    gross,
    net,
    withheld: gross - net,
    rateBps,
    version: REFUND_POLICY_VERSION,
  };
}

export function sameRefundMoney(left: RefundQuote, right: RefundQuote): boolean {
  // These three values are the immutable money decision. Rate/version remain
  // audit evidence: legacy, override, and rounded-to-zero labels may differ
  // while authorizing exactly the same provider transfer.
  return left.gross === right.gross && left.net === right.net &&
    left.withheld === right.withheld;
}
