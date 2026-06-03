import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function allMigrations() {
  return fs
    .readdirSync(path.join(root, 'supabase/migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => read(`supabase/migrations/${file}`))
    .join('\n');
}

describe('EcoVila Maib Checkout integration', () => {
  it('adds the Maib Checkout Edge Function entrypoints and JWT policy', () => {
    for (const name of ['maib-create-payment', 'maib-callback', 'maib-refund']) {
      const file = `supabase/functions/${name}/index.ts`;
      assert.ok(exists(file), `${file} should exist`);
      assert.match(read(file), /Deno\.serve\(/, `${file} should register a Deno.serve handler`);
    }

    const config = read('supabase/config.toml');
    assert.match(
      config,
      /\[functions\.maib-create-payment\][\s\S]*?verify_jwt = true/i,
      'browser-created payments should require a Supabase JWT',
    );
    assert.match(
      config,
      /\[functions\.maib-callback\][\s\S]*?verify_jwt = false/i,
      'Maib server callbacks should skip Supabase JWT verification',
    );
    assert.match(
      config,
      /\[functions\.maib-refund\][\s\S]*?verify_jwt = true/i,
      'refunds should require a staff Supabase JWT',
    );
    assert.match(
      read('supabase/functions/_shared/cors.ts'),
      /'null'/,
      'local file previews should pass CORS preflight during manual payment testing',
    );
  });

  it('stores Maib sessions by unique payment id and marks in-flight card bookings', () => {
    const migrations = allMigrations();

    assert.match(
      migrations,
      /create table if not exists public\.maib_payments/i,
      'Maib payments should have durable idempotency storage',
    );
    assert.match(
      migrations,
      /pay_id text primary key/i,
      'pay_id should be the unique callback idempotency key',
    );
    assert.match(
      migrations,
      /booking_group_id uuid not null/i,
      'payment attempts should link back to the EcoVila booking group',
    );
    assert.match(
      migrations,
      /alter table public\.reservations[\s\S]*add column if not exists payment_in_progress boolean/i,
      'card bookings should have an in-flight payment guard',
    );
    assert.match(
      migrations,
      /add column if not exists payment_session_expires_at timestamptz/i,
      'in-flight sessions should expire independently from cash timers',
    );
    assert.match(
      migrations,
      /alter table public\.maib_payments enable row level security/i,
      'new exposed-schema payment table should have RLS enabled',
    );
  });

  it('updates Maib shared helpers to use v2 Checkout endpoints and raw-body signatures', () => {
    const maib = read('supabase/functions/_shared/maib.ts');

    assert.match(maib, /MAIB_BASE_URL/, 'Maib base URL should come from env');
    assert.match(maib, /\/v2\/auth\/token/, 'Maib token endpoint should use Checkout v2 auth');
    assert.match(maib, /\/v2\/checkouts/, 'Maib session creation should use Checkout v2 hosted sessions');
    assert.match(maib, /\/v2\/payments\/\$\{encodeURIComponent\(payId\)\}\/refund/, 'refund helper should target v2 payments refund endpoint');
    assert.match(maib, /verifyMaibCallbackSignature/, 'raw callback signature verifier should be exported');
    assert.match(maib, /X-Signature-Timestamp/i, 'signature timestamp header should be required');
    assert.match(maib, /sha256=/, 'signature should be read from the sha256 header prefix');
    assert.match(maib, /rawBody[\s\S]*\.\$?\{?timestamp/i, 'signature input should combine raw body and timestamp');
  });

  it('removes the old placeholder Maib module and starts checkout through Supabase helpers', async () => {
    for (const file of [
      'payments/maib/README.md',
      'payments/maib/browser-adapter.js',
      'payments/maib/examples/callback-approved.json',
      'payments/maib/examples/callback-failed.json',
      'supabase/functions/maib-webhook/index.ts',
      'docs/PAYMENTS_OWNER_CHECKLIST.md',
    ]) {
      assert.equal(exists(file), false, `${file} should be removed`);
    }
  });

  it('starts hosted Maib checkout from checkout.js via the Edge Function helper', async () => {
    const checkout = require('../js/checkout.js');
    const supabaseHelpers = require('../js/supabase.js');
    const calls = [];
    const location = { href: '' };
    const previousLocation = globalThis.location;
    const previousGetClient = supabaseHelpers.getSupabaseClient;
    const previousCreatePayment = supabaseHelpers.createMaibPaymentRequest;

    globalThis.location = location;
    supabaseHelpers.getSupabaseClient = () => ({ marker: 'client' });
    supabaseHelpers.createMaibPaymentRequest = (client, context) => {
      calls.push({ client, context });
      return Promise.resolve({ payUrl: 'https://payments.maib.test/checkout' });
    };

    try {
      await checkout.redirectAfterReservation(
        'reservation-a',
        'card',
        [{ id: 'reservation-a', tracking_event_id: 'evt_maib_test' }],
        { totalPrice: 3100 },
        {
          bookingGroupId: '00000000-0000-4000-8000-000000000001',
          reservationIds: ['server-reservation-a'],
          manageToken: 'manage-token-a',
        },
        '+373 60 123 456',
      );

      assert.equal(location.href, 'https://payments.maib.test/checkout');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {
        client: { marker: 'client' },
        context: {
          primaryReservationId: 'reservation-a',
          bookingGroupId: '00000000-0000-4000-8000-000000000001',
          reservationIds: ['server-reservation-a'],
          manageToken: 'manage-token-a',
          totalPrice: 3100,
          selection: { totalPrice: 3100 },
          guestPhone: '+37360123456',
          paymentRail: 'mia',
          trackingEventId: 'evt_maib_test',
        },
      });
    } finally {
      globalThis.location = previousLocation;
      supabaseHelpers.getSupabaseClient = previousGetClient;
      supabaseHelpers.createMaibPaymentRequest = previousCreatePayment;
    }
  });

  it('keeps the Maib return page pending and polls for callback-confirmed status', () => {
    const confirmare = read('js/confirmare.js');

    assert.match(
      confirmare,
      /CARD_STATUS_POLL_MS/,
      'card confirmation should poll instead of trusting the redirect URL',
    );
    assert.match(
      confirmare,
      /fetchPendingReservationStatus/,
      'polling should read the reservation status from Supabase',
    );
    assert.match(
      confirmare,
      /startCardStatusPolling\(reservationId, manageToken, serverStatus\)/,
      'card reservations should start polling after the initial status render',
    );
    assert.match(
      confirmare,
      /payment_status === 'paid'/,
      'polling should stop when Maib callback marks the reservation paid',
    );
    assert.match(
      confirmare,
      /payment_status === 'cancelled'/,
      'polling should stop when Maib callback cancels the reservation',
    );
  });

  it('keeps non-terminal Maib callbacks pending instead of cancelling reservations', () => {
    const maib = read('supabase/functions/_shared/maib.ts');
    const callback = read('supabase/functions/maib-callback/index.ts');

    assert.match(
      maib,
      /normalizeMaibCallbackStatus/,
      'callback status normalization should be centralized',
    );
    assert.match(
      maib,
      /isZeroStatusCode\(processingStatusCode\)/,
      'Maib zero processing codes such as 00 and 000 should be treated consistently',
    );
    assert.match(
      maib,
      /return 'pending'/,
      'unknown callback statuses should normalize to pending, not failed',
    );
    assert.match(
      callback,
      /processedAt: terminal \? now : null/,
      'non-terminal callbacks should not be marked processed/idempotently final',
    );
    assert.match(
      callback,
      /status === 'pending'[\s\S]*decision: 'left_pending'/,
      'pending callbacks should be acknowledged without cancelling the reservation',
    );
  });

  it('clears stale Maib sessions separately from cash expiry', () => {
    const expiry = read('supabase/functions/expire-cash-reservations/index.ts');

    assert.match(expiry, /payment_in_progress/, 'stale online sessions should be handled');
    assert.match(expiry, /payment_session_expires_at/, 'online session expiry should be time boxed');
    assert.match(expiry, /maib_session_expired/, 'stale online sessions should have a distinct reason');
    assert.match(expiry, /maib_payment_not_started/, 'unstarted online bookings should be released');
  });
});
