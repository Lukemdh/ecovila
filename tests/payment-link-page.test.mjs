import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { findUnversionedAssetRefs } from '../scripts/stamp-asset-versions.mjs';
import { TOPHOST_UPLOAD_ENTRIES } from '../scripts/prepare-tophost-upload.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

describe('EcoVila standalone payment links — page & markup contract (ADR-106)', () => {
  const html = read('plata.html');

  it('ships plata.html and registers it in TopHost deploy entries', () => {
    assert.equal(exists('plata.html'), true, 'plata.html should exist');
    assert.ok(TOPHOST_UPLOAD_ENTRIES.includes('plata.html'), 'TOPHOST_UPLOAD_ENTRIES should include plata.html');
  });

  it('is noindex and includes no third-party analytics', () => {
    assert.match(html, /<meta\s+name=['"]robots['"]\s+content=['"]noindex['"]/i);
    assert.doesNotMatch(html, /tracking\.js/i, 'standalone payment links must never load tracking.js');
    assert.doesNotMatch(html, /tracking-config\.js/i, 'standalone payment links must never load tracking-config.js');
    assert.doesNotMatch(html, /googletagmanager|gtag|facebook|pixel/i);
  });

  it('links its dedicated stylesheet and all necessary styles with version stamps', () => {
    assert.match(html, /css\/main\.css\?v=/);
    assert.match(html, /css\/checkout\.css\?v=/);
    assert.match(html, /css\/confirmation\.css\?v=/);
    assert.match(html, /css\/mia\.css\?v=/);
    assert.match(html, /css\/payment-link\.css\?v=/);
    assert.doesNotMatch(html, /css\/booking\.css/);
    assert.deepEqual(findUnversionedAssetRefs(html), [], 'all local assets must have ?v= stamp');
  });

  it('contains all required status cards and panels', () => {
    assert.match(html, /data-pay-link-loading/, 'loading state panel');
    assert.match(html, /data-pay-link-pay/, 'card pay panel');
    assert.match(html, /data-pay-link-mia/, 'MIA QR panel');
    assert.match(html, /data-pay-link-paid/, 'paid success panel');
    assert.match(html, /data-pay-link-expired/, 'expired panel');
    assert.match(html, /data-pay-link-revoked/, 'revoked panel');
    assert.match(html, /data-pay-link-review/, 'manual review panel');
    assert.match(html, /data-pay-link-not-found/, 'not found panel');
    assert.match(html, /data-pay-link-error-state/, 'generic error panel');
  });

  it('binds data-i18n keys to all dynamic and action buttons including refresh and retry', () => {
    assert.match(html, /data-pay-link-mia-refresh[^>]*data-i18n="payLink\.miaRefresh"/);
    assert.match(html, /data-pay-link-retry[^>]*data-i18n="payLink\.retry"/);
  });

  it('includes legal acceptance links and official payment logos above pay action', () => {
    assert.match(html, /termeni-conditii\.html/, 'must link terms and conditions');
    assert.match(html, /politica-confidentialitate\.html/, 'must link privacy policy');
    assert.match(html, /\/assets\/maib\.png/, 'must show maib brand mark');
    assert.match(html, /\/assets\/mastercard\.png/, 'must show mastercard brand mark');
    assert.match(html, /\/assets\/visa\.png/, 'must show visa brand mark');
    assert.match(html, /\/assets\/mia\.webp/, 'must show MIA brand mark');
  });

  it('displays the official merchant entity name on the MIA view', () => {
    assert.match(html, /S\.C\.\s+PROELECTROCOMPLEX\s+S\.R\.L/, 'merchant name required for MIA compliance');
  });

  it('loads required scripts in correct dependency order', () => {
    const qrcodeIdx = html.indexOf('js/vendor/qrcode.js');
    const supabaseVendorIdx = html.indexOf('js/vendor/supabase.js');
    const supabaseConfigIdx = html.indexOf('js/supabase-config.js');
    const supabaseHelperIdx = html.indexOf('js/supabase.js');
    const translationsIdx = html.indexOf('js/translations.js');
    const pricingIdx = html.indexOf('js/pricing.js');
    const mainIdx = html.indexOf('js/main.js');
    const plataIdx = html.indexOf('js/plata.js');

    assert.ok(qrcodeIdx > 0 && qrcodeIdx < supabaseVendorIdx);
    assert.ok(supabaseVendorIdx < supabaseConfigIdx);
    assert.ok(supabaseConfigIdx < supabaseHelperIdx);
    assert.ok(supabaseHelperIdx < translationsIdx);
    assert.ok(translationsIdx < pricingIdx);
    assert.ok(pricingIdx < mainIdx);
    assert.ok(mainIdx < plataIdx);
  });
});

describe('EcoVila standalone payment links — Supabase client wrappers', () => {
  const supabase = require('../js/supabase.js');

  it('defines and exports paymentLinkStatus and startPaymentLink', () => {
    assert.equal(typeof supabase.paymentLinkStatus, 'function');
    assert.equal(typeof supabase.startPaymentLink, 'function');
  });

  it('paymentLinkStatus invokes payment-link-public with status action', async () => {
    const invocations = [];
    const mockClient = {
      functions: {
        invoke: (fn, options) => {
          invocations.push({ fn, options });
          return Promise.resolve({
            data: {
              ok: true,
              status: 'active',
              amount: 1500,
              currency: 'MDL',
              paymentRail: 'card',
            },
          });
        },
      },
    };

    const res = await supabase.paymentLinkStatus(mockClient, {
      linkId: 'test-link-123',
      attemptId: 'test-attempt-456',
    });

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].fn, 'payment-link-public');
    assert.deepEqual(invocations[0].options.body, {
      action: 'status',
      linkId: 'test-link-123',
      attemptId: 'test-attempt-456',
    });
    assert.equal(res.status, 'active');
    assert.equal(res.amount, 1500);
  });

  it('paymentLinkStatus surfaces server error detail with status', async () => {
    const mockClient = {
      functions: {
        invoke: () =>
          Promise.resolve({
            error: {
              context: {
                json: async () => ({ error: 'Acest link de plată a fost anulat.' }),
                status: 400,
              },
            },
          }),
      },
    };

    await assert.rejects(
      () => supabase.paymentLinkStatus(mockClient, { linkId: 'revoked-link' }),
      (err) => {
        assert.equal(err.message, 'Acest link de plată a fost anulat.');
        assert.equal(err.status, 400);
        return true;
      },
    );
  });

  it('startPaymentLink invokes payment-link-public with start action', async () => {
    const invocations = [];
    const mockClient = {
      functions: {
        invoke: (fn, options) => {
          invocations.push({ fn, options });
          return Promise.resolve({
            data: {
              ok: true,
              attemptId: 'new-attempt-789',
              paymentRail: 'card',
              payUrl: 'https://pay.maib.md/checkout/123',
            },
          });
        },
      },
    };

    const res = await supabase.startPaymentLink(mockClient, {
      linkId: 'test-link-123',
    });

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].fn, 'payment-link-public');
    assert.deepEqual(invocations[0].options.body, {
      action: 'start',
      linkId: 'test-link-123',
    });
    assert.equal(res.attemptId, 'new-attempt-789');
    assert.equal(res.payUrl, 'https://pay.maib.md/checkout/123');
  });

  it('startPaymentLink surfaces server error detail with status', async () => {
    const mockClient = {
      functions: {
        invoke: () =>
          Promise.resolve({
            error: {
              context: {
                json: async () => ({ message: 'Acest link de plată a expirat.' }),
                status: 410,
              },
            },
          }),
      },
    };

    await assert.rejects(
      () => supabase.startPaymentLink(mockClient, { linkId: 'expired-link' }),
      (err) => {
        assert.equal(err.message, 'Acest link de plată a expirat.');
        assert.equal(err.status, 410);
        return true;
      },
    );
  });
});

