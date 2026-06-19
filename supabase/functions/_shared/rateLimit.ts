import { HttpError } from './http.ts';

// Site-wide rate limiting (ADR-060).
//
// Every public Edge Function routes through `enforceRateLimit` /
// `assertRateLimit`, which call the atomic `rate_limit_hit` Postgres function
// (see migration 20260619140000_rate_limiting.sql). The DB is the shared
// counter because Edge isolates do not share memory.
//
// Keys are layered per endpoint:
//   - `ip`    — best-effort per-caller (Supabase sets the client IP as the
//               first x-forwarded-for hop). The primary control.
//   - `phone` / `group` / `change` — per-resource, bounds how hard a single
//               booking / number can be hammered.
// There are deliberately NO global/shared-ceiling buckets: a single site-wide
// cap would let one attacker or spike lock every guest out of booking. See the
// RATE_LIMITS comment for the accepted trade-off.

export type RateLimitRule = {
  bucket: string;
  limit: number;
  windowSeconds: number;
};

const MIN = 60;
const TEN_MIN = 10 * 60;

// One place to read and tune every limit on the site.
//
// Per-IP + per-resource only — by product decision there are NO global circuit
// breakers: a single shared ceiling would let one attacker (or one traffic
// spike) lock out every legitimate guest from booking, which is unacceptable
// collateral for this business. The trade-off accepted: an attacker on rotating
// IPs is not fully stopped (the cryptographic controls — manage tokens, MAIB
// signature, reconcile-against-MAIB — remain the integrity guarantees).
export const RATE_LIMITS = {
  // --- Tier 1: fully public (no token / secret / signature) ---------------
  // SMS + booking enumeration oracle (ADR-059). Phone is still capped 5/10min
  // inside reservation-lookup-start against reservation_lookup_codes.
  lookupStartIp: { bucket: 'lookup-start:ip', limit: 20, windowSeconds: TEN_MIN },
  // 4-digit code submission. Per-lookupId is already capped at 5 in the DB row.
  lookupVerifyIp: { bucket: 'lookup-verify:ip', limit: 40, windowSeconds: TEN_MIN },
  // Writes pending reservations that hold inventory; IP + phone bound the abuse.
  createReservationIp: { bucket: 'create-reservation:ip', limit: 10, windowSeconds: TEN_MIN },
  createReservationPhone: { bucket: 'create-reservation:phone', limit: 6, windowSeconds: TEN_MIN },
  // Analytics fan-out (outbound to the tracking provider). High-frequency by
  // design, so cap floods rather than normal use.
  trackEventIp: { bucket: 'track-event:ip', limit: 120, windowSeconds: MIN },
  // Complaints login + submit (ADR-068). Same SMS / enumeration shape as the
  // reservation lookup; per-phone is additionally capped at 5/10min inside
  // complaint-login-start against reservation_lookup_codes.
  complaintLoginStartIp: { bucket: 'complaint-login-start:ip', limit: 20, windowSeconds: TEN_MIN },
  complaintLoginVerifyIp: { bucket: 'complaint-login-verify:ip', limit: 40, windowSeconds: TEN_MIN },
  complaintSubmitIp: { bucket: 'complaint-submit:ip', limit: 10, windowSeconds: TEN_MIN },

  // --- Browser status polls (keyed by unguessable server UUIDs) -----------
  // Legit MIA polling is ~17/min/booking (3.5s) for up to ~6.5min; card 5s;
  // change 3s. Per-key budgets sit above that; IP budgets above a few tabs.
  // Unknown ids reconcile to a cheap not_found with no MAIB call.
  miaStatusIp: { bucket: 'mia-status:ip', limit: 150, windowSeconds: MIN },
  miaStatusGroup: { bucket: 'mia-status:group', limit: 40, windowSeconds: MIN },
  changeStatusIp: { bucket: 'change-status:ip', limit: 150, windowSeconds: MIN },
  changeStatusKey: { bucket: 'change-status:change', limit: 40, windowSeconds: MIN },

  // --- Provider callback ---------------------------------------------------
  // maib-mia-callback is unsigned (decisions.md): each valid id triggers an
  // outbound MAIB reconcile. The legit caller is MAIB's server, so a generous
  // per-IP cap blunts a single-source flood while sitting far above real volume;
  // a dropped callback is non-fatal (the browser poll reconciles too).
  // maib-callback is signature-gated, so it carries no rate limit at all.
  miaCallbackIp: { bucket: 'mia-callback:ip', limit: 60, windowSeconds: MIN },

  // --- Capability-gated (UUID / manage token), defence in depth -----------
  // maib-create-payment mints a MAIB session; it now also validates the manage
  // token (see the function), so this just bounds provider load per IP + group.
  createPaymentIp: { bucket: 'create-payment:ip', limit: 30, windowSeconds: TEN_MIN },
  createPaymentGroup: { bucket: 'create-payment:group', limit: 12, windowSeconds: TEN_MIN },
  changeCreateIp: { bucket: 'change-create:ip', limit: 20, windowSeconds: TEN_MIN },
  // Manage-token-gated guest actions (cancel / extend / details). The token is a
  // 256-bit capability; a light IP cap blunts token-guessing / DB-probe floods.
  manageActionIp: { bucket: 'manage-action:ip', limit: 60, windowSeconds: TEN_MIN },
} satisfies Record<string, RateLimitRule>;

