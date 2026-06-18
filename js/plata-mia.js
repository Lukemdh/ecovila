(function (root, factory) {
  const pricing = root.EcoVilaPricing;
  const supabaseHelpers = root.EcoVilaSupabase;
  const api = factory(root, pricing, supabaseHelpers);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaPlataMia = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root, pricing, supabaseHelpers) {
  'use strict';

  const STORAGE_PENDING = 'ecovila_pending_reservation';
  const STORAGE_LANGUAGE = 'ecovila_language';
  const POLL_MS = 3500;
  // ~6.5 minutes of polling — comfortably past the 5-minute hold so the final
  // (paid or expired) state is always observed.
  const POLL_LIMIT = 112;

  let _pollTimeout = null;
  let _pollAttempts = 0;
  let _countdownTimer = null;
  let _qrRendered = false;
  let _terminal = false;

  // ── helpers ──────────────────────────────────────────────────────────────

  function getLanguage() {
    const doc = root.document;
    return doc?.documentElement?.lang || root.localStorage?.getItem(STORAGE_LANGUAGE) || 'ro';
  }

  function t(key, replacements) {
    const all = root.EcoVilaTranslations || {};
    const lang = getLanguage();
    let value = all[lang]?.[key] || all.ro?.[key] || key;

    if (replacements) {
      Object.entries(replacements).forEach(([k, v]) => {
        value = value.replaceAll(`{${k}}`, String(v));
      });
    }

    return value;
  }

  function el(selector) {
    return root.document?.querySelector(selector) || null;
  }

  function setText(selector, value) {
    const node = el(selector);
    if (node) node.textContent = value;
  }

  function getParam(name) {
    try {
      return new URLSearchParams(root.location?.search).get(name) || '';
    } catch {
      return '';
    }
  }

  function readStorage(key) {
    try {
      return JSON.parse(root.localStorage?.getItem(key) || 'null');
    } catch {
      return null;
    }
  }

  function getContext() {
    const pending = readStorage(STORAGE_PENDING) || {};
    const bookingGroupId = getParam('group') || pending.bookingGroupId || '';
    const reservationId = getParam('id') || pending.primaryReservationId || '';
    const manageToken = getParam('manage') || pending.manageToken || '';
    // When present this page is paying an "add guests" difference, not a booking.
    const changeId = getParam('change') || '';

    return { bookingGroupId, reservationId, manageToken, changeId };
  }

  function fetchStatus(context) {
    const client = supabaseHelpers.getSupabaseClient();
    if (context.changeId) {
      return supabaseHelpers.fetchReservationChangeStatus(client, { changeId: context.changeId });
    }
    return supabaseHelpers.fetchMiaPaymentStatus(client, { bookingGroupId: context.bookingGroupId });
  }

  const PANELS = ['[data-mia-loading]', '[data-mia-error]', '[data-mia-pay]', '[data-mia-expired]'];

  function showOnly(selector) {
    PANELS.forEach((panel) => {
      const node = el(panel);
      if (node) node.hidden = panel !== selector;
    });
  }

  // ── QR + amount + countdown ────────────────────────────────────────────────

  function renderQr(url) {
    if (_qrRendered || !url) {
      return;
    }

    const container = el('[data-mia-qr]');
    const link = el('[data-mia-pay-link]');

    if (link) {
      link.href = url;
    }

    if (container && typeof root.qrcode === 'function') {
      try {
        const qr = root.qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        container.innerHTML = qr.createImgTag(6, 8);
        const img = container.querySelector('img');
        if (img) {
          img.removeAttribute('width');
          img.removeAttribute('height');
          img.alt = t('mia.qrAlt');
          img.className = 'mia-qr__img';
        }
        _qrRendered = true;
      } catch (_error) {
        // The deeplink button still works even if QR rendering fails.
      }
    }
  }

  function renderAmount(amount, currency) {
    if (amount === null || amount === undefined || amount === '') {
      return;
    }

    const value = Number(amount);
    const text = pricing && Number.isFinite(value)
      ? pricing.formatMDL(value)
      : `${amount} ${currency || 'MDL'}`;
    setText('[data-mia-amount]', text);
  }

  function startCountdown(expiresAt) {
    if (_countdownTimer || !expiresAt) {
      return;
    }

    const deadline = new Date(expiresAt).getTime();
    if (!Number.isFinite(deadline)) {
      return;
    }

    const node = el('[data-mia-countdown]');
    if (node) {
      node.hidden = false;
    }

    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      const totalSeconds = Math.floor(remaining / 1000);
      const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
      const seconds = String(totalSeconds % 60).padStart(2, '0');
      setText('[data-mia-countdown-value]', `${minutes}:${seconds}`);

      if (node) {
        node.dataset.low = String(totalSeconds <= 60);
      }

      if (remaining <= 0) {
        stopCountdown();
        // Let the server confirm whether a last-second payment landed.
        triggerImmediatePoll();
      }
    };

    tick();
    _countdownTimer = root.setInterval?.(tick, 1000) ?? null;
  }

  function stopCountdown() {
    if (_countdownTimer !== null) {
      root.clearInterval?.(_countdownTimer);
      _countdownTimer = null;
    }
  }

  // ── polling ────────────────────────────────────────────────────────────────

  function stopPolling() {
    if (_pollTimeout !== null) {
      root.clearTimeout?.(_pollTimeout);
      _pollTimeout = null;
    }
  }

  function schedulePoll(context) {
    if (_terminal || _pollAttempts >= POLL_LIMIT || !root.setTimeout) {
      return;
    }

    _pollTimeout = root.setTimeout(() => poll(context), POLL_MS);
  }

  function triggerImmediatePoll() {
    if (_terminal) {
      return;
    }

    stopPolling();
    const context = getContext();
    if (context.bookingGroupId || context.changeId) {
      poll(context);
    }
  }

  function goToConfirmation(context, payment) {
    const params = new URLSearchParams();
    params.set('id', context.reservationId);
    if (context.manageToken) {
      params.set('manage', context.manageToken);
    }

    // A paid difference returns to the management page, which confirms the new
    // party and shows the success state.
    if (context.changeId) {
      params.set('change', payment === 'success' ? 'success' : 'failed');
      root.location.href = `gestionare.html?${params.toString()}`;
      return;
    }

    params.set('payment', payment);
    root.location.href = `confirmare.html?${params.toString()}`;
  }

  function showExpired() {
    _terminal = true;
    stopPolling();
    stopCountdown();
    showOnly('[data-mia-expired]');
  }

  function handleStatus(context, result) {
    if (result?.qrUrl) {
      renderQr(result.qrUrl);
    }
    renderAmount(result?.amount, result?.currency);

    if (result?.expiresAt) {
      startCountdown(result.expiresAt);
    }

    switch (result?.status) {
      case 'paid':
        _terminal = true;
        stopPolling();
        stopCountdown();
        goToConfirmation(context, 'success');
        return true;
      case 'expired':
      case 'failed':
        showExpired();
        return true;
      case 'not_found':
        // No active MIA session for this booking. If we never rendered a QR the
        // page can't function; otherwise treat it as expired.
        if (!_qrRendered) {
          _terminal = true;
          stopPolling();
          stopCountdown();
          showOnly('[data-mia-error]');
        } else {
          showExpired();
        }
        return true;
      default:
        return false;
    }
  }

  async function poll(context) {
    _pollTimeout = null;
    _pollAttempts += 1;

    try {
      const result = await fetchStatus(context);

      if (_qrRendered === false && result?.qrUrl) {
        showOnly('[data-mia-pay]');
      }

      const finished = handleStatus(context, result);
      if (finished) {
        return;
      }
    } catch (_error) {
      // Transient failure — keep the current view and retry until the window closes.
    }

    schedulePoll(context);
  }

  // ── init ─────────────────────────────────────────────────────────────────

  async function init() {
    const context = getContext();

    if (!context.bookingGroupId && !context.changeId) {
      showOnly('[data-mia-error]');
      return;
    }

    showOnly('[data-mia-loading]');

    try {
      const result = await fetchStatus(context);

      if (result?.qrUrl && result.status !== 'paid') {
        showOnly('[data-mia-pay]');
      }

      const finished = handleStatus(context, result);
      if (!finished) {
        schedulePoll(context);
      }
    } catch (_error) {
      // If the very first call fails we still show the pay panel and let the
      // poller retry; the QR may simply be a moment behind.
      showOnly('[data-mia-pay]');
      schedulePoll(context);
    }

    root.addEventListener?.('ecovila:languagechange', () => {
      applyI18nToPage();
    });
  }

  function applyI18nToPage() {
    const nodes = root.document?.querySelectorAll('[data-i18n]') || [];
    const translations = root.EcoVilaTranslations || {};
    const lang = getLanguage();

    nodes.forEach((node) => {
      const value = translations[lang]?.[node.dataset.i18n] || translations.ro?.[node.dataset.i18n];
      if (value && !Array.isArray(value)) {
        node.textContent = value;
      }
    });
  }

  if (root.document) {
    root.document.addEventListener('DOMContentLoaded', init);
  }

  return { init, getContext };
});