describe('EcoVila standalone payment links — translations', () => {
  const translations = require('../js/translations.js');

  it('translates payLink keys across RO, RU, and EN', () => {
    const requiredKeys = [
      'payLink.pageTitle',
      'payLink.loadingTitle',
      'payLink.payTitle',
      'payLink.amountLabel',
      'payLink.defaultLabel',
      'payLink.cardButton',
      'payLink.cardContinueButton',
      'payLink.termsAcceptance',
      'payLink.miaTitle',
      'payLink.miaButton',
      'payLink.merchantLabel',
      'payLink.qrAlt',
      'payLink.paidTitle',
      'payLink.paidText',
      'payLink.paidAmountLabel',
      'payLink.expiredTitle',
      'payLink.expiredText',
      'payLink.revokedTitle',
      'payLink.revokedText',
      'payLink.reviewTitle',
      'payLink.reviewText',
      'payLink.notFoundTitle',
      'payLink.notFoundText',
      'payLink.errorTitle',
      'payLink.errorText',
      'payLink.miaRefresh',
      'payLink.retry',
      'payLink.rateLimited',
    ];

    for (const lang of ['ro', 'ru', 'en']) {
      for (const key of requiredKeys) {
        assert.ok(
          translations[lang]?.[key],
          `Translation key "${key}" must exist for language "${lang}"`,
        );
      }
    }
  });
});

