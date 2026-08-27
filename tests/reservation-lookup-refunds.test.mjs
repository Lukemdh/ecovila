import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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
    // ADR-107 builds it into a local first so the "difference could not be
    // verified" sentence can be appended, so assert the helper still produces
    // the copy that reaches `message:` rather than a single literal call site.
    assert.match(
      cancelFunction,
      /const sms = cancellationConfirmationSms\(/,
      'managed cancellation should build its SMS with the shared cancellationConfirmationSms helper',
    );
    assert.match(
      cancelFunction,
      /message:\s*smsMessage/,
      'the SMS sent must be the one built from cancellationConfirmationSms',
    );
    // ADR-104 split the closing sentence out so a staff cancellation that
    // returned money can name the sum instead; the date-only wording is unchanged.
    assert.match(
      notifications,
      /Rezervarea dvs este anulata: \$\{checkIn\} - \$\{checkOut\}\.\$\{tail\}/,
      'cancellation SMS should use the reworded date-only copy (ADR-039)',
    );
    assert.match(
      notifications,
      /' Speram sa ne mai vedem in curand!'/,
      'the no-refund cancellation SMS keeps its closing line',
    );
  });

  it('discloses the whole refund quote across the main payment and paid differences', () => {
    const details = read('supabase/functions/reservation-manage-details/index.ts');
    const cancel = read('supabase/functions/reservation-cancel/index.ts');

    assert.match(details, /findRefundableChanges\(client, reservations\[0\]\.booking_group_id\)/);
    assert.match(details, /findMaibRefundSlot\(client, payment\.pay_id\)/);
    assert.match(details, /buildRefundPreviewQuote\(/);
    assert.match(details, /refundQuote: refundQuote/);

    assert.match(
      cancel,
      /prepareFullRefundIntent\(client, \{[\s\S]*?bookingGroupId: summary\.bookingGroupId/,
    );
    assert.match(cancel, /refundAmount: refundTotal\?\.net/);
    assert.match(cancel, /withheldCommission: refundTotal\?\.withheld/);
  });

  it('only returns cancellation refund totals when the refund was really scheduled', () => {
    const cancel = read('supabase/functions/reservation-cancel/index.ts');
    assert.match(
      cancel,
      /refundQuote: refundScheduled && refundQuote \? publicQuote\(refundQuote\) : null/,
    );
    assert.match(
      cancel,
      /refundTotal: refundScheduled && refundTotal \? publicQuote\(refundTotal\) : null/,
    );
  });

  it('renders real refund figures when a quote is present before and after cancellation, falling back to static copy when null', async () => {
    const gestionareSource = read('js/gestionare.js');

    // Static consumption guards:
    assert.match(
      gestionareSource,
      /hasRefundQuote[\s\S]*?confirmare\.refundEligibleQuote/,
      'pre-cancellation manage panel should render the quote key when refundQuote is present',
    );
    assert.match(
      gestionareSource,
      /confirmare\.refundEligibleQuote[\s\S]*?pricing\.formatMDL/,
      'pre-cancellation quote figures must be formatted with formatMDL',
    );
    assert.match(
      gestionareSource,
      /quote\s*=\s*\(result\?\.refundTotal[\s\S]*?\)\s*\?\s*result\.refundTotal\s*:\s*\(result\?\.refundQuote[\s\S]*?\)\s*\?\s*result\.refundQuote\s*:\s*null/,
      'post-cancellation must prefer refundTotal over refundQuote',
    );
    assert.match(
      gestionareSource,
      /confirmare\.cancelledWithScheduledQuote[\s\S]*?pricing\.formatMDL/,
      'post-cancellation quote figures must be formatted with formatMDL',
    );
    assert.doesNotMatch(
      gestionareSource,
      /Math\.round\(.*0\.014\)|140\s*\/\s*10000|\*\s*0\.014/,
      'browser must never compute commission locally; figures must come from the server quote',
    );

    // Runtime DOM execution:
    function createFakeEl(tagName = 'div') {
      const classes = new Set();
      const element = {
        tagName: tagName.toUpperCase(),
        children: [],
        hidden: false,
        disabled: false,
        textContent: '',
        onclick: null,
        querySelector(selector) {
          if (selector === 'span') {
            return this.children.find((c) => c.tagName === 'SPAN') || null;
          }
          return null;
        },
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          toggle(name, force) {
            const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
            if (shouldAdd) classes.add(name); else classes.delete(name);
            return shouldAdd;
          },
          contains(name) { return classes.has(name); },
        },
      };
      return element;
    }

    function createDoc() {
      const elements = new Map();
      function reg(selector, tag = 'div') {
        const el = createFakeEl(tag);
        elements.set(selector, el);
        return el;
      }

      const panel = reg('[data-manage-panel]', 'section');
      const policy = createFakeEl('p');
      panel.querySelector = (sel) => (sel === '.cf-manage__policy' ? policy : null);

      reg('[data-managed-status]', 'span');
      reg('[data-managed-refund-note]', 'p');
      reg('[data-managed-actions]', 'div');
      const cancelBtn = reg('[data-managed-cancel-btn]', 'button');
      cancelBtn.appendChild(createFakeEl('span'));
      reg('[data-managed-cancel-confirm]', 'div');
      const cancelYes = reg('[data-managed-cancel-yes]', 'button');
      cancelYes.appendChild(createFakeEl('span'));
      reg('[data-managed-cancel-no]', 'button');
      reg('[data-managed-action-error]', 'p');
      reg('[data-confirmare-lead]', 'p');

      return {
        document: {
          documentElement: { lang: 'ro' },
          querySelector: (sel) => elements.get(sel) || null,
          querySelectorAll: () => [],
          createElement: createFakeEl,
          addEventListener: () => {},
        },
        elements,
      };
    }

    const pricing = require('../js/pricing.js');
    const translations = require('../js/translations.js');

    let cancelHandler = async () => ({});
    const fakeSupabase = {
      getSupabaseClient: () => ({}),
      cancelManagedReservation: async (client, opts) => cancelHandler(client, opts),
      isRateLimited: () => false,
    };

    globalThis.EcoVilaPricing = pricing;
    globalThis.EcoVilaTranslations = translations;
    globalThis.EcoVilaSupabase = fakeSupabase;

    // 1. Pre-cancellation with quote:
    {
      const { document, elements } = createDoc();
      globalThis.document = document;

      const gestionare = require('../js/gestionare.js');
      const summary = { paymentType: 'card', paymentStatus: 'paid', refundable: true };
      const payment = { status: 'paid' };
      const quote = { gross: 6000, withheld: 84, net: 5916 };

      gestionare.renderManagePanel(summary, payment, 'res-1', 'token-1', quote);
      assert.equal(
        elements.get('[data-managed-refund-note]').textContent,
        `Ai achitat ${pricing.formatMDL(6000)}. Reținem un comision bancar de ${pricing.formatMDL(84)}, iar tu primești ${pricing.formatMDL(5916)}.`,
        'should render exact gross, withheld, and net figures when quote is present',
      );
    }

    // 2. Pre-cancellation with null quote (fallback):
    {
      const { document, elements } = createDoc();
      globalThis.document = document;

      const gestionare = require('../js/gestionare.js');
      const summary = { paymentType: 'card', paymentStatus: 'paid', refundable: true };
      const payment = { status: 'paid' };

      gestionare.renderManagePanel(summary, payment, 'res-1', 'token-1', null);
      assert.equal(
        elements.get('[data-managed-refund-note]').textContent,
        'Această rezervare este eligibilă pentru o rambursare de cel puțin 98,6% din sumă prin MAIB (EcoVila reține un comision de procesare bancară de până la 1,4%) dacă o anulezi acum.',
        'should fall back to static refundEligible copy when quote is null',
      );
    }

    // 3. Post-cancellation with scheduled refund quote:
    {
      const { document, elements } = createDoc();
      globalThis.document = document;
      const gestionare = require('../js/gestionare.js');

      cancelHandler = async () => ({
        ok: true,
        refundScheduled: true,
        refundQuote: { gross: 6000, withheld: 84, net: 5916 },
        refundTotal: { gross: 6000, withheld: 84, net: 5916 },
      });

      await gestionare.handleManagedCancel('res-1', 'token-1');
      assert.equal(
        elements.get('[data-managed-refund-note]').textContent,
        `Rezervarea a fost anulată. Îți restituim ${pricing.formatMDL(5916)} (am reținut ${pricing.formatMDL(84)} comision bancar) în aproximativ 60 de ore (2–3 zile lucrătoare).`,
        'post-cancellation should state actual refund and withheld sums with 60h expectation',
      );
      assert.equal(elements.get('[data-managed-status]').textContent, 'Rambursare programată');
    }

    // 4. Post-cancellation prefers refundTotal over refundQuote:
    {
      const { document, elements } = createDoc();
      globalThis.document = document;
      const gestionare = require('../js/gestionare.js');

      cancelHandler = async () => ({
        ok: true,
        refundScheduled: true,
        refundQuote: { gross: 6000, withheld: 84, net: 5916 },
        refundTotal: { gross: 7000, withheld: 98, net: 6902 },
      });

      await gestionare.handleManagedCancel('res-1', 'token-1');
      assert.equal(
        elements.get('[data-managed-refund-note]').textContent,
        `Rezervarea a fost anulată. Îți restituim ${pricing.formatMDL(6902)} (am reținut ${pricing.formatMDL(98)} comision bancar) în aproximativ 60 de ore (2–3 zile lucrătoare).`,
        'post-cancellation should use refundTotal aggregate across main and add-guests payments',
      );
    }

    // 5. Post-cancellation with null quote (scheduled fallback):
    {
      const { document, elements } = createDoc();
      globalThis.document = document;
      const gestionare = require('../js/gestionare.js');

      cancelHandler = async () => ({
        ok: true,
        refundScheduled: true,
        refundQuote: null,
        refundTotal: null,
      });

      await gestionare.handleManagedCancel('res-1', 'token-1');
      assert.equal(
        elements.get('[data-managed-refund-note]').textContent,
        'Rezervarea a fost anulată. Rambursarea prin MAIB va fi procesată în aproximativ 60 de ore (2–3 zile lucrătoare).',
        'post-cancellation with null quote should fall back to tightened scheduled copy',
      );
    }

    // 6. Post-cancellation without refund:
    {
      const { document, elements } = createDoc();
      globalThis.document = document;
      const gestionare = require('../js/gestionare.js');

      cancelHandler = async () => ({
        ok: true,
        refundScheduled: false,
        refunded: false,
        refundQuote: null,
        refundTotal: null,
      });

      await gestionare.handleManagedCancel('res-1', 'token-1');
      assert.equal(
        elements.get('[data-managed-refund-note]').textContent,
        'Rezervarea a fost anulată.',
      );
      assert.equal(elements.get('[data-managed-status]').textContent, 'Anulată');
    }
  });

  it('tightens post-cancellation confirmation copy while keeping pre-cancellation disclosures across all languages', () => {
    const translations = read('js/translations.js');

    // New quote keys must be present in ro, ru, en
    for (const key of [
      'confirmare.refundEligibleQuote',
      'confirmare.cancelledWithScheduledQuote',
      'confirmare.cancelledWithRefundQuote',
    ]) {
      const occurrences = (translations.match(new RegExp(`'${key}':`, 'g')) || []).length;
      assert.equal(occurrences, 3, `${key} must be defined in all 3 languages (ro, ru, en)`);
    }

    // Post-cancellation confirmations should be trimmed of redundant percentages
    for (const postKey of [
      'confirmare.cancelledWithRefund',
      'confirmare.cancelledWithScheduledRefund',
    ]) {
      const matches = [...translations.matchAll(new RegExp(`'${postKey}':\\s*'([^']*)'`, 'g'))];
      assert.equal(matches.length, 3, `${postKey} must exist in 3 languages`);
      for (const m of matches) {
        assert.doesNotMatch(
          m[1],
          /98[,.]6%|1[,.]4%/,
          `${postKey} should not contain redundant percentage disclaimers: "${m[1]}"`,
        );
      }
    }

    // Pre-cancellation notes and policies MUST retain explicit percentage disclosures
    for (const preKey of [
      'anulare.refundEligibleNote',
      'confirmare.refundEligible',
      'confirmare.refundPolicy',
      'faq.a7',
    ]) {
      const matches = [...translations.matchAll(new RegExp(`'${preKey}':\\s*'([^']*)'`, 'g'))];
      assert.equal(matches.length, 3, `${preKey} must exist in 3 languages`);
      for (const m of matches) {
        assert.match(
          m[1],
          /98[,.]6%/,
          `${preKey} must keep the "at least 98.6%" wording: "${m[1]}"`,
        );
        assert.match(
          m[1],
          /1[,.]4%/,
          `${preKey} must keep the "up to 1.4%" wording: "${m[1]}"`,
        );
      }
    }
  });
});
