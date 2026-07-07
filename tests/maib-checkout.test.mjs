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

  it('sends the guest to the confirmation page instead of stranding them when payment start fails', async () => {
    const checkout = require('../js/checkout.js');
    const supabaseHelpers = require('../js/supabase.js');
    const location = { href: '' };
    const previousLocation = globalThis.location;
    const previousGetClient = supabaseHelpers.getSupabaseClient;
    const previousCreatePayment = supabaseHelpers.createMaibPaymentRequest;
    const previousConsoleError = console.error;

    globalThis.location = location;
    console.error = () => {};
    supabaseHelpers.getSupabaseClient = () => ({});
    supabaseHelpers.createMaibPaymentRequest = () => Promise.reject(new Error('gateway down'));

    try {
      await checkout.redirectAfterReservation(
        'reservation-a',
        'card',
        [{ id: 'reservation-a' }],
        { totalPrice: 3100 },
        { bookingGroupId: 'group-a', reservationIds: ['reservation-a'], manageToken: 'manage-token-a' },
        '+37360123456',
      );

      assert.equal(
        location.href,
        'confirmare.html?id=reservation-a&manage=manage-token-a',
        'a failed payment start should land on the confirmation page where the retry button lives',
      );
    } finally {
      globalThis.location = previousLocation;
      console.error = previousConsoleError;
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
      /processedAt: terminal && status !== 'paid' \? now : null/,
      'non-terminal callbacks stay unprocessed; paid rows are stamped only AFTER settlement (ADR-089)',
    );
    assert.match(
      callback,
      /markPaymentProcessed\(client, paymentRowId/,
      'a settled paid callback must stamp processed_at so retries can short-circuit',
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

  it('never lets the expiry cron cancel a reservation that was paid mid-run', () => {
    const expiry = read('supabase/functions/expire-cash-reservations/index.ts');

    assert.match(
      expiry,
      /cancelPendingReservations/,
      'all expiry cancellations should funnel through the guarded helper',
    );
    assert.match(
      expiry,
      /\.eq\('payment_status', 'pending'\)[\s\S]*?\.is\('cancelled_at', null\)[\s\S]*?\.select\('id'\)/,
      'the cancel UPDATE should re-assert pending and report which rows actually flipped',
    );
    assert.doesNotMatch(
      expiry,
      /\.update\(\{\s*payment_status: 'cancelled'/,
      'no expiry path should cancel by id without the pending guard',
    );
  });

  it('spares a card hold whose guest started a payment attempt within the grace window', () => {
    const expiry = read('supabase/functions/expire-cash-reservations/index.ts');

    assert.match(
      expiry,
      /ATTEMPT_GRACE_MINUTES\s*=\s*1/,
      'in-flight card holds should get a one-minute grace past their most recent attempt',
    );
    assert.match(
      expiry,
      /findGroupsWithRecentPaymentAttempt/,
      'the cron should look up booking groups with a fresh checkout session',
    );
    assert.match(
      expiry,
      /\.in\('status', \['created', 'pending'\]\)\s*\.gt\('created_at', threshold\)/,
      'recency should be measured from the latest active maib_payments attempt',
    );
    assert.match(
      expiry,
      /protectedGroups\.has\(reservation\.booking_group_id\)/,
      'reservations in a protected booking group should be excluded from cancellation',
    );
  });

  it('reinstates expired card holds when the paid callback loses the race against the cron', () => {
    // The settlement core (mark paid + reinstate + notify + track) is shared by
    // the card callback and the MIA confirmation path.
    const callback = read('supabase/functions/_shared/bookingSettlement.ts');

    assert.match(
      callback,
      /reinstateExpiredOnlineReservations/,
      'a paid callback should try to restore holds the cron already released',
    );
    assert.match(
      callback,
      /maib_session_expired[\s\S]*maib_payment_not_started/,
      'only cron-expired cancellations may be reinstated',
    );
    assert.match(
      callback,
      /manual refund required/,
      'an unrecoverable charge (room rebooked) should be flagged for manual refund',
    );
    assert.match(
      callback,
      /requiresManualReview: true/,
      'a paid callback that settles nothing should be flagged for review',
    );
    assert.match(
      callback,
      /\.eq\('payment_status', 'pending'\)\s*\.is\('cancelled_at', null\)\s*\.select\('id'\)/,
      'the paid UPDATE should report which reservations actually flipped before notifying',
    );
  });
});

describe('EcoVila MIA QR direct payment', () => {
  it('sends a MIA guest to the dedicated QR page instead of the maib checkout', async () => {
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
      calls.push(context);
      return Promise.resolve({ rail: 'mia', qrUrl: 'https://mia-qr.bnm.md/x', qrId: 'qr-1' });
    };

    try {
      await checkout.redirectAfterReservation(
        'reservation-a',
        'card',
        [{ id: 'reservation-a' }],
        { totalPrice: 3100 },
        {
          bookingGroupId: '00000000-0000-4000-8000-000000000001',
          reservationIds: ['reservation-a'],
          manageToken: 'manage-token-a',
        },
        '+37360123456',
      );

      assert.equal(
        location.href,
        'plata-mia.html?id=reservation-a&group=00000000-0000-4000-8000-000000000001&manage=manage-token-a',
        'a +373 (MIA) guest should land on the MIA QR page, not a maib checkout url',
      );
      assert.equal(calls[0].paymentRail, 'mia', 'the payment request should select the MIA rail');
    } finally {
      globalThis.location = previousLocation;
      supabaseHelpers.getSupabaseClient = previousGetClient;
      supabaseHelpers.createMaibPaymentRequest = previousCreatePayment;
    }
  });

  it('builds the MIA payment url with the booking group and manage token', () => {
    const checkout = require('../js/checkout.js');
    assert.equal(
      checkout.buildMiaPaymentUrl('reservation-a', 'group-a', 'manage-token-a'),
      'plata-mia.html?id=reservation-a&group=group-a&manage=manage-token-a',
    );
  });

  it('wires the MIA QR page, status poll and backend rail end to end', () => {
    assert.ok(exists('plata-mia.html'), 'the MIA QR page should exist');
    assert.ok(exists('js/plata-mia.js'), 'the MIA QR page controller should exist');
    assert.ok(exists('js/vendor/qrcode.js'), 'a vendored QR generator should be bundled');

    const page = read('plata-mia.html');
    assert.match(page, /js\/vendor\/qrcode\.js/, 'the page should load the QR library');
    assert.match(page, /js\/plata-mia\.js/, 'the page should load its controller');
    assert.match(page, /data-mia-qr/, 'the page should have a QR mount point');

    const controller = read('js/plata-mia.js');
    assert.match(controller, /fetchMiaPaymentStatus/, 'the page should poll the MIA status endpoint');
    assert.match(controller, /confirmare\.html/, 'a paid MIA guest should be sent to the confirmation page');

    const helpers = read('js/supabase.js');
    assert.match(helpers, /maib-mia-status/, 'the client should call the MIA status function');

    const config = read('supabase/config.toml');
    assert.match(
      config,
      /\[functions\.maib-mia-callback\][\s\S]*?verify_jwt = false/i,
      'the MIA callback is hit by MAIB and must skip Supabase JWT verification',
    );
    assert.match(
      config,
      /\[functions\.maib-mia-status\][\s\S]*?verify_jwt = true/i,
      'the browser status poll must require the Supabase anon JWT',
    );

    for (const name of ['maib-mia-callback', 'maib-mia-status']) {
      const file = `supabase/functions/${name}/index.ts`;
      assert.ok(exists(file), `${file} should exist`);
      assert.match(read(file), /Deno\.serve\(/, `${file} should register a Deno.serve handler`);
    }

    const maib = read('supabase/functions/_shared/maib.ts');
    assert.match(maib, /createMaibMiaQr/, 'the shared client should expose a MIA QR creator');
    assert.match(maib, /\/v2\/mia\/qr/, 'MIA QR creation should target the v2 MIA endpoint');
    assert.match(maib, /\/v2\/mia\/payments/, 'MIA confirmation should read the v2 MIA payments endpoint');

    const create = read('supabase/functions/maib-create-payment/index.ts');
    assert.match(
      create,
      /paymentRail === 'mia'[\s\S]*createMiaSession/,
      'create-payment should branch the MIA rail to a QR session',
    );

    const reconcile = read('supabase/functions/_shared/miaReconcile.ts');
    assert.match(
      reconcile,
      /getMaibMiaPaymentByOrderId/,
      'MIA reconciliation should re-verify payment against MAIB rather than trust the callback',
    );
  });
});
