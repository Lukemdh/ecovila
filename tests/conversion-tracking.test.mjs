import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readAllMigrations() {
  return fs
    .readdirSync(path.join(root, 'supabase/migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => read(`supabase/migrations/${file}`))
    .join('\n');
}

describe('EcoVila consent-gated conversion tracking foundation', () => {
  it('upgrades consent to one shared necessary/analytics/marketing state', () => {
    const main = read('js/main.js');
    const index = read('index.html');

    assert.match(main, /ecovila_cookie_consent_v2/);
    assert.match(main, /necessary:\s*true/);
    assert.match(main, /analytics:\s*Boolean/);
    assert.match(main, /marketing:\s*Boolean/);
    assert.match(main, /ecovila:consentchange/);
    assert.match(index, /data-cookie-category="analytics"/);
    assert.match(index, /data-cookie-category="marketing"/);
  });

  it('keeps tracking secrets out of public assets while loading only public IDs/config', () => {
    const frontend = [
      'index.html',
      'ru/index.html',
      'en/index.html',
      'rezervari.html',
      'checkout.html',
      'confirmare.html',
      'js/tracking.js',
      'js/tracking-config.js',
      'js/checkout.js',
    ].map(read).join('\n');

    assert.match(frontend, /js\/tracking-config\.js/);
    assert.match(frontend, /js\/tracking\.js/);
    assert.match(frontend, /metaPixelId/);
    assert.match(frontend, /googleAdsConversionId|googleMeasurementId/);

    for (const secret of [
      'META_CAPI_ACCESS_TOKEN',
      'GOOGLE_ADS_ACCESS_TOKEN',
      'GOOGLE_ADS_DEVELOPER_TOKEN',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]) {
      assert.doesNotMatch(frontend, new RegExp(secret), `${secret} should not appear in browser code`);
    }
  });

  it('stores shared event identifiers and browser match parameters on reservations', () => {
    const migrations = readAllMigrations();
    const reservations = read('supabase/functions/_shared/reservations.ts');
    const checkout = read('js/checkout.js');

    for (const column of [
      'tracking_event_id',
      'tracking_fbp',
      'tracking_fbc',
      'tracking_user_agent',
      'tracking_source_url',
    ]) {
      assert.match(migrations, new RegExp(`add column if not exists ${column}\\b`, 'i'));
      assert.match(reservations, new RegExp(`${column}:`, 'i'));
      assert.match(checkout, new RegExp(`${column}:`, 'i'));
    }

    assert.match(checkout, /getOrCreateTrackingEventId/);
    assert.match(checkout, /trackingEventId/);
  });

  it('adds server-side tracking endpoints and emits Purchase from payment confirmation flows', () => {
    const config = read('supabase/config.toml');
    const edgeTestSurface = read('tests/edge-functions.test.mjs');
    const bookingSettlement = read('supabase/functions/_shared/bookingSettlement.ts');
    const cashConfirmation = read('supabase/functions/confirm-reservation-payment/index.ts');
    const trackingFunction = read('supabase/functions/track-event/index.ts');
    const trackingShared = read('supabase/functions/_shared/tracking.ts');
    const migrations = readAllMigrations();

    assert.match(config, /\[functions\.track-event\][\s\S]*?verify_jwt = true/i);
    assert.match(edgeTestSurface, /track-event/);
    assert.match(trackingFunction, /Deno\.serve\(/);
    assert.match(trackingShared, /META_PIXEL_ID/);
    assert.match(trackingShared, /META_CAPI_ACCESS_TOKEN/);
    assert.match(trackingShared, /GOOGLE_ADS_DEVELOPER_TOKEN/);
    assert.match(trackingShared, /sha256Hex/);
    assert.match(trackingShared, /dispatchPurchaseTrackingOnce/);
    assert.match(bookingSettlement, /dispatchPurchaseTrackingOnce\(client,\s*paidReservations/);
    assert.match(cashConfirmation, /dispatchPurchaseTrackingOnce\(client,\s*settledReservations/);
    assert.match(migrations, /create table if not exists public\.tracking_events/i);
    assert.match(migrations, /unique \(event_name, event_id\)/i);
    assert.doesNotMatch(trackingShared, /console\.(log|info|error)\([^)]*guest_(email|phone)|event_source_url:\s*`[^`]*guest/i);
  });
});
