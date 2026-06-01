import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return existsSync(join(root, relativePath));
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

  it('lets confirmation page render managed cancellation and refund state', () => {
    const html = read('confirmare.html');
    const confirmare = read('js/confirmare.js');
    const translations = read('js/translations.js');

    assert.match(html, /data-manage-panel/, 'confirmation page should include a manage panel');
    assert.match(html, /data-managed-cancel-btn/, 'confirmation page should include a managed cancel button');
    assert.match(confirmare, /loadManagedReservation/, 'confirmation script should fetch manage details');
    assert.match(confirmare, /handleManagedCancel/, 'confirmation script should cancel through the manage endpoint');
    assert.match(translations, /confirmare\.refundEligible/, 'refund eligibility copy should be translated');
    assert.match(translations, /confirmare\.refundIneligible/, 'non-refundable copy should be translated');
    assert.match(translations, /confirmare\.cashOfficeRefund/, 'cash office-only reimbursement copy should be translated');
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

  it('keeps the managed reservation panel in the first right-column slot', () => {
    const confirmare = read('js/confirmare.js');

    assert.match(
      confirmare,
      /showContentState\(summary\.paymentType \|\| 'card'[\s\S]*?hide\('\[data-success-panel\]'\)/,
      'managed reservation rendering should hide the success panel before showing the manage panel',
    );
  });

  it('sends the requested short SMS copy from managed cancellation', () => {
    const cancelFunction = read('supabase/functions/reservation-cancel/index.ts');

    assert.match(
      cancelFunction,
      /Rezervarea dvs \$\{period\} este anulata/,
      'managed cancellation SMS should include only the reservation dates in the requested copy',
    );
    assert.doesNotMatch(
      cancelFunction,
      /message:\s*`EcoVila: Rezervarea dvs\./,
      'managed cancellation SMS should not keep the longer prefixed room-copy variant',
    );
  });
});
