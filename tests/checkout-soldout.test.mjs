import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const pricing = require('../js/pricing.js');
const translations = require('../js/translations.js');
const supabaseHelpers = require('../js/supabase.js');
const checkout = require('../js/checkout.js');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function futureSelection(overrides = {}) {
  return {
    type: 'small',
    checkIn: pricing.addDays(pricing.todayISO(), 20),
    checkOut: pricing.addDays(pricing.todayISO(), 22),
    adults: 2,
    kidsAges: [3, 7],
    units: 1,
    roomIds: ['small-5'],
    roomNumbers: [5],
    roomExplicitlySelected: true,
    totalPrice: 4400,
    ...overrides,
  };
}

function makeElement(initial = {}) {
  const classes = new Set();
  return {
    hidden: true,
    textContent: '',
    href: '',
    disabled: false,
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    ...initial,
  };
}

function makeCheckoutDocument(language = 'en') {
  const message = makeElement();
  const action = makeElement();
  const notice = makeElement({
    querySelector(selector) {
      if (selector === '[data-checkout-soldout-message]') return message;
      if (selector === '[data-checkout-soldout-action]') return action;
      return null;
    },
  });
  const error = makeElement({ textContent: 'stale generic error', hidden: false });
  const status = makeElement();
  const submit = makeElement();
  const elements = new Map([
    ['[data-checkout-soldout]', notice],
    ['[data-checkout-error]', error],
    ['[data-checkout-status]', status],
    ['[data-checkout-submit]', submit],
  ]);

  return {
    document: {
      documentElement: { lang: language },
      querySelector(selector) {
        return elements.get(selector) || null;
      },
      querySelectorAll() {
        return [];
      },
    },
    notice,
    message,
    action,
    error,
    status,
    submit,
  };
}

function replaceGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
}

function loadBookingQueryParser() {
  const sandbox = {
    URLSearchParams,
    document: { querySelector: () => null },
    EcoVilaPricing: pricing,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read('js/booking.js'), sandbox, { filename: 'js/booking.js' });
  return sandbox.EcoVilaBooking.parseBookingQueryParams;
}

