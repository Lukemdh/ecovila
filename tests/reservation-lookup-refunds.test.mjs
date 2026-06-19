import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return existsSync(join(root, relativePath));
}

function allMigrations() {
  return readdirSync(join(root, 'supabase/migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => read(`supabase/migrations/${file}`))
    .join('\n');
}

describe('EcoVila reservation lookup and refunds', () => {
  it('adds the public reservation lookup entry point on the booking page', () => {
    const html = read('rezervari.html');
    const translations = read('js/translations.js');
    const booking = read('js/booking.js');

    assert.match(html, /data-reservation-lookup-open/, 'booking page should expose the lookup trigger');
    assert.match(html, /data-reservation-lookup-modal/, 'booking page should render the lookup modal');
    assert.match(translations, /booking\.lookupCta/, 'lookup CTA should be translated');
    assert.match(
      booking,
      /startReservationLookup/,
      'booking page should start the SMS lookup flow from the modal',
    );
  });

  it('errors on the phone step when no active reservation matches the number', () => {
    const lookupStart = read('supabase/functions/reservation-lookup-start/index.ts');
    const booking = read('js/booking.js');
    const translations = read('js/translations.js');

    // The Edge Function tells the browser whether a reservation exists so the
    // guest is not advanced to a code step when no SMS was ever sent.
    assert.match(
      lookupStart,
      /hasReservations,/,
      'lookup-start should return hasReservations to the browser',
    );

    // The booking page stops on the phone step and surfaces the mismatch.
    assert.match(
      booking,
      /if \(result\.hasReservations === false\)/,
      'lookup should stop only on an explicit no-reservation result (fail-safe during rollout)',
    );
    assert.match(
      booking,
      /booking\.lookupNoReservations/,
      'lookup should show the no-reservation message on the phone step',
    );

    // A rate-limited response must not be mislabeled as "no reservation".
    assert.match(
      booking,
      /result\.rateLimited/,
      'lookup should handle the rate-limited response explicitly',
    );
    assert.match(
      booking,
      /booking\.lookupRateLimited/,
      'lookup should show a dedicated rate-limit message',
    );
    assert.match(
      translations,
      /'booking\.lookupRateLimited'/,
      'the rate-limit message should be translated',
    );
  });

  it('enforces country-specific phone lengths across guest entry points', () => {
    for (const file of ['js/checkout.js', 'js/anulare.js', 'js/booking.js']) {
      assert.match(
        read(file),
        /isValidGuestPhone/,
        `${file} should guard phone length per country`,
      );
    }
    assert.match(
      read('supabase/functions/_shared/reservations.ts'),
      /hasValidPhoneLength/,
      'the server should guard phone length per country',
    );
  });

  it('adds browser helpers for all reservation management Edge Functions', () => {
    const supabase = read('js/supabase.js');

    for (const functionName of [
      'reservation-lookup-start',
      'reservation-lookup-verify',
      'reservation-manage-details',
      'reservation-cancel',
    ]) {
      assert.match(supabase, new RegExp(`functions\\.invoke\\('${functionName}'`));
    }

    for (const helperName of [
      'startReservationLookup',
      'verifyReservationLookup',
      'fetchManagedReservationDetails',
      'cancelManagedReservation',
    ]) {
      assert.match(supabase, new RegExp(`\\b${helperName}\\b`));
    }
  });

  it('adds server-side reservation management functions and JWT config', () => {
    const config = read('supabase/config.toml');
    const cancelFunction = read('supabase/functions/reservation-cancel/index.ts');

    for (const functionName of [
      'reservation-lookup-start',
      'reservation-lookup-verify',
      'reservation-manage-details',
      'reservation-cancel',
    ]) {
      assert.ok(exists(`supabase/functions/${functionName}/index.ts`), `${functionName} should exist`);
      assert.match(
        config,
        new RegExp(`\\[functions\\.${functionName}\\][\\s\\S]*?verify_jwt = true`, 'i'),
        `${functionName} should require the browser Supabase JWT`,
      );
    }

    assert.ok(
      exists('supabase/migrations/20260527182000_reservation_lookup_refunds.sql'),
      'lookup/refund migration should exist',
    );
    assert.match(
      cancelFunction,
      /sendSms[\s\S]*sendEmail/,
      'managed cancellation should notify guests after cancellation',
    );
    assert.match(
      cancelFunction,
      /guest_cancellation/,
      'managed cancellation notifications should be idempotent per reservation',
    );
  });

  it('lets the management page render managed cancellation and refund state', () => {
    const html = read('gestionare.html');
    const gestionare = read('js/gestionare.js');
    const translations = read('js/translations.js');

    assert.match(html, /data-manage-panel/, 'management page should include a manage panel');
    assert.match(html, /data-managed-cancel-btn/, 'management page should include a managed cancel button');
    assert.match(gestionare, /loadManagedReservation/, 'management script should fetch manage details');
    assert.match(gestionare, /handleManagedCancel/, 'management script should cancel through the manage endpoint');
    assert.match(translations, /confirmare\.refundEligible/, 'refund eligibility copy should be translated');
    assert.match(translations, /confirmare\.refundIneligible/, 'non-refundable copy should be translated');
    assert.match(translations, /confirmare\.cashOfficeRefund/, 'cash office-only reimbursement copy should be translated');
  });

  it('requires manage-token proof for confirmation status, cash extension, and pending cancellation', () => {
    const supabase = read('js/supabase.js');
    const confirmare = read('js/confirmare.js');
    const gestionare = read('js/gestionare.js');
    const config = read('supabase/config.toml');
    const migrations = allMigrations();

    for (const script of [confirmare, gestionare]) {
      assert.match(
        script,
        /if \(!reservationId \|\| !manageToken\)/,
        'guest reservation pages should reject bare reservation-id URLs instead of loading UUID-only actions',
      );
      assert.doesNotMatch(
        script,
        /fetchPendingReservationStatus\(client, reservationId\)/,
        'status polling should not call a UUID-only status helper',
      );
    }
    assert.match(
      supabase,
      /functions\.invoke\('reservation-manage-details'/,
      'confirmation status should be read through the token-backed manage-details Edge Function',
    );
    assert.match(
      supabase,
      /functions\.invoke\('reservation-extend-cash'/,
      'cash extension should use a token-backed Edge Function',
    );
    assert.doesNotMatch(
      supabase,
      /rpc\('extend_cash_reservation',\s*\{\s*res_id:/,
      'browser code should not call the legacy UUID-only cash extension RPC',
    );
    assert.doesNotMatch(
      supabase,
      /rpc\('cancel_pending_reservation',\s*\{\s*res_id:/,
      'browser code should not call the legacy UUID-only pending cancellation RPC',
    );
    assert.match(
      config,
      /\[functions\.reservation-extend-cash\][\s\S]*?verify_jwt = true/i,
      'cash extension Edge Function should require the browser Supabase JWT',
    );
    for (const signature of [
      'public.get_pending_reservation_status(uuid)',
      'public.extend_cash_reservation(uuid)',
      'public.cancel_pending_reservation(uuid)',
    ]) {
      assert.match(
        migrations,
        new RegExp(`drop function if exists ${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
        `${signature} should be dropped by a follow-up migration`,
      );
    }
  });

  it('blocks late and cash online managed cancellation while keeping CRM MAIB refunds staff-driven', () => {
    const cancelFunction = read('supabase/functions/reservation-cancel/index.ts');
    const refundFunction = read('supabase/functions/maib-refund/index.ts');

    assert.match(
      cancelFunction,
      /summary\.paymentType === 'cash'[\s\S]*HttpError\(409/,
      'cash reservations should be refused by the online managed cancellation endpoint',
    );
    assert.match(
      cancelFunction,
      /!refundable[\s\S]*HttpError\(409/,
      'late reservations outside the public window should be refused online',
    );
    assert.match(
      cancelFunction,
      /paidCard && refundable/,
      'guest MAIB refunds should still require the public refund window',
    );
    assert.match(
      refundFunction,
      /bookingGroupId/,
      'staff MAIB refunds should be able to locate a payment by booking group from CRM',
    );
    assert.doesNotMatch(
      refundFunction,
      /isRefundEligible|refundEligibilityReason/,
      'staff MAIB refunds should not enforce the public guest cancellation window',
    );
  });

  it('keeps token-backed managed reservations aligned with the management status panels', () => {
    const gestionare = read('js/gestionare.js');

    assert.match(
      gestionare,
      /showContentState\(summary\.paymentType \|\| 'card', serverStatus\)[\s\S]*?renderManagePanel\(summary, details\.payment \|\| null, reservationId, manageToken\)/,
      'managed reservation rendering should keep the status panels current before showing the manage panel',
    );
    assert.match(
      gestionare,
      /summary\.paymentType === 'cash' && summary\.paymentStatus === 'pending'[\s\S]*?wireCashActions\(reservationId, manageToken\)/,
      'pending cash reservations should keep the timer panel and wire token-backed cash actions',
    );
  });

  it('sends the requested short SMS copy from managed cancellation', () => {
    const cancelFunction = read('supabase/functions/reservation-cancel/index.ts');
    const notifications = read('supabase/functions/_shared/notifications.ts');

    // ADR-039 relocated the cancellation SMS copy into the shared
    // cancellationConfirmationSms helper; reservation-cancel now calls it.
    assert.match(
      cancelFunction,
      /message:\s*cancellationConfirmationSms\(/,
      'managed cancellation should send the shared cancellation SMS via cancellationConfirmationSms',
    );
    assert.match(
      notifications,
      /Rezervarea dvs este anulata: \$\{checkIn\} - \$\{checkOut\}\. Speram sa ne mai vedem in curand!/,
      'cancellation SMS should use the reworded date-only copy (ADR-039)',
    );
  });
});
