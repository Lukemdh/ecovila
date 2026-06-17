import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('EcoVila Step 7 Supabase Edge Functions', () => {
  it('removes the old placeholder Maib payment module', () => {
    for (const file of [
      'payments/README.md',
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

  it('creates the Supabase Edge Function workspace with shared modules and tests', () => {
    for (const file of [
      'supabase/config.toml',
      'supabase/functions/deno.json',
      'supabase/functions/import_map.json',
      'supabase/functions/_shared/cors.ts',
      'supabase/functions/_shared/env.ts',
      'supabase/functions/_shared/http.ts',
      'supabase/functions/_shared/maib.ts',
      'supabase/functions/_shared/notifications.ts',
      'supabase/functions/_shared/providers.ts',
      'supabase/functions/_shared/reservations.ts',
      'supabase/functions/_shared/roomAssignment.ts',
      'supabase/functions/_shared/supabaseAdmin.ts',
      'supabase/functions/tests/reservations.test.ts',
    ]) {
      assert.ok(exists(file), `${file} should exist`);
    }
  });

  it('adds all Step 7 function entrypoints', () => {
    for (const name of [
      'create-reservation',
      'confirm-reservation-payment',
      'send-sms',
      'send-email',
      'expire-cash-reservations',
      'send-reminders',
      'maib-create-payment',
      'maib-callback',
      'maib-refund',
      'reservation-cancel-notify',
      'track-event',
    ]) {
      const file = `supabase/functions/${name}/index.ts`;
      assert.ok(exists(file), `${file} should exist`);
      assert.match(read(file), /Deno\.serve\(/, `${file} should register a Deno.serve handler`);
    }
  });

  it('keeps browser code away from private notification and payment credentials', () => {
    const frontend = [
      'js/supabase.js',
      'js/checkout.js',
      'checkout.html',
      'rezervari.html',
      'site.html',
    ].map(read).join('\n');

    for (const secret of [
      'SUPABASE_SERVICE_ROLE_KEY',
      'SMSMD_API_TOKEN',
      'RESEND_API_KEY',
      'MAIB_SIGNATURE_KEY',
      'ECOVILA_CRON_SECRET',
    ]) {
      assert.doesNotMatch(frontend, new RegExp(secret), `${secret} should not appear in public assets`);
    }
  });

  it('allows current Supabase browser client headers through Edge Function CORS preflight', () => {
    const cors = read('supabase/functions/_shared/cors.ts');

    assert.match(
      cors,
      /x-supabase-api-version/,
      'Supabase JS function calls should pass browser CORS preflight with current client headers',
    );
  });

  it('configures public and server-only function JWT behavior explicitly', () => {
    const config = read('supabase/config.toml');

    assert.match(
      config,
      /\[functions\.create-reservation\][\s\S]*?verify_jwt = true/i,
      'create-reservation should require a Supabase JWT from the browser anon key',
    );
    assert.match(
      config,
      /\[functions\.confirm-reservation-payment\][\s\S]*?verify_jwt = true/i,
      'confirm-reservation-payment should require a staff Supabase JWT before marking reservations paid',
    );
    assert.match(
      config,
      /\[functions\.maib-create-payment\][\s\S]*?verify_jwt = true/i,
      'maib-create-payment should require a Supabase JWT from the browser anon key',
    );
    assert.match(
      config,
      /\[functions\.maib-callback\][\s\S]*?verify_jwt = false/i,
      'maib-callback must accept provider callbacks without Supabase JWTs',
    );
    assert.match(
      config,
      /\[functions\.maib-refund\][\s\S]*?verify_jwt = true/i,
      'maib-refund should require a staff Supabase JWT',
    );
    assert.match(
      config,
      /\[functions\.reservation-cancel-notify\][\s\S]*?verify_jwt = true/i,
      'reservation-cancel-notify should require a staff Supabase JWT',
    );
    assert.match(
      config,
      /\[functions\.track-event\][\s\S]*?verify_jwt = true/i,
      'track-event should require a Supabase JWT from the browser anon key',
    );

    for (const cronFunction of ['expire-cash-reservations', 'send-reminders']) {
      assert.match(
        config,
        new RegExp(`\\[functions\\.${cronFunction}\\][\\s\\S]*?verify_jwt = false`, 'i'),
        `${cronFunction} should allow Supabase cron/provider scheduling and enforce its own secret`,
      );
    }
  });

  it('uses current provider endpoints and required secret names only inside Edge Functions', () => {
    const providers = read('supabase/functions/_shared/providers.ts');
    const sendSms = read('supabase/functions/send-sms/index.ts');
    const sendEmail = read('supabase/functions/send-email/index.ts');
    const maib = read('supabase/functions/_shared/maib.ts');

    assert.match(providers, /https:\/\/api\.sms\.md\/v1\/send/, 'SMS.md authorized send endpoint should be used');
    assert.match(providers, /url\.searchParams\.set\('token',\s*apiToken\)/, 'SMS.md token should be sent with the working legacy query parameter');
    assert.match(providers, /url\.searchParams\.set\('message',\s*payload\.message\)/, 'SMS.md payload should use the legacy message parameter');
    assert.match(providers, /SMSMD_API_TOKEN/, 'SMS.md API token should be read from Edge Function env');
    assert.match(providers, /SMSMD_FROM/, 'SMS sender name should be read from Edge Function env');
    assert.match(
      sendSms,
      /requireStaffRole\(request,\s*\['diana'\]\)/,
      'direct send-sms endpoint should be limited to Diana while shared notification sends remain server-side',
    );
    assert.match(providers, /https:\/\/api\.resend\.com\/emails/, 'Resend email endpoint should be used');
    assert.match(providers, /RESEND_API_KEY/, 'Resend API key should be read from Edge Function env');
    assert.match(providers, /RESEND_FROM_EMAIL/, 'Resend sender should be read from Edge Function env');
    assert.match(
      sendEmail,
      /requireStaffRole\(request,\s*\['diana'\]\)/,
      'direct send-email endpoint should be limited to Diana while shared notification sends remain server-side',
    );
    assert.match(maib, /MAIB_CLIENT_ID/, 'Maib client id should be read from env');
    assert.match(maib, /MAIB_CLIENT_SECRET/, 'Maib client secret should be read from env');
    assert.match(maib, /MAIB_SIGNATURE_KEY/, 'Maib callback signature key should be read from env');
    assert.match(maib, /MAIB_BASE_URL/, 'Maib base URL should be read from env');
    assert.match(maib, /verifyMaibCallbackSignature/, 'Maib callback should have a reusable raw-body signature verifier');
  });

  it('adds idempotency storage for scheduled notification jobs', () => {
    const migrations = fs
      .readdirSync(path.join(root, 'supabase/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => read(`supabase/migrations/${file}`))
      .join('\n');

    assert.match(
      migrations,
      /create table if not exists public\.notification_events/i,
      'scheduled reminders should have durable idempotency rows',
    );
    assert.match(
      migrations,
      /unique \(reservation_id, event_type\)/i,
      'notification_events should prevent duplicate reminder sends',
    );
    assert.match(
      migrations,
      /alter table public\.notification_events enable row level security/i,
      'notification_events should have RLS enabled in the exposed public schema',
    );
    assert.match(
      migrations,
      /alter table public\.reservations[\s\S]*add column if not exists booking_group_id uuid/i,
      'Edge reservation creation should group multi-room bookings for Maib callbacks',
    );
  });

  it('tracks notification delivery lifecycle on durable event rows', () => {
    const migration = read(
      'supabase/migrations/20260517120000_step10_notification_delivery_tracking.sql',
    );

    assert.match(migration, /add column if not exists delivery_status text/i);
    assert.match(migration, /delivery_status in \('reserved', 'sent', 'failed', 'abandoned'\)/i);
    assert.match(migration, /add column if not exists attempt_count integer/i);
    assert.match(migration, /attempt_count between 1 and 3/i);
    assert.match(migration, /add column if not exists attempted_at timestamptz/i);
    assert.match(migration, /add column if not exists completed_at timestamptz/i);
    assert.match(migration, /add column if not exists last_error text/i);
    assert.match(migration, /add column if not exists provider_response jsonb/i);
    assert.match(migration, /alter column sent_at drop default/i);
    assert.match(migration, /alter column sent_at drop not null/i);
    assert.match(migration, /attempted_at = coalesce\(attempted_at, sent_at\)/i);
    assert.match(migration, /completed_at = coalesce\(completed_at, sent_at\)/i);
  });

  it('reserves scheduled notification events before provider dispatch', () => {
    const notifications = read('supabase/functions/_shared/notifications.ts');
    const reminders = read('supabase/functions/send-reminders/index.ts');
    const expiry = read('supabase/functions/expire-cash-reservations/index.ts');
    const createReservation = read('supabase/functions/create-reservation/index.ts');
    const confirmReservationPayment = read('supabase/functions/confirm-reservation-payment/index.ts');
    const maibCallback = read('supabase/functions/maib-callback/index.ts');
    const bookingSettlement = read('supabase/functions/_shared/bookingSettlement.ts');

    assert.match(notifications, /reserveNotificationEvent/);
    assert.match(notifications, /markNotificationEventSent/);
    assert.match(notifications, /markNotificationEventFailed/);
    assert.match(notifications, /dispatchScheduledNotificationOnce/);
    assert.match(reminders, /dispatchScheduledNotificationOnce/);
    assert.match(expiry, /dispatchScheduledNotificationOnce/);
    assert.match(reminders, /skipped_duplicate/);
    assert.match(expiry, /skipped_duplicate/);
    assert.match(
      notifications,
      /export async function dispatchAndRecordNotification[\s\S]*return \{ result, recorded \};/,
      'non-cron notification callers should keep the public helper return shape',
    );
    assert.doesNotMatch(
      createReservation,
      /dispatchAndRecordNotification|composeBookingConfirmation|sendBookingConfirmations/,
      'reservation creation should not send confirmation SMS/email before payment is confirmed',
    );
    assert.match(
      confirmReservationPayment,
      /dispatchScheduledNotificationOnce/,
      'staff payment confirmation should record SMS failures and allow retries after marking cash paid',
    );
    assert.match(
      confirmReservationPayment,
      /requireStaffRole\(request,\s*\['diana'\]\)/,
      'staff payment confirmation should enforce the Diana role inside the service-role function',
    );
    assert.match(
      bookingSettlement,
      /dispatchPaymentConfirmationOnce/,
      'Maib confirmation should reserve notification events before sending',
    );
    assert.match(
      bookingSettlement,
      /delivery_status:\s*'reserved'/,
      'Maib confirmation should reserve notification events before sending',
    );
    assert.doesNotMatch(
      createReservation,
      /dispatchScheduledNotificationOnce/,
      'reservation creation should not dispatch notifications',
    );
    assert.doesNotMatch(
      bookingSettlement,
      /dispatchAndRecordNotification/,
      'Maib confirmation should not send before reserving idempotency rows',
    );
  });

  it('lets staff payment confirmation recover paid cash rows that missed confirmation', () => {
    const confirmReservationPayment = read('supabase/functions/confirm-reservation-payment/index.ts');

    assert.match(
      confirmReservationPayment,
      /\.in\('payment_status',\s*\[\s*'pending',\s*'paid'\s*\]\)/,
      'payment confirmation should also load paid cash reservations so missed confirmations can be recovered',
    );
    assert.match(
      confirmReservationPayment,
      /dispatchScheduledNotificationOnce/,
      'payment confirmation should let notification_events suppress sent duplicates and retry failed rows',
    );
  });

  it('stamps paid_at when cash or online reservations become paid', () => {
    const confirmReservationPayment = read('supabase/functions/confirm-reservation-payment/index.ts');
    const bookingSettlement = read('supabase/functions/_shared/bookingSettlement.ts');

    assert.match(confirmReservationPayment, /const now = new Date\(\)\.toISOString\(\)/);
    assert.match(
      confirmReservationPayment,
      /update\(\{\s*payment_status:\s*'paid',\s*cash_expires_at:\s*null,\s*paid_at:\s*now\s*\}\)/s,
      'staff cash confirmation should record the actual paid_at moment',
    );
    assert.match(
      bookingSettlement,
      /payment_status:\s*'paid'[\s\S]*payment_in_progress:\s*false[\s\S]*paid_at:\s*now/s,
      'Maib approved callbacks should record the actual paid_at moment',
    );
  });

  it('routes checkout reservation creation through the Edge Function', () => {
    const supabaseHelpers = read('js/supabase.js');
    const checkout = read('js/checkout.js');

    assert.match(
      supabaseHelpers,
      /createReservationRequest\(/,
      'Supabase browser helper should expose a create-reservation function invoker',
    );
    assert.match(
      checkout,
      /createReservationRequest/,
      'checkout submit flow should use the Edge Function helper',
    );
    assert.doesNotMatch(
      checkout,
      /insertPendingReservations\(client, payloads\)/,
      'checkout should no longer insert guest reservations directly once Step 7 exists',
    );
  });

  it('splits the production rollout into notifications, Maib, and tophost steps', () => {
    const brief = read('docs/ECOVILA_PROJECT_BRIEF.md');
    const step10 = brief.match(/Step 10:[\s\S]*?(?=Step 11:)/i)?.[0] || '';

    assert.match(brief, /Step 10:\s+\*\*Production Notifications & Scheduling\*\*/i);
    assert.match(brief, /Step 11:\s+\*\*Maib online payments\*\*/i);
    assert.match(brief, /Step 12:\s+\*\*tophost Deployment\*\*/i);
    assert.match(step10, /SMS\.md/i);
    assert.match(step10, /Resend/i);
    assert.match(step10, /Supabase cron\/schedules/i);
    assert.doesNotMatch(
      step10,
      /Maib (?:ePay|online payments)|tophost\.md/i,
      'Step 10 should not still include Maib or tophost work',
    );
    assert.match(
      brief,
      /Cancellation:\s+guest can cancel online when there are at least 7 calendar days before arrival/i,
    );
  });
});