type RpcResult = { data?: unknown; error?: { message?: string } | null };
type RpcClient = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult> };

// Best-effort client IP for rate-limit keying.
//
// On Supabase Edge Functions the client IP is the FIRST hop of x-forwarded-for
// (Supabase's own gateway sets it; their documented pattern reads [0]), so a
// caller-supplied x-forwarded-for does not become [0]. We additionally prefer a
// single-value vendor header when one is present — those are written by the
// trusted edge and cannot be forwarded by the caller. Two caveats drive the
// design and are why IP is NEVER the only control:
//   1. The header is empty on a meaningful share of Edge requests.
//   2. The trustworthy XFF position is platform-specific and could change.
// Every expensive endpoint therefore also enforces a `global` bucket that needs
// no IP and cannot be spoofed. Returns '' when unknown (limiter fails open per
// key, and the global ceiling still applies).
export function rateLimitIp(request: Request): string {
  const headers = request.headers;
  const vendor = headers.get('cf-connecting-ip') ||
    headers.get('fly-client-ip') ||
    headers.get('true-client-ip') ||
    headers.get('x-real-ip');
  return (vendor || headers.get('x-forwarded-for')?.split(',')[0] || '').trim();
}

export class RateLimitError extends HttpError {
  constructor(message = 'Too many requests. Please slow down and try again shortly.') {
    super(429, message);
  }
}

// Records a hit and returns whether the request is allowed. Fails OPEN on a
// missing key or any limiter error — keeping the booking flow available is
// worth more than strict enforcement, and the error is logged for visibility.
export async function enforceRateLimit(
  client: unknown,
  rule: RateLimitRule,
  key: string,
): Promise<boolean> {
  if (!key) return true;

  const { data, error } = await (client as RpcClient).rpc('rate_limit_hit', {
    p_bucket: rule.bucket,
    p_key: key,
    p_limit: rule.limit,
    p_window_seconds: rule.windowSeconds,
  });

  if (error) {
    console.error('rate_limit_hit failed; allowing request', error.message || error);
    return true;
  }

  return data !== false;
}

// Enforces a single rule and throws 429 when blocked.
export async function assertRateLimit(client: unknown, rule: RateLimitRule, key: string) {
  if (!(await enforceRateLimit(client, rule, key))) {
    throw new RateLimitError();
  }
}

// Enforces several (rule, key) pairs and throws 429 if any is blocked. Every
// pair is evaluated (each records its own hit) so layered buckets all advance.
export async function assertRateLimits(
  client: unknown,
  checks: Array<{ rule: RateLimitRule; key: string }>,
) {
  const results = await Promise.all(
    checks.map(({ rule, key }) => enforceRateLimit(client, rule, key)),
  );
  if (results.some((allowed) => allowed === false)) {
    throw new RateLimitError();
  }
}
