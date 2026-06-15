(function (root, factory) {
  const api = factory(root);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaTracking = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const EVENT_ID_PREFIX = 'ecovila_event_id_';
  const FBC_COOKIE = '_fbc';
  const FBP_COOKIE = '_fbp';
  const loadedScripts = new Set();
  const trackedMetaPageViews = new Set();
  const trackedGooglePageViews = new Set();
  let pixelReady = false;
  let googleReady = false;

  function config() {
    return root.EcoVilaTrackingConfig || {};
  }

  function consentAllowsTracking() {
    const consent = root.EcoVilaConsent?.get?.();

    return Boolean(consent?.marketing);
  }

  // GA4 is an analytics product, so it follows the "analytics" cookie toggle
  // rather than "marketing" (which gates the Meta Pixel and Google Ads).
  function consentAllowsAnalytics() {
    const consent = root.EcoVilaConsent?.get?.();

    return Boolean(consent?.analytics);
  }

  function safeCurrentUrl() {
    try {
      return `${root.location.origin}${root.location.pathname}`;
    } catch (_error) {
      return 'https://ecovila.md/';
    }
  }

  function randomId() {
    if (root.crypto?.randomUUID) {
      return root.crypto.randomUUID();
    }

    return `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function getOrCreateEventId(scope) {
    const key = `${EVENT_ID_PREFIX}${scope || 'default'}`;

    try {
      const stored = root.localStorage?.getItem(key);
      if (stored) {
        return stored;
      }

      const next = randomId();
      root.localStorage?.setItem(key, next);
      return next;
    } catch (_error) {
      return randomId();
    }
  }

  function clearEventId(scope) {
    try {
      root.localStorage?.removeItem(`${EVENT_ID_PREFIX}${scope || 'default'}`);
    } catch (_error) {
      // Storage can be unavailable in privacy-restricted browsers.
    }
  }

  function readCookie(name) {
    const cookies = String(root.document?.cookie || '').split(';');
    const prefix = `${name}=`;
    const match = cookies
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(prefix));

    return match ? decodeURIComponent(match.slice(prefix.length)) : '';
  }

  function writeCookie(name, value) {
    try {
      root.document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=7776000; SameSite=Lax`;
    } catch (_error) {
      // Cookie writes can be blocked; tracking continues with lower match quality.
    }
  }

  function captureFbcFromUrl() {
    try {
      const fbclid = new URLSearchParams(root.location.search).get('fbclid');
      if (!fbclid) {
        return readCookie(FBC_COOKIE);
      }

      const fbc = `fb.1.${Date.now()}.${fbclid}`;
      writeCookie(FBC_COOKIE, fbc);
      return fbc;
    } catch (_error) {
      return readCookie(FBC_COOKIE);
    }
  }

  function captureBrowserIds() {
    return {
      fbp: readCookie(FBP_COOKIE),
      fbc: captureFbcFromUrl(),
      userAgent: root.navigator?.userAgent || '',
      sourceUrl: safeCurrentUrl(),
    };
  }

  function loadScript(src) {
    if (!src || loadedScripts.has(src)) {
      return Promise.resolve();
    }

    loadedScripts.add(src);

    return new Promise((resolve, reject) => {
      const script = root.document.createElement('script');
      script.async = true;
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      root.document.head.appendChild(script);
    });
  }

  function ensureMetaPixel() {
    const pixelId = String(config().metaPixelId || '').trim();

    if (!pixelId || !consentAllowsTracking() || pixelReady) {
      return Promise.resolve(pixelReady);
    }

    root.fbq = root.fbq || function fbqShim() {
      root.fbq.callMethod
        ? root.fbq.callMethod.apply(root.fbq, arguments)
        : root.fbq.queue.push(arguments);
    };
    root.fbq.push = root.fbq;
    root.fbq.loaded = true;
    root.fbq.version = '2.0';
    root.fbq.queue = root.fbq.queue || [];
    root.fbq('init', pixelId);
    pixelReady = true;

    return loadScript('https://connect.facebook.net/en_US/fbevents.js').then(() => true);
  }

  function ensureGoogleTag() {
    const measurementId = String(config().googleMeasurementId || config().googleAdsConversionId || '').trim();

    if (!measurementId || !consentAllowsAnalytics() || googleReady) {
      return Promise.resolve(googleReady);
    }

    const consent = root.EcoVilaConsent?.get?.() || {};

    root.dataLayer = root.dataLayer || [];
    root.gtag = root.gtag || function gtagShim() {
      root.dataLayer.push(arguments);
    };
    root.gtag('js', new Date());
    root.gtag('consent', 'update', {
      analytics_storage: consent.analytics ? 'granted' : 'denied',
      ad_storage: consent.marketing ? 'granted' : 'denied',
      ad_user_data: consent.marketing ? 'granted' : 'denied',
      ad_personalization: consent.marketing ? 'granted' : 'denied',
    });
    root.gtag('config', measurementId);
    googleReady = true;

    return loadScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`)
      .then(() => true);
  }

  function invokeServerEvent(eventName, data) {
    if (!consentAllowsTracking()) {
      return Promise.resolve({ skipped: true, reason: 'no-consent' });
    }

    const client = root.EcoVilaSupabase?.getSupabaseClient?.();
    const functionName = config().trackingFunctionName || 'track-event';

    if (!client?.functions?.invoke) {
      return Promise.resolve({ skipped: true, reason: 'no-supabase-client' });
    }

    return client.functions.invoke(functionName, {
      body: {
        eventName,
        eventId: data?.eventId || getOrCreateEventId(eventName),
        eventSourceUrl: data?.eventSourceUrl || safeCurrentUrl(),
        fbp: data?.fbp || captureBrowserIds().fbp,
        fbc: data?.fbc || captureBrowserIds().fbc,
        value: data?.value ?? null,
        currency: data?.currency || 'MDL',
        consent: root.EcoVilaConsent?.get?.() || null,
      },
    }).then((result) => result.data || {});
  }

  function trackBrowserMeta(eventName, params, eventId) {
    return ensureMetaPixel().then((ready) => {
      if (ready && root.fbq) {
        root.fbq('track', eventName, params || {}, { eventID: eventId });
      }
    });
  }

  function trackBrowserGoogle(eventName, params) {
    return ensureGoogleTag().then((ready) => {
      if (ready && root.gtag) {
        root.gtag('event', eventName, params || {});
      }
    });
  }

  function trackPageView() {
    if (!consentAllowsAnalytics() && !consentAllowsTracking()) {
      return;
    }

    const url = safeCurrentUrl();
    const eventId = getOrCreateEventId(`PageView:${url}`);

    // GA4 page_view — fires under "analytics" consent.
    if (consentAllowsAnalytics() && !trackedGooglePageViews.has(url)) {
      trackedGooglePageViews.add(url);
      trackBrowserGoogle('page_view', { page_location: url, event_id: eventId });
    }

    // Meta Pixel + server-side CAPI — fire under "marketing" consent.
    if (consentAllowsTracking() && !trackedMetaPageViews.has(url)) {
      trackedMetaPageViews.add(url);
      trackBrowserMeta('PageView', {}, eventId);
      invokeServerEvent('PageView', { eventId, eventSourceUrl: url });
    }
  }

  function trackInitiateCheckout(input) {
    const eventId = input?.eventId || getOrCreateEventId('booking');
    const value = Number(input?.value || 0);
    const currency = input?.currency || 'MDL';

    trackBrowserMeta('InitiateCheckout', { value, currency }, eventId);
    trackBrowserGoogle('begin_checkout', { value, currency, event_id: eventId });
    return invokeServerEvent('InitiateCheckout', { eventId, value, currency });
  }

  function trackPurchase(input) {
    const eventId = input?.eventId || getOrCreateEventId('booking');
    const value = Number(input?.value || 0);
    const currency = input?.currency || 'MDL';
    const purchaseLabel = String(config().googleAdsPurchaseLabel || '').trim();
    const adsId = String(config().googleAdsConversionId || '').trim();
    const sendTo = adsId && purchaseLabel ? `${adsId}/${purchaseLabel}` : undefined;

    trackBrowserMeta('Purchase', { value, currency }, eventId);
    trackBrowserGoogle('purchase', { value, currency, transaction_id: eventId, event_id: eventId });
    if (sendTo && consentAllowsTracking()) {
      trackBrowserGoogle('conversion', { send_to: sendTo, value, currency, transaction_id: eventId });
    }
  }

  function initialize() {
    captureFbcFromUrl();
    // trackPageView() guards each channel on its own consent category, so we
    // can call it on every consent change and on load.
    root.addEventListener?.('ecovila:consentchange', () => {
      trackPageView();
    });
    root.document?.addEventListener('DOMContentLoaded', () => {
      trackPageView();
    });
  }

  initialize();

  return {
    captureBrowserIds,
    clearEventId,
    getOrCreateEventId,
    invokeServerEvent,
    trackInitiateCheckout,
    trackPageView,
    trackPurchase,
  };
});
