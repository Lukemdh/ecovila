import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('EcoVila Step 7 Supabase Edge Functions', () => {
  it('creates the Supabase Edge Function workspace with shared modules and tests', () => {
    for (const file of [
      'docs/supabase/config.toml',
      'docs/supabase/functions/deno.json',
      'docs/supabase/functions/import_map.json',
      'docs/supabase/functions/_shared/cors.ts',
      'docs/supabase/functions/_shared/env.ts',
      'docs/supabase/functions/_shared/http.ts',
      'docs/supabase/functions/_shared/maib.ts',
      'docs/supabase/functions/_shared/notifications.ts',
      'docs/supabase/functions/_shared/providers.ts',
      'docs/supabase/functions/_shared/reservations.ts',
      'docs/supabase/functions/_shared/supabaseAdmin.ts',
      'docs/supabase/functions/tests/reservations-test.ts',
    ]) {
      assert.ok(exists(file), `${file} should exist`);
    }
  });

  it('adds all Step 7 function entrypoints', () => {
    for (const name of [
      'create-reservation',
      'send-sms',
      'send-email',
      'expire-cash-reservations',
      'send-reminders',
      'maib-webhook',
    ]) {
      const file = `docs/supabase/functions/${name}/index.ts`;
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
      'index.html',
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

  it('configures public and server-only function JWT behavior explicitly', () => {
    const config = read('docs/supabase/config.toml');

    assert.match(
      config,
      /\[functions\.create-reservation\][\s\S]*?verify_jwt = true/i,
      'create-reservation should require a Supabase JWT from the browser anon key',
    );
    assert.match(
      config,
      /\[functions\.maib-webhook\][\s\S]*?verify_jwt = false/i,
      'maib-webhook must accept provider callbacks without Supabase JWTs',
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
    const providers = read('docs/supabase/functions/_shared/providers.ts');
    const maib = read('docs/supabase/functions/_shared/maib.ts');

    assert.match(providers, /https:\/\/api\.sms\.md\/v1\/send/, 'SMS.md REST endpoint should be used');
    assert.match(providers, /SMSMD_API_TOKEN/, 'SMS.md API token should be read from Edge Function env');
    assert.match(providers, /SMSMD_FROM/, 'SMS sender name should be read from Edge Function env');
    assert.match(providers, /https:\/\/api\.resend\.com\/emails/, 'Resend email endpoint should be used');
    assert.match(providers, /RESEND_API_KEY/, 'Resend API key should be read from Edge Function env');
    assert.match(providers, /RESEND_FROM_EMAIL/, 'Resend sender should be read from Edge Function env');
    assert.match(maib, /MAIB_SIGNATURE_KEY/, 'Maib callback signature key should be read from env');
    assert.match(maib, /verifyMaibSignature/, 'Maib webhook should have a reusable signature verifier');
  });

  it('adds idempotency storage for scheduled notification jobs', () => {
    const migrations = fs
      .readdirSync(path.join(root, 'docs/supabase/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => read(`docs/supabase/migrations/${file}`))
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
      'Edge reservation creation should group multi-room bookings for Maib webhooks',
    );
  });

  it('tracks notification delivery lifecycle on durable event rows', () => {
    const migration = read(
      'docs/supabase/migrations/20260517120000_step10_notification_delivery_tracking.sql',
    );

    assert.match(migration, /add column if not exists delivery_status text/i);
    assert.match(migration, /delivery_status in \('reserved', 'sent', 'failed'\)/i);
    assert.match(migration, /add column if not exists attempted_at timestamptz/i);
    assert.match(migration, /add column if not exists completed_at timestamptz/i);
    assert.match(migration, /add column if not exists last_error text/i);
    assert.match(migration, /add column if not exists provider_response jsonb/i);
    assert.match(migration, /alter column sent_at drop default/i);
    assert.match(migration, /alter column sent_at drop not null/i);
    assert.match(migration, /attempted_at = coalesce\(attempted_at, sent_at\)/i);
    assert.match(migration, /completed_at = coalesce\(completed_at, sent_at\)/i);
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
    assert.match(brief, /Step 11:\s+\*\*Maib ePay\*\*/i);
    assert.match(brief, /Step 12:\s+\*\*tophost Deployment\*\*/i);
    assert.match(step10, /SMS\.md/i);
    assert.match(step10, /Resend/i);
    assert.match(step10, /Supabase cron\/schedules/i);
    assert.doesNotMatch(
      step10,
      /Maib ePay|tophost\.md/i,
      'Step 10 should not still include Maib or tophost work',
    );
    assert.match(
      brief,
      /Cancellation:\s+guest can cancel at least 7 calendar days before arrival/i,
    );
  });
});