describe('honest checkout availability conflicts', () => {
  it('renders a rooms_unavailable response instead of the generic create error and keeps submit disabled', async () => {
    const dom = makeCheckoutDocument('en');
    const restoreDocument = replaceGlobal('document', dom.document);
    const restoreTranslations = replaceGlobal('EcoVilaTranslations', translations);
    const restoreTracking = replaceGlobal('EcoVilaTracking', {
      getOrCreateEventId: () => 'sold-out-event',
      captureBrowserIds: () => ({}),
    });
    const originalGetClient = supabaseHelpers.getSupabaseClient;
    const originalCreate = supabaseHelpers.createReservationRequest;
    supabaseHelpers.getSupabaseClient = () => ({ name: 'test-client' });
    supabaseHelpers.createReservationRequest = async () => {
      const error = new Error('server fallback');
      error.code = 'rooms_unavailable';
      error.detail = {
        code: 'rooms_unavailable',
        roomType: 'small',
        explicitPick: true,
        takenRoomNumbers: [5],
        freeRoomNumbers: [3, 7],
        soldOut: false,
      };
      throw error;
    };

    const fields = {
      '[data-guest-first-name]': { value: 'Ana' },
      '[data-guest-last-name]': { value: 'Munteanu' },
      '[data-guest-phone]': { value: '+37360123456' },
      '[data-guest-email]': { value: 'ana@example.md' },
      '[data-gdpr-consent]': { checked: true },
    };
    const form = { querySelector: (selector) => fields[selector] || null };
    const state = {
      selection: futureSelection(),
      paymentType: 'card',
      availabilityConflict: null,
    };

    try {
      await checkout.submitCheckout(state, form);
    } finally {
      supabaseHelpers.getSupabaseClient = originalGetClient;
      supabaseHelpers.createReservationRequest = originalCreate;
      restoreTracking();
      restoreTranslations();
      restoreDocument();
    }

    assert.equal(dom.notice.hidden, false);
    assert.equal(
      dom.message.textContent,
      'The accommodation you chose has just been booked for these dates. Still free: 3 and 7.',
    );
    assert.notEqual(dom.message.textContent, translations.en['checkout.errorCreate']);
    assert.equal(dom.error.textContent, '');
    assert.equal(dom.error.hidden, true);
    assert.equal(dom.submit.disabled, true);
    assert.equal(dom.submit.classList.contains('is-blocked'), true);
  });

  it('an advisory conflict shows the notice but leaves submit ENABLED', () => {
    const dom = makeCheckoutDocument('en');
    const restoreDocument = replaceGlobal('document', dom.document);
    const restoreTranslations = replaceGlobal('EcoVilaTranslations', translations);

    const state = {
      selection: futureSelection(),
      paymentType: 'card',
      availabilityConflict: {
        code: 'rooms_unavailable',
        roomType: 'small',
        explicitPick: true,
        takenRoomNumbers: [5],
        freeRoomNumbers: [3, 7],
        soldOut: false,
      },
      soldOutConfirmed: false,
    };

    try {
      checkout.renderCheckout(state);

      assert.equal(dom.notice.hidden, false, 'sold out notice should be rendered');
      assert.equal(
        dom.message.textContent,
        'The accommodation you chose has just been booked for these dates. Still free: 3 and 7.',
      );
      assert.equal(dom.submit.disabled, false, 'submit button must remain enabled on advisory conflict');
      assert.equal(dom.submit.classList.contains('is-blocked'), false, 'submit button must not be blocked on advisory conflict');
    } finally {
      restoreTranslations();
      restoreDocument();
    }
  });

  it('a server 409 shows the notice AND disables submit', async () => {
    const dom = makeCheckoutDocument('en');
    const restoreDocument = replaceGlobal('document', dom.document);
    const restoreTranslations = replaceGlobal('EcoVilaTranslations', translations);
    const restoreTracking = replaceGlobal('EcoVilaTracking', {
      getOrCreateEventId: () => 'sold-out-event',
      captureBrowserIds: () => ({}),
    });
    const originalGetClient = supabaseHelpers.getSupabaseClient;
    const originalCreate = supabaseHelpers.createReservationRequest;
    supabaseHelpers.getSupabaseClient = () => ({ name: 'test-client' });
    supabaseHelpers.createReservationRequest = async () => {
      const error = new Error('server fallback');
      error.code = 'rooms_unavailable';
      error.detail = {
        code: 'rooms_unavailable',
        roomType: 'small',
        explicitPick: true,
        takenRoomNumbers: [5],
        freeRoomNumbers: [3, 7],
        soldOut: false,
      };
      throw error;
    };

    const fields = {
      '[data-guest-first-name]': { value: 'Ana' },
      '[data-guest-last-name]': { value: 'Munteanu' },
      '[data-guest-phone]': { value: '+37360123456' },
      '[data-guest-email]': { value: 'ana@example.md' },
      '[data-gdpr-consent]': { checked: true },
    };
    const form = { querySelector: (selector) => fields[selector] || null };
    const state = {
      selection: futureSelection(),
      paymentType: 'card',
      availabilityConflict: null,
      soldOutConfirmed: false,
    };

    try {
      await checkout.submitCheckout(state, form);
    } finally {
      supabaseHelpers.getSupabaseClient = originalGetClient;
      supabaseHelpers.createReservationRequest = originalCreate;
      restoreTracking();
      restoreTranslations();
      restoreDocument();
    }

    assert.equal(dom.notice.hidden, false);
    assert.equal(
      dom.message.textContent,
      'The accommodation you chose has just been booked for these dates. Still free: 3 and 7.',
    );
    assert.equal(dom.submit.disabled, true);
    assert.equal(dom.submit.classList.contains('is-blocked'), true);
    assert.equal(state.soldOutConfirmed, true);
  });

  it('after a server 409, an unrelated later failure does not silently re-enable submit', async () => {
    const dom = makeCheckoutDocument('en');
    const restoreDocument = replaceGlobal('document', dom.document);
    const restoreTranslations = replaceGlobal('EcoVilaTranslations', translations);
    const restoreTracking = replaceGlobal('EcoVilaTracking', {
      getOrCreateEventId: () => 'sold-out-event',
      captureBrowserIds: () => ({}),
    });
    let attempt = 0;
    const originalGetClient = supabaseHelpers.getSupabaseClient;
    const originalCreate = supabaseHelpers.createReservationRequest;
    supabaseHelpers.getSupabaseClient = () => ({ name: 'test-client' });
    supabaseHelpers.createReservationRequest = async () => {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error('server fallback');
        error.code = 'rooms_unavailable';
        error.detail = {
          code: 'rooms_unavailable',
          roomType: 'small',
          explicitPick: true,
          takenRoomNumbers: [5],
          freeRoomNumbers: [3, 7],
          soldOut: false,
        };
        throw error;
      }
      throw new Error('temporary network failure');
    };

    const fields = {
      '[data-guest-first-name]': { value: 'Ana' },
      '[data-guest-last-name]': { value: 'Munteanu' },
      '[data-guest-phone]': { value: '+37360123456' },
      '[data-guest-email]': { value: 'ana@example.md' },
      '[data-gdpr-consent]': { checked: true },
    };
    const form = { querySelector: (selector) => fields[selector] || null };
    const state = {
      selection: futureSelection(),
      paymentType: 'card',
      availabilityConflict: null,
      soldOutConfirmed: false,
    };

    try {
      await checkout.submitCheckout(state, form);
      assert.equal(dom.submit.disabled, true);
      assert.equal(dom.submit.classList.contains('is-blocked'), true);
      assert.equal(state.soldOutConfirmed, true);

      // Second attempt encounters an unrelated error
      await checkout.submitCheckout(state, form);
      assert.equal(dom.submit.disabled, true, 'submit must not be re-enabled after unrelated failure');
      assert.equal(dom.submit.classList.contains('is-blocked'), true, 'submit must stay blocked after unrelated failure');
      assert.equal(state.soldOutConfirmed, true);
    } finally {
      supabaseHelpers.getSupabaseClient = originalGetClient;
      supabaseHelpers.createReservationRequest = originalCreate;
      restoreTracking();
      restoreTranslations();
      restoreDocument();
    }
  });

  it('uses soldOutAll only for a true or effective full sell-out, otherwise interpolating free rooms', () => {
    const dom = makeCheckoutDocument('en');
    const restoreDocument = replaceGlobal('document', dom.document);
    const restoreTranslations = replaceGlobal('EcoVilaTranslations', translations);

    try {
      checkout.renderSoldOutNotice(futureSelection(), { soldOut: true, freeRoomNumbers: [3, 7] });
      assert.equal(dom.message.textContent, translations.en['checkout.soldOutAll']);

      checkout.renderSoldOutNotice(futureSelection(), { soldOut: false, freeRoomNumbers: [] });
      assert.equal(dom.message.textContent, translations.en['checkout.soldOutAll']);

      checkout.renderSoldOutNotice(futureSelection(), { soldOut: false, freeRoomNumbers: [3, 7] });
      assert.equal(
        dom.message.textContent,
        'The accommodation you chose has just been booked for these dates. Still free: 3 and 7.',
      );
    } finally {
      restoreTranslations();
      restoreDocument();
    }
  });

  it('carries the full stay back to booking and omits kids when there are none', () => {
    const withKids = checkout.buildBookingReturnUrl(futureSelection());
    assert.equal(
      withKids,
      `rezervari.html?checkIn=${futureSelection().checkIn}&checkOut=${futureSelection().checkOut}&adults=2&kids=3,7&type=small`,
    );

    const withoutKids = checkout.buildBookingReturnUrl(futureSelection({ kidsAges: [] }));
    assert.equal(
      withoutKids,
      `rezervari.html?checkIn=${futureSelection().checkIn}&checkOut=${futureSelection().checkOut}&adults=2&type=small`,
    );
    assert.equal(new URL(withoutKids, 'https://ecovila.md/').searchParams.has('kids'), false);
  });

  it('computes type availability with half-open stays and selected-room semantics', () => {
    const selection = futureSelection({
      checkIn: '2026-10-10',
      checkOut: '2026-10-12',
      roomIds: ['small-3'],
      roomNumbers: [3],
    });
    const rooms = [
      { id: 'small-1', number: 1, type: 'small', is_active: true },
      { id: 'small-2', number: 2, type: 'small', is_active: true },
      { id: 'small-3', number: 3, type: 'small', is_active: true },
      { id: 'large-9', number: 9, type: 'large', is_active: true },
    ];
    const blocks = [
      { room_id: 'small-1', check_in: '2026-10-08', check_out: '2026-10-10' },
      { room_id: 'small-2', check_in: '2026-10-12', check_out: '2026-10-14' },
      { room_id: 'small-3', check_in: '2026-10-11', check_out: '2026-10-13' },
      { room_id: 'large-9', check_in: '2026-10-10', check_out: '2026-10-12' },
    ];

    assert.deepEqual(checkout.getSelectionAvailabilityConflict(selection, rooms, blocks), {
      code: 'rooms_unavailable',
      roomType: 'small',
      explicitPick: true,
      takenRoomNumbers: [3],
      freeRoomNumbers: [1, 2],
      soldOut: false,
    });
    assert.equal(
      checkout.getSelectionAvailabilityConflict(
        { ...selection, units: 2, roomIds: ['small-1', 'small-2'], roomExplicitlySelected: false },
        rooms,
        blocks,
      ),
      null,
    );
  });

  it('swallows a failed advisory read so checkout remains unblocked', async () => {
    const calls = [];
    const result = await checkout.checkSelectionAvailability(
      futureSelection(),
      { name: 'test-client' },
      {
        fetchRooms() {
          calls.push('rooms');
          return Promise.reject(new Error('temporary read failure'));
        },
        fetchAvailabilityBlocks() {
          calls.push('blocks');
          return Promise.resolve([]);
        },
      },
    );

    assert.deepEqual(calls, ['rooms', 'blocks']);
    assert.equal(result, null, 'a convenience-check failure must not create a blocking conflict');
    assert.match(
      read('js/checkout.js'),
      /renderCheckout\(state\);\s+if \(validateCheckoutSelection\(state\.selection\)\.valid\) \{\s+void checkSelectionAvailability/,
      'the initial checkout paint should happen before the advisory request begins',
    );
  });

  it('defines all sold-out copy in Romanian, Russian, and English', () => {
    for (const language of ['ro', 'ru', 'en']) {
      for (const key of ['checkout.soldOutPicked', 'checkout.soldOutAll', 'checkout.soldOutAction']) {
        assert.equal(typeof translations[language][key], 'string', `${language}.${key} should be defined`);
        assert.ok(translations[language][key].length > 0);
      }
    }
  });
});

