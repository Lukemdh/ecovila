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

function footerMarkup(html) {
  const match = html.match(/<footer[\s\S]*?<\/footer>/);
  return match ? match[0] : '';
}

function loadCheckout() {
  return require('../js/checkout.js');
}

// Stored selections are rejected when their check-in is already in the past
// (ADR-090), so fixtures compute stay dates relative to the real clock.
function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const FUTURE_CHECK_IN = isoDaysFromNow(30);
const FUTURE_CHECK_OUT = isoDaysFromNow(32);
const FUTURE_NIGHT_OUT = isoDaysFromNow(31);

describe('EcoVila Step 5 checkout', () => {
  it('creates the checkout page files and loads the booking dependencies', () => {
    for (const file of ['checkout.html', 'js/checkout.js', 'css/checkout.css']) {
      assert.ok(exists(file), `${file} should exist`);
    }

    const html = read('checkout.html');

    assert.match(html, /data-checkout-app/, 'checkout app hook should exist');
    assert.match(html, /css\/main\.css/, 'checkout page should use the shared public design system');
    assert.match(html, /css\/checkout\.css/, 'checkout page should use checkout styles');
    // Vendored, version-pinned build (ADR-091) — never a floating-major CDN tag.
    assert.match(html, /src="js\/vendor\/supabase\.js(?:\?v=[^"]*)?"/, 'checkout page should load the vendored Supabase JS');
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net/, 'checkout page must not load scripts from a CDN');

    for (const script of [
      'js/translations.js',
      'js/pricing.js',
      'js/supabase.js',
      'js/main.js',
      'js/checkout.js',
    ]) {
      assert.match(html, new RegExp(`src="${script}(?:\\?v=[^"]*)?"`), `${script} should be loaded`);
    }
  });

  it('uses the alternate logo artwork in the checkout footer', () => {
    const html = read('checkout.html');
    const footer = footerMarkup(html);

    assert.match(footer, /src="\/assets\/logo-trim\.png"/, 'checkout footer should use the trimmed PNG logo');
  });

  it('renders a reservation summary, guest form, GDPR consent, and payment selection hooks', () => {
    const html = read('checkout.html');

    for (const hook of [
      'data-checkout-empty',
      'data-checkout-content',
      'data-summary-dates',
      'data-summary-guests',
      'data-summary-accommodation',
      'data-summary-rooms',
      'data-summary-nights',
      'data-summary-breakdown',
      'data-summary-total',
      'data-checkout-form',
      'data-guest-first-name',
      'data-guest-last-name',
      'data-guest-phone',
      'data-guest-email',
      'data-gdpr-consent',
      'data-payment-option="card"',
      'data-payment-option="cash"',
      'data-online-payment-title',
      'data-cash-disclaimer',
      'data-checkout-submit',
      'data-checkout-error',
      'data-checkout-status',
    ]) {
      assert.match(html, new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${hook} should exist`);
    }

    assert.match(html, /politica-confidentialitate\.html"[^>]*target="_blank"/, 'privacy policy link should open in a new tab');
    assert.match(html, /termeni-conditii\.html"[^>]*target="_blank"/, 'terms link should open in a new tab');
  });

  it('omits the removed checkout summary and billable guest helper copy', () => {
    const html = read('checkout.html');
    const translations = read('js/translations.js');
    const checkoutScript = read('js/checkout.js');

    assert.doesNotMatch(html, /checkout\.summaryLead/);
    assert.doesNotMatch(translations, /checkout\.summaryLead/);
    assert.doesNotMatch(translations, /checkout\.breakdownGuests/);
    assert.doesNotMatch(checkoutScript, /checkout\.breakdownGuests/);
  });

  it('omits the removed payment method description copy', () => {
    const html = read('checkout.html');
    const translations = read('js/translations.js');
    const checkoutScript = read('js/checkout.js');

    for (const key of ['checkout.payMiaMeta', 'checkout.payCardMeta', 'checkout.payCashMeta']) {
      const pattern = new RegExp(key.replace('.', '\\.'));
      assert.doesNotMatch(html, pattern);
      assert.doesNotMatch(translations, pattern);
      assert.doesNotMatch(checkoutScript, pattern);
    }

    assert.doesNotMatch(html, /data-online-payment-meta/);
    assert.doesNotMatch(checkoutScript, /data-online-payment-meta/);
  });

  it('hides the room number summary row until the guest selected a number', () => {
    const html = read('checkout.html');
    const checkout = loadCheckout();

    assert.match(
      html,
      /<div[^>]*data-summary-rooms-row[^>]*hidden[^>]*>[\s\S]*data-summary-rooms/,
      'room number row should be hidden by default',
    );
    assert.equal(checkout.hasSelectedRoomNumber({ roomExplicitlySelected: false, roomNumbers: [8] }), false);
    assert.equal(checkout.hasSelectedRoomNumber({ roomExplicitlySelected: true, roomNumbers: [] }), false);
    assert.equal(checkout.hasSelectedRoomNumber({ roomExplicitlySelected: true, roomNumbers: [8] }), true);
  });

  it('adds checkout translation keys for every public language', () => {
    const translations = read('js/translations.js');

    for (const lang of ['ro', 'ru', 'en']) {
      const langBlock = translations.match(new RegExp(`${lang}:\\s*{[\\s\\S]*?\\n  }[,\\n]`));
      assert.ok(langBlock, `${lang} translation block should exist`);

      for (const key of [
        'checkout.title',
        'checkout.lead',
        'checkout.summaryTitle',
        'checkout.guestTitle',
        'checkout.firstName',
        'checkout.lastName',
        'checkout.phone',
        'checkout.email',
        'checkout.gdpr',
        'checkout.paymentTitle',
        'checkout.payMia',
        'checkout.payCard',
        'checkout.payCash',
        'checkout.intlBlockedLead',
        'checkout.intlBlockedOr',
        'checkout.cashDisclaimer',
        'checkout.reserve',
        'checkout.emptyTitle',
        'checkout.backToBooking',
        'checkout.errorRequired',
        'checkout.errorPhone',
        'checkout.errorEmail',
        'checkout.errorGdpr',
        'checkout.errorSupabaseConfig',
      ]) {
        assert.match(langBlock[0], new RegExp(`['"]${key}['"]`), `${lang}.${key} should exist`);
      }
    }
  });

  it('validates stored checkout selections before reservation creation', () => {
    const checkout = loadCheckout();
    const validSelection = {
      type: 'small',
      checkIn: FUTURE_CHECK_IN,
      checkOut: FUTURE_CHECK_OUT,
      adults: 2,
      kidsAges: [5],
      units: 1,
      roomIds: ['room-8'],
      roomNumbers: [8],
      totalPrice: 5000,
      pricingBreakdown: {
        total: 5000,
        nightlyBreakdown: [],
      },
    };

    assert.equal(checkout.validateCheckoutSelection(validSelection).valid, true);
    assert.equal(checkout.validateCheckoutSelection({ ...validSelection, checkOut: FUTURE_CHECK_IN }).valid, false);
    assert.equal(checkout.validateCheckoutSelection({ ...validSelection, adults: 0 }).valid, false);
    assert.equal(checkout.validateCheckoutSelection({ ...validSelection, roomIds: [] }).valid, false);

    // A stored selection whose check-in has already passed (a tab reopened days
    // later) must be rejected — it could never be reserved (ADR-090).
    assert.equal(
      checkout.validateCheckoutSelection({
        ...validSelection,
        checkIn: '2026-06-01',
        checkOut: '2026-06-03',
      }).valid,
      false,
    );
  });

  it('validates guest details, international phone format, email, and GDPR consent', () => {
    const checkout = loadCheckout();

    assert.equal(
      checkout.validateGuestDetails({
        firstName: 'Ana',
        lastName: 'Munteanu',
        phone: '+37360123456',
        email: 'ana@example.md',
        gdprAccepted: true,
      }).valid,
      true,
    );
    assert.equal(checkout.normalizeInternationalPhone('  +40 721 234 567 '), '+40721234567');
    assert.equal(
      checkout.validateGuestDetails({
        firstName: 'Elena',
        lastName: 'Popescu',
        phone: '+40721234567',
        email: 'elena@example.ro',
        gdprAccepted: true,
      }).valid,
      true,
    );
    assert.equal(checkout.validateGuestDetails({ firstName: '', lastName: 'Munteanu', phone: '+37360123456', email: 'ana@example.md', gdprAccepted: true }).valid, false);
    assert.equal(checkout.validateGuestDetails({ firstName: 'Ana', lastName: 'Munteanu', phone: '+373123', email: 'ana@example.md', gdprAccepted: true }).errors[0], 'checkout.errorPhone');
    assert.equal(checkout.validateGuestDetails({ firstName: 'Elena', lastName: 'Popescu', phone: '0721234567', email: 'elena@example.ro', gdprAccepted: true }).errors[0], 'checkout.errorPhone');
    assert.equal(checkout.validateGuestDetails({ firstName: 'Ana', lastName: 'Munteanu', phone: '+37360123456', email: 'ana.example.md', gdprAccepted: true }).errors[0], 'checkout.errorEmail');
    assert.equal(checkout.validateGuestDetails({ firstName: 'Ana', lastName: 'Munteanu', phone: '+37360123456', email: 'ana@example.md', gdprAccepted: false }).errors[0], 'checkout.errorGdpr');
  });

  it('enforces country-specific phone lengths for +373, +40, and +380', () => {
    const checkout = loadCheckout();

    // Valid national lengths: Moldova 8 digits, Romania/Ukraine 9 digits.
    assert.equal(checkout.isValidGuestPhone('+37360123456'), true);
    assert.equal(checkout.isValidGuestPhone('+40721234567'), true);
    assert.equal(checkout.isValidGuestPhone('+380501234567'), true);

    // Wrong lengths are rejected even though they fit the generic 8–15 rule.
    assert.equal(checkout.isValidGuestPhone('+373601234567'), false); // +373 with 9 digits
    assert.equal(checkout.isValidGuestPhone('+3736012345'), false); // +373 with 7 digits
    assert.equal(checkout.isValidGuestPhone('+4072123456'), false); // +40 with 8 digits
    assert.equal(checkout.isValidGuestPhone('+38050123456'), false); // +380 with 8 digits

    // Other countries keep the generic international length rule.
    assert.equal(checkout.isValidGuestPhone('+15551234567'), true);

    // A bare Moldovan number that lost its "+373" must not slip through as a
    // "foreign" number: the country code is required (non-zero, 10–15 digits).
    assert.equal(checkout.isValidGuestPhone('+60843453'), false); // bare MD mobile with a stray "+"
    assert.equal(checkout.isValidGuestPhone('+069120220'), false); // a country code never starts with 0
    assert.equal(checkout.isValidGuestPhone('+6012022'), false); // too short for any country code

    // Non-string / empty input is rejected without throwing.
    assert.equal(checkout.isValidGuestPhone(undefined), false);
    assert.equal(checkout.isValidGuestPhone(null), false);
    assert.equal(checkout.isValidGuestPhone(''), false);

    // The mismatch surfaces through validateGuestDetails as the phone error.
    assert.equal(
      checkout.validateGuestDetails({
        firstName: 'Ion',
        lastName: 'Rusu',
        phone: '+373601234567',
        email: 'ion@example.md',
        gdprAccepted: true,
      }).errors[0],
      'checkout.errorPhone',
    );
  });

  it('pre-fills the phone field with a deletable +373 and enforces a leading +', () => {
    const html = read('checkout.html');
    const checkoutScript = read('js/checkout.js');
    const phoneInput = html.match(/<input[^>]*data-guest-phone[^>]*>/)?.[0] || '';

    // +373 is pre-written as an editable value (not just a placeholder),
    // and the script enforces the "always starts with +" rule on input.
    assert.match(phoneInput, /\svalue="\+373"/);
    assert.match(checkoutScript, /function enforcePhonePlus/);
    assert.match(checkoutScript, /enforcePhonePlus\(phoneInput\)/);
  });

  it('routes Moldovan online payments through MIA and other valid phones through card', () => {
    const checkout = loadCheckout();

    assert.equal(checkout.getPaymentRail('+37360123456'), 'mia');
    assert.equal(checkout.getPaymentRail('+40721234567'), 'card');
    assert.deepEqual(checkout.getOnlinePaymentCopy('+37360123456'), {
      titleKey: 'checkout.payMia',
    });
    assert.deepEqual(checkout.getOnlinePaymentCopy('+40721234567'), {
      titleKey: 'checkout.payCard',
    });
  });

  it('flags non-+373 phones as foreign so online checkout can be blocked', () => {
    const checkout = loadCheckout();

    // Moldova, and a Moldovan number still being typed, are never foreign.
    assert.equal(checkout.isForeignPhone('+37360123456'), false);
    assert.equal(checkout.isForeignPhone('+373'), false);
    assert.equal(checkout.isForeignPhone('+37'), false);
    assert.equal(checkout.isForeignPhone('+3'), false);
    assert.equal(checkout.isForeignPhone('+'), false);
    assert.equal(checkout.isForeignPhone(''), false);
    assert.equal(checkout.isForeignPhone(undefined), false);

    // Real foreign country codes are blocked — Romania, Ukraine, US, Italy —
    // even when the input arrives spaced/formatted.
    assert.equal(checkout.isForeignPhone('+40721234567'), true);
    assert.equal(checkout.isForeignPhone('+380501234567'), true);
    assert.equal(checkout.isForeignPhone('+15551234567'), true);
    assert.equal(checkout.isForeignPhone('+39'), true);
    assert.equal(checkout.isForeignPhone('  +40 721 234 567 '), true);

    // A bare MD number that lost its "+373" ("+0…") is a typo, not a foreign
    // booking: it stays false so the country-code error surfaces (ADR-081).
    assert.equal(checkout.isForeignPhone('+069120220'), false);
  });

  it('wires the international contact notice into the checkout page and script', () => {
    const html = read('checkout.html');
    const checkoutScript = read('js/checkout.js');

    assert.match(html, /data-international-notice/, 'notice element hook should exist');
    assert.match(html, /href="tel:\+37360120220"/, 'notice should expose a tap-to-call number');
    assert.match(html, /href="mailto:rezervari@ecovila\.md"/, 'notice should expose a mailto link');

    // The script toggles the notice, keys off isForeignPhone, and locks the
    // submit button for foreign guests.
    assert.match(checkoutScript, /data-international-notice/);
    assert.match(checkoutScript, /isForeignPhone/);
    assert.match(checkoutScript, /submitButton\.disabled = foreign/);
  });

  it('builds pending reservation payloads with client-side IDs and a 30 minute cash expiry', () => {
    const checkout = loadCheckout();
    const ids = ['reservation-a', 'reservation-b'];
    const payloads = checkout.buildReservationPayloads(
      {
        type: 'small',
        checkIn: FUTURE_CHECK_IN,
        checkOut: FUTURE_CHECK_OUT,
        adults: 2,
        kidsAges: [5],
        roomIds: ['room-a', 'room-b'],
        roomNumbers: [8, 7],
        roomExplicitlySelected: true,
        totalPrice: 5201,
      },
      {
        firstName: 'Ana',
        lastName: 'Munteanu',
        phone: '+37360123456',
        email: 'ana@example.md',
      },
      'cash',
      {
        now: new Date('2026-05-07T09:00:00.000Z'),
        createId: () => ids.shift(),
      },
    );

    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads.map((payload) => payload.id), ['reservation-a', 'reservation-b']);
    assert.deepEqual(payloads.map((payload) => payload.room_id), ['room-a', 'room-b']);
    assert.deepEqual(payloads.map((payload) => payload.total_price), [2601, 2600]);
    assert.deepEqual(payloads.map((payload) => payload.guest_language), ['ro', 'ro']);
    assert.deepEqual(payloads.map((payload) => payload.cash_expires_at), [
      '2026-05-07T09:30:00.000Z',
      '2026-05-07T09:30:00.000Z',
    ]);
    assert.deepEqual(payloads[0], {
      id: 'reservation-a',
      room_id: 'room-a',
      guest_first_name: 'Ana',
      guest_last_name: 'Munteanu',
      guest_phone: '+37360123456',
      guest_email: 'ana@example.md',
      guest_language: 'ro',
      check_in: FUTURE_CHECK_IN,
      check_out: FUTURE_CHECK_OUT,
      adults: 2,
      kids_ages: [5],
      total_price: 2601,
      payment_type: 'cash',
      payment_status: 'pending',
      room_explicitly_selected: true,
      conference_room: false,
      notes: null,
      cash_expires_at: '2026-05-07T09:30:00.000Z',
      cash_extended: false,
      created_by: 'guest',
    });
  });

  it('prefers the current page language over the stored selection language', () => {
    const checkout = loadCheckout();
    const payloads = checkout.buildReservationPayloads(
      {
        type: 'hotel',
        checkIn: FUTURE_CHECK_IN,
        checkOut: FUTURE_NIGHT_OUT,
        adults: 2,
        kidsAges: [],
        roomIds: ['hotel-16'],
        roomNumbers: [16],
        roomExplicitlySelected: false,
        totalPrice: 2600,
        language: 'ru',
      },
      {
        firstName: 'Elena',
        lastName: 'Rusu',
        phone: '+37369111222',
        email: 'elena@example.md',
      },
      'card',
      {
        now: new Date('2026-05-07T09:00:00.000Z'),
        createId: () => 'reservation-card',
      },
    );

    // Notifications follow the language the guest reads at checkout (here the
    // environment default 'ro'), not the language stored with the booking-page
    // selection; the stored value is only a fallback (ADR-090).
    assert.equal(payloads[0].guest_language, 'ro');
  });

  it('builds card reservations as pending without a cash expiry', () => {
    const checkout = loadCheckout();
    const payloads = checkout.buildReservationPayloads(
      {
        type: 'hotel',
        checkIn: FUTURE_CHECK_IN,
        checkOut: FUTURE_NIGHT_OUT,
        adults: 2,
        kidsAges: [],
        roomIds: ['hotel-16'],
        roomNumbers: [16],
        roomExplicitlySelected: false,
        totalPrice: 2600,
      },
      {
        firstName: 'Ion',
        lastName: 'Rusu',
        phone: '+37369111222',
        email: 'ion@example.md',
      },
      'card',
      {
        now: new Date('2026-05-07T09:00:00.000Z'),
        createId: () => 'reservation-card',
      },
    );

    assert.equal(payloads[0].payment_status, 'pending');
    assert.equal(payloads[0].cash_expires_at, null);
  });

  it('creates pending reservations through the Edge Function instead of direct table inserts', async () => {
    const supabaseHelpers = require('../js/supabase.js');
    const calls = [];
    const client = {
      functions: {
        invoke(name, options) {
          calls.push({ type: 'invoke', name, options });
          return Promise.resolve({
            data: {
              primaryReservationId: 'reservation-a',
              bookingGroupId: 'booking-group-a',
              reservationIds: ['server-reservation-a'],
            },
            error: null,
          });
        },
      },
    };

    const result = await supabaseHelpers.createReservationRequest(client, [{ id: 'reservation-a' }]);

    assert.deepEqual(result, {
      primaryReservationId: 'reservation-a',
      bookingGroupId: 'booking-group-a',
      reservationIds: ['server-reservation-a'],
    });
    assert.deepEqual(calls, [
      {
        type: 'invoke',
        name: 'create-reservation',
        options: {
          body: {
            reservations: [{ id: 'reservation-a' }],
          },
        },
      },
    ]);
  });

  it('passes the normalized phone and selected online rail into maib-create-payment', async () => {
    const checkout = loadCheckout();
    const supabaseHelpers = require('../js/supabase.js');
    const calls = [];
    const location = { href: '' };
    const previousLocation = globalThis.location;
    const previousGetClient = supabaseHelpers.getSupabaseClient;
    const previousCreatePayment = supabaseHelpers.createMaibPaymentRequest;

    supabaseHelpers.getSupabaseClient = () => ({ marker: 'client' });
    supabaseHelpers.createMaibPaymentRequest = (client, context) => {
      calls.push({ client, context });
      return Promise.resolve({ payUrl: 'https://payments.example/maib' });
    };
    globalThis.location = location;

    try {
      await checkout.redirectAfterReservation(
        'reservation-a',
        'card',
        [{ id: 'reservation-a', tracking_event_id: 'evt_checkout_test' }],
        { totalPrice: 3100 },
        {
          bookingGroupId: 'booking-group-a',
          reservationIds: ['server-reservation-a'],
          manageToken: 'manage-token-a',
        },
        '+373 60 123 456',
      );
    } finally {
      globalThis.location = previousLocation;
      supabaseHelpers.getSupabaseClient = previousGetClient;
      supabaseHelpers.createMaibPaymentRequest = previousCreatePayment;
    }

    assert.equal(location.href, 'https://payments.example/maib');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      client: { marker: 'client' },
      context: {
        primaryReservationId: 'reservation-a',
        bookingGroupId: 'booking-group-a',
        reservationIds: ['server-reservation-a'],
        manageToken: 'manage-token-a',
        totalPrice: 3100,
        selection: { totalPrice: 3100 },
        guestPhone: '+37360123456',
        paymentRail: 'mia',
        trackingEventId: 'evt_checkout_test',
      },
    });
  });

  it('includes manage-token proof in direct cash confirmation redirects', async () => {
    const checkout = loadCheckout();
    const previousLocation = globalThis.location;
    const location = { href: '' };
    globalThis.location = location;

    try {
      await checkout.redirectAfterReservation(
        'reservation-cash',
        'cash',
        [{ id: 'reservation-cash' }],
        { totalPrice: 2600 },
        { manageToken: 'cash-manage-token' },
        '+37360123456',
      );
    } finally {
      globalThis.location = previousLocation;
    }

    assert.equal(location.href, 'gestionare.html?id=reservation-cash&manage=cash-manage-token');
  });
});
