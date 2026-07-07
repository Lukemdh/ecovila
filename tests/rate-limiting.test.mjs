import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function fn(name) {
  return read(`supabase/functions/${name}/index.ts`);
}

// Every public Edge Function that is reachable without a staff JWT or the cron
// secret must route through the shared limiter (ADR-060). This guards against a
// new endpoint — or a refactor — silently dropping its rate limit.
const RATE_LIMITED_FUNCTIONS = [
  'reservation-lookup-start',
  'reservation-lookup-verify',
  'create-reservation',
  'track-event',
  'maib-mia-status',
  'reservation-change-status',
  'maib-mia-callback',
  'maib-create-payment',
  'reservation-change-create',
  'reservation-cancel',
  'reservation-extend-cash',
  'reservation-manage-details',
  'complaint-submit',
];

// maib-callback is gated by the MAIB HMAC signature, so it deliberately carries
// no rate limit (a per-IP cap could throttle the provider; globals are off the
// table for the whole site — see the ADR-060 decision below).

describe('EcoVila site-wide rate limiting (ADR-060)', () => {
  it('ships the limiter store, atomic function and pruning cron', () => {
    const migration = read('supabase/migrations/20260619140000_rate_limiting.sql');
    assert.match(migration, /create table if not exists public\.rate_limit_events/);
    assert.match(
      migration,
      /rate_limit_events_bucket_key_created_at_idx/,
      'count queries need the (bucket, key, created_at) index',
    );
    assert.match(
      migration,
      /create or replace function public\.rate_limit_hit/,
      'the count + insert must live in one DB round trip',
    );
    assert.match(migration, /security definer/i);
    assert.match(
      migration,
      /revoke all on function public\.rate_limit_hit/,
      'the limiter function must stay off the anon/authenticated API surface',
    );
    assert.match(
      migration,
      /grant execute on function public\.rate_limit_hit[\s\S]*to service_role/,
      'the Edge runtime calls the limiter as service_role; the grant must be explicit after the revoke',
    );
    assert.match(
      migration,
      /ecovila-prune-rate-limit-events/,
      'the events table must be pruned or it grows unbounded',
    );
    assert.match(
      migration,
      /ecovila-prune-lookup-codes/,
      'lookup codes are read on the lookup path and were never pruned before',
    );
  });

  it('fails open in the shared helper so a missing IP never locks out guests', () => {
    const helper = read('supabase/functions/_shared/rateLimit.ts');
    assert.match(helper, /if \(!key\) return true;/, 'a missing key must fail open');
    assert.match(
      helper,
      /allowing request/,
      'a limiter error must fail open (availability over strict enforcement)',
    );
    assert.match(helper, /return data !== false;/, 'only an explicit false blocks');
    assert.match(helper, /class RateLimitError extends HttpError/);
    assert.match(helper, /super\(429/, 'blocked requests must surface as HTTP 429');
  });

  for (const name of RATE_LIMITED_FUNCTIONS) {
    it(`${name} enforces a rate limit`, () => {
      const source = fn(name);
      assert.match(
        source,
        /from '\.\.\/_shared\/rateLimit\.ts'/,
        `${name} must import the shared limiter`,
      );
      assert.match(
        source,
        /assertRateLimit|assertRateLimits|enforceRateLimit/,
        `${name} must call the shared limiter`,
      );
    });
  }

  it('lookup-start keeps the ADR-059 rateLimited response shape and adds a per-IP key', () => {
    const source = fn('reservation-lookup-start');
    assert.match(source, /RATE_LIMITS\.lookupStartIp/);
    assert.match(
      source,
      /rateLimited: true/,
      'lookup-start must reuse the browser-handled rateLimited shape, not a 429',
    );
  });

  it('create-reservation bounds inventory holds per IP and per phone', () => {
    const source = fn('create-reservation');
    assert.match(source, /RATE_LIMITS\.createReservationIp/);
    assert.match(source, /RATE_LIMITS\.createReservationPhone/);
  });

  it('uses no global/shared-ceiling buckets (must not lock out all guests at once)', () => {
    // Product decision: per-IP + per-resource only. A site-wide ceiling would let
    // one attacker or spike deny booking to everyone.
    const helper = read('supabase/functions/_shared/rateLimit.ts');
    assert.doesNotMatch(helper, /:global'/, 'no `:global` bucket should remain in RATE_LIMITS');
    assert.doesNotMatch(helper, /Global:/, 'no `*Global` rule should remain in RATE_LIMITS');
    for (const name of RATE_LIMITED_FUNCTIONS) {
      assert.doesNotMatch(fn(name), /key:\s*'all'/, `${name} must not key a global bucket`);
    }
  });

  it('maib-callback stays unlimited (gated by the MAIB HMAC signature)', () => {
    const source = fn('maib-callback');
    assert.doesNotMatch(source, /rateLimit/, 'maib-callback must not import or call the limiter');
    assert.match(source, /verifyMaibCallbackSignature/, 'its gate is the signature check');
  });

  it('maib-create-payment validates the manage token and binds it to the booking phone', () => {
    const source = fn('maib-create-payment');
    assert.match(
      source,
      /validateManageTokenPhone/,
      'a known bookingGroupId alone must no longer mint a MAIB session',
    );
    assert.match(
      source,
      /assertBookingBelongsToPhone/,
      'the token phone must own the reservations being paid',
    );
  });

  it('surfaces a friendly rate-limit message to customers in every language', () => {
    const supabase = read('js/supabase.js');
    assert.match(supabase, /isRateLimited/, 'supabase helper must expose a 429 detector');
    assert.match(
      supabase,
      /context\?\.status/,
      'the detector must read the 429 from the FunctionsHttpError response',
    );

    const translations = read('js/translations.js');
    const count = (translations.match(/'common\.rateLimited'/g) || []).length;
    assert.equal(count, 3, 'common.rateLimited must be translated in ro, ru and en');

    // The customer-facing surfaces wire the message on their catch paths.
    for (const file of ['js/checkout.js', 'js/confirmare.js', 'js/gestionare.js', 'js/booking.js']) {
      assert.match(
        read(file),
        /isRateLimited\?\.\(error\)[\s\S]*?common\.rateLimited|common\.rateLimited[\s\S]*?isRateLimited/,
        `${file} must show common.rateLimited when a request is rate limited`,
      );
    }
  });

  it('does not rate-limit staff-only or cron-secret functions', () => {
    // These are gated by requireStaffRole / requireSharedSecret; adding a limiter
    // would be redundant and could throttle legitimate back-office bursts.
    for (
      const name of [
        'confirm-reservation-payment',
        'maib-refund',
        'send-sms',
        'send-email',
        'reservation-reschedule',
      ]
    ) {
      assert.match(fn(name), /requireStaffRole/, `${name} should stay staff-gated`);
    }
  });

  it('keeps every rate-limited function on the curated list (catch new endpoints)', () => {
    // A new public function should be a deliberate choice to add here, forcing a
    // rate-limit decision rather than shipping unprotected.
    const known = new Set([
      ...RATE_LIMITED_FUNCTIONS,
      // signature-gated (MAIB HMAC)
      'maib-callback',
      // staff-gated
      'confirm-reservation-payment',
      'maib-refund',
      'send-sms',
      'send-email',
      'reservation-cancel-notify',
      'reservation-reschedule',
      'send-checkin-welcome',
      // cron-secret gated
      'expire-cash-reservations',
      'reconcile-refunds',
      'send-reminders',
      'send-review-requests',
    ]);
    const dirs = readdirSync(join(root, 'supabase/functions'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '_shared' && entry.name !== 'tests')
      .map((entry) => entry.name);

    const unaccounted = dirs.filter((name) => !known.has(name));
    assert.deepEqual(
      unaccounted,
      [],
      `new Edge Function(s) ${unaccounted.join(', ')} must be classified for rate limiting`,
    );
  });
});