describe('booking return-query hydration', () => {
  it('hydrates a complete valid booking query', () => {
    const parse = loadBookingQueryParser();
    const checkIn = pricing.addDays(pricing.todayISO(), 10);
    const checkOut = pricing.addDays(pricing.todayISO(), 13);

    assert.deepEqual(
      JSON.parse(JSON.stringify(parse(`?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&kids=3,7&type=small`))),
      { checkIn, checkOut, adults: 2, kidsAges: [3, 7], type: 'small' },
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(parse(`?checkIn=${checkIn}&checkOut=${checkOut}&adults=1&type=hotel`))),
      { checkIn, checkOut, adults: 1, kidsAges: [], type: 'hotel' },
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(parse(`?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&kids=0,18&type=large`))),
      { checkIn, checkOut, adults: 2, kidsAges: [0, 18], type: 'large' },
      'the return-link contract accepts whole-number child ages from 0 through 18',
    );

    const source = read('js/booking.js');
    assert.match(source, /const querySelection = parseBookingQueryParams\(window\.location\?\.search\)/);
    assert.match(source, /state\.checkIn = querySelection\.checkIn/);
    assert.match(source, /state\.selectedType = querySelection\.type/);
  });

  it('ignores the whole booking query when any recognized value is malformed', () => {
    const parse = loadBookingQueryParser();
    const checkIn = pricing.addDays(pricing.todayISO(), 10);
    const checkOut = pricing.addDays(pricing.todayISO(), 13);
    const past = pricing.addDays(pricing.todayISO(), -1);
    const malformed = [
      `?checkIn=2026-02-30&checkOut=${checkOut}&adults=2&type=small`,
      `?checkIn=${checkIn}&checkOut=${checkIn}&adults=2&type=small`,
      `?checkIn=${past}&checkOut=${checkOut}&adults=2&type=small`,
      `?checkIn=${checkIn}&checkOut=${checkOut}&adults=0&type=small`,
      `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2.5&type=small`,
      `?checkIn=${checkIn}&checkOut=${checkOut}&adults=11&type=small`,
      `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&kids=3,,7&type=small`,
      `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&kids=19&type=small`,
      `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&type=unknown`,
      `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2`,
      `?checkIn=${checkIn}&checkIn=${checkIn}&checkOut=${checkOut}&adults=2&type=small`,
    ];

    for (const query of malformed) {
      assert.equal(parse(query), null, query);
    }
    assert.equal(parse(''), null, 'the no-query default path should remain untouched');
    assert.equal(parse('?utm_source=newsletter'), null, 'unrelated query parameters should remain untouched');
  });
});
