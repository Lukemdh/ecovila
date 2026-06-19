import { assert, assertEquals, assertRejects } from 'std/assert';
import {
  assertRateLimit,
  assertRateLimits,
  enforceRateLimit,
  RATE_LIMITS,
  RateLimitError,
  rateLimitIp,
} from '../_shared/rateLimit.ts';

type RpcCall = { fn: string; args: Record<string, unknown> };

function fakeClient(reply: { data?: unknown; error?: { message?: string } | null }) {
  const calls: RpcCall[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(reply);
    },
  };
  return { client, calls };
}

const RULE = { bucket: 'test:ip', limit: 3, windowSeconds: 60 };

Deno.test('rateLimitIp prefers cf-connecting-ip, falls back to the first x-forwarded-for hop', () => {
  const cf = new Request('https://x', {
    headers: { 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
  });
  assertEquals(rateLimitIp(cf), '9.9.9.9');

  const xff = new Request('https://x', { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } });
  assertEquals(rateLimitIp(xff), '1.1.1.1');

  const none = new Request('https://x');
  assertEquals(rateLimitIp(none), '');
});

Deno.test('enforceRateLimit forwards bucket/limit/window to rate_limit_hit', async () => {
  const { client, calls } = fakeClient({ data: true });
  const allowed = await enforceRateLimit(client, RULE, '1.2.3.4');

  assert(allowed);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].fn, 'rate_limit_hit');
  assertEquals(calls[0].args, {
    p_bucket: 'test:ip',
    p_key: '1.2.3.4',
    p_limit: 3,
    p_window_seconds: 60,
  });
});

Deno.test('enforceRateLimit blocks only on an explicit false', async () => {
  assertEquals(await enforceRateLimit(fakeClient({ data: false }).client, RULE, 'ip'), false);
  assertEquals(await enforceRateLimit(fakeClient({ data: true }).client, RULE, 'ip'), true);
  // A null/absent data must not be read as blocked.
  assertEquals(await enforceRateLimit(fakeClient({ data: null }).client, RULE, 'ip'), true);
});

Deno.test('enforceRateLimit fails open on a missing key without calling the database', async () => {
  const { client, calls } = fakeClient({ data: false });
  const allowed = await enforceRateLimit(client, RULE, '');

  assert(allowed);
  assertEquals(calls.length, 0, 'no key means no rpc call');
});

Deno.test('enforceRateLimit fails open when the limiter errors', async () => {
  const allowed = await enforceRateLimit(
    fakeClient({ error: { message: 'boom' } }).client,
    RULE,
    'ip',
  );
  assert(allowed, 'availability beats strict enforcement on limiter failure');
});

Deno.test('assertRateLimit throws a 429 RateLimitError when blocked', async () => {
  const error = await assertRejects(
    () => assertRateLimit(fakeClient({ data: false }).client, RULE, 'ip'),
    RateLimitError,
  );
  assertEquals(error.status, 429);

  // Allowed path does not throw.
  await assertRateLimit(fakeClient({ data: true }).client, RULE, 'ip');
});

Deno.test('assertRateLimits evaluates every pair and throws if any is blocked', async () => {
  const { client, calls } = fakeClient({ data: false });
  await assertRejects(
    () =>
      assertRateLimits(client, [
        { rule: RATE_LIMITS.createReservationIp, key: 'ip' },
        { rule: RATE_LIMITS.createReservationPhone, key: '+37360000000' },
      ]),
    RateLimitError,
  );
  // Both buckets must be recorded even though the first already blocks, so every
  // layered key still advances.
  assertEquals(calls.length, 2);

  await assertRateLimits(fakeClient({ data: true }).client, [
    { rule: RATE_LIMITS.createReservationIp, key: 'ip' },
  ]);
});

Deno.test('RATE_LIMITS rules are well-formed and use unique buckets', () => {
  const buckets = new Set<string>();
  for (const [name, rule] of Object.entries(RATE_LIMITS)) {
    assert(rule.limit > 0, `${name} limit must be positive`);
    assert(rule.windowSeconds > 0, `${name} window must be positive`);
    assert(!buckets.has(rule.bucket), `duplicate bucket ${rule.bucket}`);
    buckets.add(rule.bucket);
  }
});