describe('EcoVila standalone payment links — client module (js/plata.js)', () => {
  const translations = require('../js/translations.js');
  const pricing = require('../js/pricing.js');
  const supabase = require('../js/supabase.js');
  const plata = require('../js/plata.js');

  function createMockElement(selector, tagName = 'div') {
    const listeners = {};
    const el = {
      tagName: tagName.toUpperCase(),
      hidden: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      href: '',
      src: '',
      alt: '',
      className: '',
      dataset: {},
      attributes: {},
      getAttribute(name) {
        return this.attributes[name] ?? (name === 'href' ? this.href : null);
      },
      setAttribute(name, val) {
        this.attributes[name] = String(val);
        if (name === 'href') this.href = String(val);
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      addEventListener(event, fn) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
      },
      dispatchEvent(event) {
        const fns = listeners[event.type || event] || [];
        fns.forEach((fn) => fn(event));
      },
      click() {
        const fns = listeners['click'] || [];
        fns.forEach((fn) => fn({ type: 'click', target: el }));
      },
      querySelector(sel) {
        if (sel === 'img') {
          return this._img || null;
        }
        return null;
      },
      appendChild(child) {
        this._children = this._children || [];
        this._children.push(child);
      },
    };
    return el;
  }

  function createDOMStub() {
    const elements = new Map();
    const getOrMake = (selector) => {
      if (!elements.has(selector)) {
        let tagName = 'div';
        if (selector.includes('start') || selector.includes('retry') || selector.includes('refresh')) tagName = 'button';
        if (selector.includes('link') || selector.includes('continue')) tagName = 'a';
        if (selector.startsWith('meta')) tagName = 'meta';
        elements.set(selector, createMockElement(selector, tagName));
      }
      return elements.get(selector);
    };

    const selectors = [
      '[data-pay-link-loading]',
      '[data-pay-link-pay]',
      '[data-pay-link-mia]',
      '[data-pay-link-paid]',
      '[data-pay-link-expired]',
      '[data-pay-link-revoked]',
      '[data-pay-link-review]',
      '[data-pay-link-not-found]',
      '[data-pay-link-error-state]',
      '[data-pay-link-amount]',
      '[data-pay-link-mia-amount]',
      '[data-pay-link-paid-amount]',
      '[data-pay-link-review-amount]',
      '[data-pay-link-label]',
      '[data-pay-link-mia-label]',
      '[data-pay-link-qr]',
      '[data-pay-link-qr-link]',
      '[data-pay-link-countdown]',
      '[data-pay-link-countdown-value]',
      '[data-pay-link-mia-countdown]',
      '[data-pay-link-mia-countdown-value]',
      '[data-pay-link-start]',
      '[data-pay-link-continue]',
      '[data-pay-link-error]',
      '[data-pay-link-mia-refresh]',
      '[data-pay-link-mia-expired]',
      '[data-pay-link-retry]',
      'meta[name="description"]',
    ];
    selectors.forEach((sel) => getOrMake(sel));

    const docListeners = {};
    const doc = {
      title: '',
      documentElement: { lang: 'ro' },
      querySelector(sel) {
        return elements.get(sel) || null;
      },
      querySelectorAll(sel) {
        if (sel === '[data-i18n]') {
          return Array.from(elements.values()).filter((e) => e.dataset && e.dataset.i18n);
        }
        const match = elements.get(sel);
        return match ? [match] : [];
      },
      addEventListener(event, fn) {
        if (!docListeners[event]) docListeners[event] = [];
        docListeners[event].push(fn);
      },
      dispatchEvent(event) {
        const fns = docListeners[event.type || event] || [];
        fns.forEach((fn) => fn(event));
      },
    };

    const windowListeners = {};
    const win = {
      document: doc,
      addEventListener(event, fn) {
        if (!windowListeners[event]) windowListeners[event] = [];
        windowListeners[event].push(fn);
      },
      dispatchEvent(event) {
        const fns = windowListeners[event.type || event] || [];
        fns.forEach((fn) => fn(event));
      },
      location: {
        search: '',
        href: '',
        assign(url) {
          this.href = url;
          this.assignedUrl = url;
        },
        assignedUrl: null,
      },
      sessionStorage: {
        _store: new Map(),
        getItem(k) { return this._store.get(k) || null; },
        setItem(k, v) { this._store.set(k, String(v)); },
        removeItem(k) { this._store.delete(k); },
      },
      localStorage: {
        _store: new Map(),
        getItem(k) { return this._store.get(k) || null; },
        setItem(k, v) { this._store.set(k, String(v)); },
        removeItem(k) { this._store.delete(k); },
      },
      qrcode: () => ({
        addData() {},
        make() {},
        createImgTag() { return '<img class="mia-qr__img" alt="QR" />'; },
      }),
    };

    return { doc, win, elements, getOrMake };
  }

  let prevGlobals = null;
  function setupGlobals(dom) {
    prevGlobals = {
      document: globalThis.document,
      location: globalThis.location,
      sessionStorage: globalThis.sessionStorage,
      localStorage: globalThis.localStorage,
      EcoVilaPricing: globalThis.EcoVilaPricing,
      EcoVilaSupabase: globalThis.EcoVilaSupabase,
      EcoVilaTranslations: globalThis.EcoVilaTranslations,
      qrcode: globalThis.qrcode,
      addEventListener: globalThis.addEventListener,
      dispatchEvent: globalThis.dispatchEvent,
    };
    globalThis.document = dom.doc;
    globalThis.location = dom.win.location;
    globalThis.sessionStorage = dom.win.sessionStorage;
    globalThis.localStorage = dom.win.localStorage;
    globalThis.EcoVilaPricing = pricing;
    globalThis.EcoVilaSupabase = supabase;
    globalThis.EcoVilaTranslations = translations;
    globalThis.qrcode = dom.win.qrcode;
    globalThis.addEventListener = dom.win.addEventListener;
    globalThis.dispatchEvent = dom.win.dispatchEvent;
  }

  function cleanupGlobals() {
    if (prevGlobals) {
      globalThis.document = prevGlobals.document;
      globalThis.location = prevGlobals.location;
      globalThis.sessionStorage = prevGlobals.sessionStorage;
      globalThis.localStorage = prevGlobals.localStorage;
      globalThis.EcoVilaPricing = prevGlobals.EcoVilaPricing;
      globalThis.EcoVilaSupabase = prevGlobals.EcoVilaSupabase;
      globalThis.EcoVilaTranslations = prevGlobals.EcoVilaTranslations;
      globalThis.qrcode = prevGlobals.qrcode;
      globalThis.addEventListener = prevGlobals.addEventListener;
      globalThis.dispatchEvent = prevGlobals.dispatchEvent;
      prevGlobals = null;
    }
  }

  it('exports UMD module API', () => {
    assert.equal(typeof plata.init, 'function');
    assert.equal(typeof plata.getContext, 'function');
    assert.equal(typeof plata.fetchStatus, 'function');
    assert.equal(typeof plata.renderQr, 'function');
    assert.equal(typeof plata.renderAmount, 'function');
    assert.equal(typeof plata.startCountdown, 'function');
    assert.equal(typeof plata.stopCountdown, 'function');
    assert.equal(typeof plata.showOnly, 'function');
    assert.equal(typeof plata.handleStatus, 'function');
    assert.equal(typeof plata.formatRemainingTime, 'function');
  });

  it('formats remaining countdown time in MM:SS and HH:MM:SS', () => {
    assert.equal(plata.formatRemainingTime(0), '00:00');
    assert.equal(plata.formatRemainingTime(59), '00:59');
    assert.equal(plata.formatRemainingTime(65), '01:05');
    assert.equal(plata.formatRemainingTime(900), '15:00');
    assert.equal(plata.formatRemainingTime(3600), '01:00:00');
    assert.equal(plata.formatRemainingTime(10800), '03:00:00');
  });

  it('handles terminal states correctly (paid, expired, revoked, review, not_found)', () => {
    const context = { linkId: 'link-1', attemptId: 'att-1' };

    assert.equal(plata.handleStatus(context, { ok: true, status: 'paid', amount: 2000 }), true);
    assert.equal(plata.handleStatus(context, { ok: true, status: 'expired' }), true);
    assert.equal(plata.handleStatus(context, { ok: true, status: 'revoked' }), true);
    assert.equal(plata.handleStatus(context, { ok: true, status: 'review', amount: 2000 }), true);
    assert.equal(plata.handleStatus(context, { ok: false, status: 'not_found' }), true);
  });

  it('recovers identity with B-17 precedence (?p= -> ?orderId= without stale storage -> storage)', () => {
    const dom = createDOMStub();
    setupGlobals(dom);

    try {
      // Case 1: direct ?p= parameter
      dom.win.location.search = '?p=link-alpha';
      dom.win.sessionStorage.getItem = () => null;
      assert.deepEqual(plata.getContext(), { linkId: 'link-alpha', attemptId: '' });

      // Case 2: return from card checkout where ?p= is missing, but sessionStorage has both
      // Fix #3: Must send attemptId ALONE and NOT pair with stale saved linkId!
      dom.win.location.search = '?orderId=attempt-bravo';
      dom.win.sessionStorage.getItem = (k) =>
        k === 'ecovila_payment_link_attempt'
          ? JSON.stringify({ linkId: 'link-from-session', attemptId: 'attempt-saved' })
          : null;
      assert.deepEqual(plata.getContext(), { linkId: '', attemptId: 'attempt-bravo' });

      // Case 3: return trip with only ?orderId= parameter (session lost/cleared)
      dom.win.location.search = '?orderId=attempt-charlie';
      dom.win.sessionStorage.getItem = () => null;
      assert.deepEqual(plata.getContext(), { linkId: '', attemptId: 'attempt-charlie' });

      // Case 4: both ?p= and ?orderId= in URL
      dom.win.location.search = '?p=link-delta&orderId=attempt-delta';
      assert.deepEqual(plata.getContext(), { linkId: 'link-delta', attemptId: 'attempt-delta' });
    } finally {
      cleanupGlobals();
    }
  });

  it('does not leak stale sessionStorage attempt to a different link ID (cross-link regression)', () => {
    const dom = createDOMStub();
    setupGlobals(dom);

    try {
      // Session holds attempt for link X
      dom.win.sessionStorage.getItem = (k) =>
        k === 'ecovila_payment_link_attempt'
          ? JSON.stringify({ linkId: 'link-X', attemptId: 'attempt-A' })
          : null;

      // User opens link Y without orderId -> must NOT inherit attempt-A
      dom.win.location.search = '?p=link-Y';
      assert.deepEqual(plata.getContext(), { linkId: 'link-Y', attemptId: '' });

      // User opens link X again without orderId -> DOES inherit attempt-A
      dom.win.location.search = '?p=link-X';
      assert.deepEqual(plata.getContext(), { linkId: 'link-X', attemptId: 'attempt-A' });

      // User returns with orderId from MAIB -> orderId is authoritative even if different from saved attempt
      dom.win.location.search = '?p=link-X&orderId=attempt-B';
      assert.deepEqual(plata.getContext(), { linkId: 'link-X', attemptId: 'attempt-B' });
    } finally {
      cleanupGlobals();
    }
  });

  it('enforces terminal panel monotonicity (out-of-order expired after paid never overwrites paid panel)', () => {
    const dom = createDOMStub();
    setupGlobals(dom);
    try {
      plata.resetState();
      const context = { linkId: 'link-1', attemptId: 'att-1' };

      // 1. Initial active / pending status
      plata.handleStatus(context, { ok: true, status: 'active', paymentRail: 'card', amount: 1500 });
      assert.equal(dom.getOrMake('[data-pay-link-pay]').hidden, false);
      assert.equal(dom.getOrMake('[data-pay-link-paid]').hidden, true);

      // 2. Paid response arrives (terminal)
      const finishedPaid = plata.handleStatus(context, { ok: true, status: 'paid', amount: 1500 });
      assert.equal(finishedPaid, true);
      assert.equal(dom.getOrMake('[data-pay-link-paid]').hidden, false);
      assert.equal(dom.getOrMake('[data-pay-link-pay]').hidden, true);
      assert.equal(dom.getOrMake('[data-pay-link-expired]').hidden, true);

      // 3. Stale out-of-order poll returns 'expired'
      const droppedExpired = plata.handleStatus(context, { ok: true, status: 'expired' });
      assert.equal(droppedExpired, true);

      // 4. Panel MUST REMAIN paid! Expired panel must NOT be shown!
      assert.equal(dom.getOrMake('[data-pay-link-paid]').hidden, false, 'Paid panel must remain visible');
      assert.equal(dom.getOrMake('[data-pay-link-expired]').hidden, true, 'Expired panel must not overwrite paid');

      // 5. Stale out-of-order poll returns 'revoked' or 'pending'
      plata.handleStatus(context, { ok: true, status: 'revoked' });
      assert.equal(dom.getOrMake('[data-pay-link-paid]').hidden, false);
      assert.equal(dom.getOrMake('[data-pay-link-revoked]').hidden, true);
    } finally {
      cleanupGlobals();
    }
  });

  it('enforces single poll chain without overlapping timeouts and refuses to poll when terminal', () => {
    const dom = createDOMStub();
    let timeoutsScheduled = 0;
    let timeoutsCleared = 0;
    const prevSetTimeout = globalThis.setTimeout;
    const prevClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, ms) => {
      timeoutsScheduled++;
      return 999;
    };
    globalThis.clearTimeout = (id) => {
      timeoutsCleared++;
    };
    setupGlobals(dom);

    try {
      plata.resetState();
      const context = { linkId: 'link-1' };

      // Stop polling clears timeout
      plata.stopPolling();

      // Trigger terminal status
      plata.handleStatus(context, { ok: true, status: 'paid' });
      const currentScheduled = timeoutsScheduled;

      // An attempt to poll after terminal must be ignored early
      plata.poll(context);
      assert.equal(timeoutsScheduled, currentScheduled, 'No new timeout scheduled after terminal');
    } finally {
      globalThis.setTimeout = prevSetTimeout;
      globalThis.clearTimeout = prevClearTimeout;
      cleanupGlobals();
    }
  });

  it('calls location.assign for card checkout and renders visible fallback link', async () => {
    const dom = createDOMStub();
    setupGlobals(dom);
    globalThis.EcoVilaSupabase = {
      getSupabaseClient: () => ({}),
      startPaymentLink: async () => ({
        ok: true,
        attemptId: 'att-card-1',
        paymentRail: 'card',
        payUrl: 'https://pay.maib.md/checkout/card-session-123',
      }),
      paymentLinkStatus: async () => ({ ok: true, status: 'pending', paymentRail: 'card' }),
    };

    try {
      plata.resetState();
      const context = { linkId: 'link-card-1' };
      await plata.startPayment(context, 'card');

      assert.equal(dom.win.location.assignedUrl, 'https://pay.maib.md/checkout/card-session-123');
      const continueLink = dom.getOrMake('[data-pay-link-continue]');
      assert.equal(continueLink.href, 'https://pay.maib.md/checkout/card-session-123');
      assert.equal(continueLink.hidden, false, 'Fallback continue link must be visible');
    } finally {
      cleanupGlobals();
    }
  });

  it('never navigates location when starting MIA payment, renders QR and shows MIA panel', async () => {
    const dom = createDOMStub();
    setupGlobals(dom);
    dom.win.location.assign = () => {
      assert.fail('MIA payment must never call location.assign');
    };
    globalThis.EcoVilaSupabase = {
      getSupabaseClient: () => ({}),
      startPaymentLink: async () => ({
        ok: true,
        attemptId: 'att-mia-1',
        paymentRail: 'mia',
        qrUrl: 'https://mia.maib.md/qr/session-456',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }),
      paymentLinkStatus: async () => ({ ok: true, status: 'pending', paymentRail: 'mia' }),
    };

    try {
      plata.resetState();
      const context = { linkId: 'link-mia-1' };
      await plata.startPayment(context, 'mia');

      assert.equal(dom.win.location.assignedUrl, null, 'Location must not be modified for MIA');
      const qrLink = dom.getOrMake('[data-pay-link-qr-link]');
      assert.equal(qrLink.href, 'https://mia.maib.md/qr/session-456');
      assert.equal(dom.getOrMake('[data-pay-link-mia]').hidden, false, 'MIA panel must be visible');
      assert.equal(dom.getOrMake('[data-pay-link-pay]').hidden, true);
    } finally {
      cleanupGlobals();
    }
  });

  it('opens MIA link in pay panel without auto-minting provider session until Plătește is pressed', async () => {
    const dom = createDOMStub();
    setupGlobals(dom);

    let startMintCalls = 0;
    globalThis.EcoVilaSupabase = {
      getSupabaseClient: () => ({}),
      paymentLinkStatus: async () => ({
        ok: true,
        status: 'active',
        paymentRail: 'mia',
        amount: 3000,
        currency: 'MDL',
        attempt: null,
      }),
      startPaymentLink: async () => {
        startMintCalls += 1;
        return {
          ok: true,
          attemptId: 'att-mia-lazymint',
          paymentRail: 'mia',
          qrUrl: 'https://mia.maib.md/qr/session-lazy',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        };
      },
    };

    try {
      plata.resetState();
      dom.win.location.search = '?p=link-lazy-mia';

      await plata.init();

      // 1. Initial status fetch should NOT mint provider session
      assert.equal(startMintCalls, 0, 'Must NOT mint provider session on open');
      assert.equal(dom.getOrMake('[data-pay-link-pay]').hidden, false, 'Pay panel must be visible');
      assert.equal(dom.getOrMake('[data-pay-link-mia]').hidden, true, 'MIA QR panel must be hidden before press');
      assert.equal(dom.getOrMake('[data-pay-link-amount]').textContent, '3.000 MDL');

      // 2. Click start pay button
      const startBtn = dom.getOrMake('[data-pay-link-start]');
      startBtn.click();
      await new Promise((resolve) => setImmediate(resolve));

      // 3. Provider session minted ONLY on click, QR panel shown, no navigation
      assert.equal(startMintCalls, 1, 'Must mint provider session on button click');
      assert.equal(dom.win.location.assignedUrl, null, 'Must never navigate on MIA');
      assert.equal(dom.getOrMake('[data-pay-link-mia]').hidden, false, 'MIA QR panel must now be visible');
      assert.equal(dom.getOrMake('[data-pay-link-pay]').hidden, true, 'Pay panel must be hidden');
      assert.equal(dom.getOrMake('[data-pay-link-qr-link]').href, 'https://mia.maib.md/qr/session-lazy');
    } finally {
      cleanupGlobals();
    }
  });

  it('handles terminal response from start payment directly without getting stuck', async () => {
    const dom = createDOMStub();
    setupGlobals(dom);
    globalThis.EcoVilaSupabase = {
      getSupabaseClient: () => ({}),
      startPaymentLink: async () => ({
        ok: true,
        status: 'paid',
        amount: 2500,
        currency: 'MDL',
      }),
      paymentLinkStatus: async () => ({ ok: true, status: 'paid' }),
    };

    try {
      plata.resetState();
      const context = { linkId: 'link-terminal-start' };
      await plata.startPayment(context, 'card');

      assert.equal(dom.getOrMake('[data-pay-link-paid]').hidden, false, 'Paid panel must be shown');
      assert.equal(dom.getOrMake('[data-pay-link-pay]').hidden, true);
    } finally {
      cleanupGlobals();
    }
  });

  it('prioritizes attempt expiry over link expiry and allows generating new QR when attempt expires', () => {
    const dom = createDOMStub();
    setupGlobals(dom);
    try {
      plata.resetState();
      const context = { linkId: 'link-expiry-test' };

      const attemptExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const linkExpiry = new Date(Date.now() + 8 * 3600 * 1000).toISOString();

      plata.handleStatus(context, {
        ok: true,
        status: 'pending',
        paymentRail: 'mia',
        expiresAt: linkExpiry,
        attempt: {
          id: 'att-1',
          checkoutUrl: 'https://mia.maib.md/qr/att-1',
          expiresAt: attemptExpiry,
        },
      });

      assert.equal(dom.getOrMake('[data-pay-link-mia]').hidden, false);
      assert.equal(dom.getOrMake('[data-pay-link-qr-link]').href, 'https://mia.maib.md/qr/att-1');

      // Now attempt expires while link is active
      plata.handleStatus(context, {
        ok: true,
        status: 'active',
        paymentRail: 'mia',
        expiresAt: linkExpiry,
        attempt: null,
      });

      // Expired notice / refresh action is visible
      assert.equal(dom.getOrMake('[data-pay-link-mia-expired]').hidden, false);
    } finally {
      cleanupGlobals();
    }
  });

  it('transitions to generic error panel when poll cap is reached on loading, and retry recovers', async () => {
    const dom = createDOMStub();
    setupGlobals(dom);
    globalThis.EcoVilaSupabase = {
      getSupabaseClient: () => ({}),
      paymentLinkStatus: async () => {
        throw new Error('Network failure');
      },
    };

    try {
      plata.resetState();
      const context = { linkId: 'link-fail-test' };
      dom.win.location.search = '?p=link-fail-test';

      await plata.init();
      assert.equal(dom.getOrMake('[data-pay-link-loading]').hidden, false);

      // Force poll attempts to cap
      for (let i = 0; i < 305; i++) {
        await plata.poll(context);
      }

      assert.equal(dom.getOrMake('[data-pay-link-error-state]').hidden, false, 'Error panel must show on poll cap');
      assert.equal(dom.getOrMake('[data-pay-link-loading]').hidden, true);
    } finally {
      cleanupGlobals();
    }
  });

  it('escapes label content and never sets innerHTML on label elements', () => {
    const dom = createDOMStub();
    setupGlobals(dom);
    try {
      plata.resetState();
      const maliciousLabel = '<script>alert("xss")</script><img src="x" onerror="alert(1)"><b>Test Label</b>';
      plata.renderLabel(maliciousLabel);

      const cardLabel = dom.getOrMake('[data-pay-link-label]');
      const miaLabel = dom.getOrMake('[data-pay-link-mia-label]');

      assert.equal(cardLabel.textContent, maliciousLabel);
      assert.equal(miaLabel.textContent, maliciousLabel);
      assert.equal(cardLabel.hidden, false);
      assert.equal(miaLabel.hidden, false);
      assert.equal(cardLabel.innerHTML, '', 'renderLabel must never set innerHTML');
    } finally {
      cleanupGlobals();
    }
  });

  it('updates title and meta description for RU and EN languages independently of status request', () => {
    const dom = createDOMStub();
    setupGlobals(dom);
    try {
      plata.resetState();

      // Test Russian
      dom.doc.documentElement.lang = 'ru';
      plata.applyI18nToPage();
      assert.equal(dom.doc.title, 'EcoVila | Оплата');
      assert.equal(dom.getOrMake('meta[name="description"]').getAttribute('content'), 'Простая и безопасная оплата по платежной ссылке EcoVila.');

      // Test English
      dom.doc.documentElement.lang = 'en';
      plata.applyI18nToPage();
      assert.equal(dom.doc.title, 'EcoVila | Payment');
      assert.equal(dom.getOrMake('meta[name="description"]').getAttribute('content'), 'Simple and secure payment via EcoVila payment link.');
    } finally {
      cleanupGlobals();
    }
  });
});