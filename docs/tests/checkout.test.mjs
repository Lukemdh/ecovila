import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '../..');
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
  return require('../../js/checkout.js');
}

describe('EcoVila Step 5 checkout', () => {
  it('creates the checkout page files and loads the booking dependencies', () => {
    for (const file of ['checkout.html', 'js/checkout.js', 'css/checkout.css']) {
      assert.ok(exists(file), `${file} should exist`);
    }

    const html = read('checkout.html');

    assert.match(html, /data-checkout-app/, 'checkout app hook should exist');
    assert.match(html, /css\/main\.css/, 'checkout page should use the shared public design system');
    assert.match(html, /css\/checkout\.css/, 'checkout page should use checkout styles');
    assert.match(html, /@supabase\/supabase-js@2/, 'checkout page should load Supabase JS v2 from CDN');

    for (const script of [
      'js/translations.js',
      'js/pricing.js',
      'js/supabase.js',
      'js/main.js',
      'js/checkout.js',
    ]) {
      assert.match(html, new RegExp(`src="${script}"`), `${script} should be loaded`);
    }
  });

  it('uses the alternate logo artwork in the checkout footer', () => {
    const html = read('checkout.html');
    const footer = footerMarkup(html);

    assert.match(footer, /src="\/assets\/logoNT\.png"/, 'checkout footer should use the alternate PNG logo');
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
        'checkout.payCard',
        'checkout.payCash',
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
      checkIn: '2026-06-01',
      checkOut: '2026-06-03',
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
    assert.equal(checkout.validateCheckoutSelection({ ...validSelection, checkOut: '2026-06-01' }).valid, false);
    assert.equal(checkout.validateCheckoutSelection({ ...validSelection, adults: 0 }).valid, false);
    assert.equal(checkout.validateCheckoutSelection({ ...validSelection, roomIds: [] }).valid, false);
  });

  it('validates guest details, Moldova phone format, email, and GDPR consent', () => {
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
    assert.equal(checkout.normalizeMoldovaPhone('060123456'), '+37360123456');
    assert.equal(checkout.validateGuestDetails({ firstName: '', lastName: 'Munteanu', phone: '+37360123456', email: 'ana@example.md', gdprAccepted: true }).valid, false);
    assert.equal(checkout.validateGuestDetails({ firstName: 'Ana', lastName: 'Munteanu', phone: '+373123', email: 'ana@example.md', gdprAccepted: true }).errors[0], 'checkout.errorPhone');
    assert.equal(checkout.validateGuestDetails({ firstName: 'Ana', lastName: 'Munteanu', phone: '+37360123456', email: 'ana.example.md', gdprAccepted: true }).errors[0], 'checkout.errorEmail');
    assert.equal(checkout.validateGuestDetails({ firstName: 'Ana', lastName: 'Munteanu', phone: '+37360123456', email: 'ana@example.md', gdprAccepted: false }).errors[0], 'checkout.errorGdpr');
  });

  it('builds pending reservation payloads with client-side IDs and a 30 minute cash expiry', () => {
    const checkout = loadCheckout();
    const ids = ['reservation-a', 'reservation-b'];
    const payloads = checkout.buildReservationPayloads(
      {
        type: 'small',
        checkIn: '2026-06-01',
        checkOut: '2026-06-03',
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
      check_in: '2026-06-01',
      check_out: '2026-06-03',
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

  it('builds card reservations as pending without a cash expiry', () => {
    const checkout = loadCheckout();
    const payloads = checkout.buildReservationPayloads(
      {
        type: 'hotel',
        checkIn: '2026-06-05',
        checkOut: '2026-06-06',
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
    const supabaseHelpers = require('../../js/supabase.js');
    const calls = [];
    const client = {
      functions: {
        invoke(name, options) {
          calls.push({ type: 'invoke', name, options });
          return Promise.resolve({
            data: {
              primaryReservationId: 'reservation-a',
              bookingGroupId: 'booking-group-a',
              reservationIds: ['reservation-a'],
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
      reservationIds: ['reservation-a'],
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
});
