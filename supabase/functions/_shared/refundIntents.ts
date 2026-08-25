import { HttpError } from './http.ts';
import { quoteRefund, type RefundQuote } from './refundPolicy.ts';
import type { SupabaseClient } from './supabaseAdmin.ts';

export type QuotedChangeRefund = {
  changeId: string;
  quote: RefundQuote;
};

export type RefundPreviewPayment = {
  amount?: number | string | null;
  status?: string | null;
  refunded_at?: string | null;
};

type ScheduledMainRefund = {
  status?: string | null;
  eligible_at?: string | null;
  amount?: number | string | null;
};

type FullRefundIntentRpcRow = {
  main_status?: string | null;
  main_eligible_at?: string | null;
  main_amount?: number | string | null;
  main_gross_amount?: number | string | null;
  main_withheld?: number | string | null;
  main_rate_bps?: number | string | null;
  main_policy_version?: string | null;
  change_quotes?:
    | Array<{
      changeId?: string;
      gross?: number | string;
      net?: number | string;
      withheld?: number | string;
      rateBps?: number | string;
      version?: string;
    }>
    | null;
};

type RpcClient = SupabaseClient & {
  rpc(
    name: string,
    params: Record<string, unknown>,
  ): Promise<
    {
      data: FullRefundIntentRpcRow[] | FullRefundIntentRpcRow | null;
      error: { message: string; code?: string } | null;
    }
  >;
};

// The main payment and every paid difference form one policy decision. Keeping
// the complete write in PostgreSQL is the only way a validation/error on row B
// can roll row A back too; compensating updates in the Edge Function would open
// another crash window and recreate the mixed gross/net executor input.
export async function prepareFullRefundIntent(
  client: SupabaseClient,
  input: {
    payId: string;
    bookingGroupId: string;
    quote: RefundQuote;
    currency?: string;
    reason: string;
    source: string;
    eligibleAt?: string | null;
    allowCancelled?: boolean;
  },
): Promise<{
  refundScheduled: boolean;
  mainRow: ScheduledMainRefund;
  mainQuote: RefundQuote;
  changeQuotes: QuotedChangeRefund[];
}> {
  const { data, error } = await (client as RpcClient).rpc('prepare_full_refund_intent', {
    p_pay_id: input.payId,
    p_booking_group_id: input.bookingGroupId,
    p_main_amount: input.quote.net,
    p_main_gross_amount: input.quote.gross,
    p_main_withheld: input.quote.withheld,
    p_main_rate_bps: input.quote.rateBps,
    p_main_policy_version: input.quote.version,
    p_currency: input.currency || 'MDL',
    p_reason: input.reason,
    p_source: input.source,
    p_eligible_at: input.eligibleAt || null,
    p_allow_cancelled: Boolean(input.allowCancelled),
  });

  if (error) {
    if (String(error.code || '') === 'P0001') {
      throw new HttpError(409, error.message);
    }
    throw new Error(error.message);
  }
  const row = (Array.isArray(data) ? data[0] : data) || null;
  if (!row) throw new Error('The full refund intent could not be read back.');

  const mainQuote = rpcQuote({
    gross: row.main_gross_amount,
    net: row.main_amount,
    withheld: row.main_withheld,
    rateBps: row.main_rate_bps,
    version: row.main_policy_version,
  });
  const changeQuotes = (Array.isArray(row.change_quotes) ? row.change_quotes : []).map((entry) => ({
    changeId: String(entry.changeId || ''),
    quote: rpcQuote(entry),
  }));
  const status = String(row.main_status || '');

  return {
    refundScheduled: status !== 'succeeded' && status !== 'cancelled',
    mainRow: {
      status,
      eligible_at: row.main_eligible_at || null,
      amount: row.main_amount,
    },
    mainQuote,
    changeQuotes,
  };
}

export function refundCountsTowardGuestNotice(status: string | null | undefined): boolean {
  // Failed rows remain in the cron's retry set and normally will pay out, so
  // they remain part of the promised total. Cancelled is the sole terminal
  // state in which staff deliberately stopped the money from moving.
  return status !== 'cancelled';
}

export function shouldSweepPaidChangeRefunds(
  refund: { reason?: string | null; status?: string | null; eligible_at?: string | null },
  now = Date.now(),
): boolean {
  // ADR-104 partial cancellation spends the main payment's refund slot while
  // the remaining booking stays live. Its paid add-guest authorizations belong
  // to that live stay and must never be swept as a full cancellation.
  if (refund.reason === 'crm_partial_cancellation' || refund.status === 'cancelled') {
    return false;
  }
  return !refund.eligible_at || new Date(refund.eligible_at).getTime() <= now;
}

export function aggregateRefundQuotes(quotes: RefundQuote[]): RefundQuote {
  const gross = quotes.reduce((sum, quote) => sum + quote.gross, 0);
  const net = quotes.reduce((sum, quote) => sum + quote.net, 0);
  const withheld = quotes.reduce((sum, quote) => sum + quote.withheld, 0);
  return {
    gross,
    net,
    withheld,
    rateBps: quotes.length && quotes.every((quote) => quote.rateBps === quotes[0].rateBps)
      ? quotes[0].rateBps
      : 0,
    version: quotes.length && quotes.every((quote) => quote.version === quotes[0].version)
      ? quotes[0].version
      : 'mixed',
  };
}

// A consent preview may describe only money the cancellation path can still
// move. Terminal refund rows consume MAIB's one-refund slot, while an uncaptured
// or already-refunded payment has no refundable authorization. Invalid amounts
// degrade out of this read-only projection instead of letting quoteRefund's
// intentional fail-closed validation take down the whole manage page.
export function buildRefundPreviewQuote(
  payment: RefundPreviewPayment | null,
  refundStatus: string | null | undefined,
  additionalGrosses: Array<number | string | null | undefined>,
): RefundQuote | null {
  if (
    !payment || payment.status !== 'paid' || payment.refunded_at ||
    refundStatus === 'succeeded' || refundStatus === 'cancelled'
  ) {
    return null;
  }

  const quotableGrosses = [payment.amount, ...additionalGrosses]
    .map(Number)
    .filter((gross) => Number.isInteger(gross) && gross > 0);
  return quotableGrosses.length
    ? aggregateRefundQuotes(quotableGrosses.map((gross) => quoteRefund(gross)))
    : null;
}

function rpcQuote(input: {
  gross?: number | string | null;
  net?: number | string | null;
  withheld?: number | string | null;
  rateBps?: number | string | null;
  version?: string | null;
}): RefundQuote {
  const quote = {
    gross: Number(input.gross),
    net: Number(input.net),
    withheld: Number(input.withheld || 0),
    rateBps: Number(input.rateBps || 0),
    version: String(input.version || ''),
  };
  if (
    !Number.isInteger(quote.gross) || quote.gross <= 0 ||
    !Number.isInteger(quote.net) || quote.net <= 0 ||
    quote.gross !== quote.net + quote.withheld
  ) {
    throw new Error('The full refund intent returned an invalid quote.');
  }
  return quote;
}
