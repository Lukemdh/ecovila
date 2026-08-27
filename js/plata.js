(function (root, factory) {
  const pricing = root.EcoVilaPricing;
  const supabaseHelpers = root.EcoVilaSupabase;
  const api = factory(root, pricing, supabaseHelpers);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaPlata = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root, pricing, supabaseHelpers) {
  'use strict';

  const STORAGE_LANGUAGE = 'ecovila_language';
  const STORAGE_ATTEMPT = 'ecovila_payment_link_attempt';
  const POLL_MS = 3500;
  const POLL_LIMIT = 300; // ~17.5 min: comfortably covers the 15-minute MIA lifespan

  const PANEL_LOADING = '[data-pay-link-loading]';
  const PANEL_PAY = '[data-pay-link-pay]';
  const PANEL_MIA = '[data-pay-link-mia]';
  const PANEL_PAID = '[data-pay-link-paid]';
  const PANEL_EXPIRED = '[data-pay-link-expired]';
  const PANEL_REVOKED = '[data-pay-link-revoked]';
  const PANEL_REVIEW = '[data-pay-link-review]';
  const PANEL_NOT_FOUND = '[data-pay-link-not-found]';
  const PANEL_ERROR = '[data-pay-link-error-state]';

  const PANELS = [
    PANEL_LOADING,
    PANEL_PAY,
    PANEL_MIA,
    PANEL_PAID,
    PANEL_EXPIRED,
    PANEL_REVOKED,
    PANEL_REVIEW,
    PANEL_NOT_FOUND,
    PANEL_ERROR,
  ];

  let _pollTimeout = null;
  let _pollAttempts = 0;
  let _countdownTimer = null;
  let _countdownDeadline = 0;
  let _qrRendered = false;
  let _renderedQrUrl = '';
  let _currentAttemptId = '';
  let _terminal = false;
  let _currentContext = { linkId: '', attemptId: '' };
  let _currentRail = '';
  let _activePanel = PANEL_LOADING;

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
    } catch (_error) {
      return '';
    }
  }

  function readSessionStorage(key) {
    try {
      const raw = root.sessionStorage?.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }

  function saveAttempt(linkId, attemptId) {
    try {
      root.sessionStorage?.setItem(
        STORAGE_ATTEMPT,
        JSON.stringify({ linkId: linkId || '', attemptId: attemptId || '' }),
      );
    } catch (_error) {
      // ignore
    }
  }

  function getContext() {
    const linkIdFromQuery = getParam('p');
    const orderIdFromQuery = getParam('orderId');
    const saved = readSessionStorage(STORAGE_ATTEMPT);

    let linkId = '';
    let attemptId = '';

    if (orderIdFromQuery) {
      // Returned from bank checkout with orderId.
      // If ?p= is in query, use it; otherwise DO NOT pair with stale saved linkId!
      linkId = linkIdFromQuery || '';
      attemptId = orderIdFromQuery;
    } else if (linkIdFromQuery) {
      linkId = linkIdFromQuery;
      if (saved?.linkId === linkIdFromQuery && saved?.attemptId) {
        attemptId = saved.attemptId;
      }
    } else if (saved?.linkId || saved?.attemptId) {
      linkId = saved.linkId || '';
      attemptId = saved.attemptId || '';
    }

    return { linkId, attemptId };
  }

  function showOnly(selector) {
    _activePanel = selector;
    PANELS.forEach((panel) => {
      const node = el(panel);
      if (node) node.hidden = panel !== selector;
    });
  }

  function formatRemainingTime(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0) {
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // ── rendering ────────────────────────────────────────────────────────────

  function renderAmount(amount, currency) {
    if (amount === null || amount === undefined || amount === '') {
      return;
    }

    const pr = root.EcoVilaPricing || pricing;
    const value = Number(amount);
    const text = pr && Number.isFinite(value)
      ? pr.formatMDL(value)
      : `${amount} ${currency || 'MDL'}`;

    setText('[data-pay-link-amount]', text);
    setText('[data-pay-link-mia-amount]', text);
    setText('[data-pay-link-paid-amount]', text);
    setText('[data-pay-link-review-amount]', text);
  }

  // A MIA link is an instant bank transfer. Showing the card scheme marks and a
  // "pay by card" button on its pre-payment screen told the payer the wrong thing
  // about what is about to happen, so both follow the rail. The i18n key is
  // swapped as well as the text, otherwise a later language switch would restore
  // the card wording on a MIA link.
  function renderRailIdentity(rail) {
    const isMia = rail === 'mia';

    const cardBrands = el('[data-pay-link-brands-card]');
    const miaBrands = el('[data-pay-link-brands-mia]');
    if (cardBrands) cardBrands.hidden = isMia;
    if (miaBrands) miaBrands.hidden = !isMia;

    const startBtn = el('[data-pay-link-start]');
    if (startBtn) {
      const key = isMia ? 'payLink.miaButton' : 'payLink.cardButton';
      startBtn.dataset.i18n = key;
      startBtn.textContent = t(key);
    }
  }

  function renderLabel(label) {
    const cardLabelNode = el('[data-pay-link-label]');
    const miaLabelNode = el('[data-pay-link-mia-label]');

    if (label && typeof label === 'string' && label.trim().length > 0) {
      const trimmed = label.trim();
      if (cardLabelNode) {
        cardLabelNode.textContent = trimmed;
        cardLabelNode.hidden = false;
      }
      if (miaLabelNode) {
        miaLabelNode.textContent = trimmed;
        miaLabelNode.hidden = false;
      }
    } else {
      if (cardLabelNode) cardLabelNode.hidden = true;
      if (miaLabelNode) miaLabelNode.hidden = true;
    }
  }

  function renderQr(url) {
    if (!url) {
      return;
    }

    if (_qrRendered && _renderedQrUrl === url) {
      return;
    }

    const container = el('[data-pay-link-qr]');
    const link = el('[data-pay-link-qr-link]');

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
          img.alt = t('payLink.qrAlt');
          img.className = 'mia-qr__img';
        }
        _qrRendered = true;
        _renderedQrUrl = url;
      } catch (_error) {
        // Deeplink button still works
        _qrRendered = true;
        _renderedQrUrl = url;
      }
    } else {
      _qrRendered = true;
      _renderedQrUrl = url;
    }
  }

  function startCountdown(expiresAt) {
    if (!expiresAt) {
      return;
    }

    const deadline = new Date(expiresAt).getTime();
    if (!Number.isFinite(deadline)) {
      return;
    }

    if (_countdownTimer !== null && deadline === _countdownDeadline) {
      return;
    }

    stopCountdown();
    _countdownDeadline = deadline;

    const cardNode = el('[data-pay-link-countdown]');
    const miaNode = el('[data-pay-link-mia-countdown]');

    if (cardNode) cardNode.hidden = false;
    if (miaNode) miaNode.hidden = false;

    const tick = () => {
      const remaining = Math.max(0, _countdownDeadline - Date.now());
      const totalSeconds = Math.floor(remaining / 1000);
      const formatted = formatRemainingTime(totalSeconds);

      setText('[data-pay-link-countdown-value]', formatted);
      setText('[data-pay-link-mia-countdown-value]', formatted);

      const isLow = String(totalSeconds <= 60);
      if (cardNode) cardNode.dataset.low = isLow;
      if (miaNode) miaNode.dataset.low = isLow;

      if (remaining <= 0) {
        stopCountdown();
        _qrRendered = false;
        _renderedQrUrl = '';
        const expiredNotice = el('[data-pay-link-mia-expired]');
        if (expiredNotice) {
          expiredNotice.hidden = false;
        }
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

  // ── status & polling ─────────────────────────────────────────────────────

  function stopPolling() {
    if (_pollTimeout !== null) {
      root.clearTimeout?.(_pollTimeout);
      _pollTimeout = null;
    }
  }

  function schedulePoll(context) {
    if (_terminal || !root.setTimeout) {
      return;
    }

    if (_pollAttempts >= POLL_LIMIT) {
      if (_activePanel === PANEL_LOADING) {
        showOnly(PANEL_ERROR);
      }
      return;
    }

    stopPolling();
    _pollTimeout = root.setTimeout(() => poll(context), POLL_MS);
  }

  function triggerImmediatePoll() {
    if (_terminal) {
      return;
    }

    stopPolling();
    if (_currentContext.linkId || _currentContext.attemptId) {
      poll(_currentContext);
    }
  }

  async function fetchStatus(context) {
    const helpers = root.EcoVilaSupabase || supabaseHelpers;
    const client = helpers.getSupabaseClient();
    return helpers.paymentLinkStatus(client, {
      linkId: context.linkId || undefined,
      attemptId: context.attemptId || undefined,
    });
  }

  function handleStatus(context, result) {
    if (_terminal) {
      return true;
    }

    if (!result || result.ok === false) {
      if (result?.status === 'not_found') {
        _terminal = true;
        stopPolling();
        stopCountdown();
        showOnly(PANEL_NOT_FOUND);
        return true;
      }
      return false;
    }

    if (result.paymentRail) {
      _currentRail = result.paymentRail;
      renderRailIdentity(result.paymentRail);
    }

    if (result.amount !== undefined && result.amount !== null) {
      renderAmount(result.amount, result.currency);
    }

    renderLabel(result.label);

    if (result.attempt?.id) {
      if (_currentAttemptId && _currentAttemptId !== result.attempt.id) {
        _qrRendered = false;
        _renderedQrUrl = '';
      }
      _currentAttemptId = result.attempt.id;
      context.attemptId = result.attempt.id;
      _currentContext.attemptId = result.attempt.id;
      saveAttempt(context.linkId, result.attempt.id);
    }

    // Count down the ATTEMPT's expiry for QR (fall back to link's only when there is no attempt)
    const expiresAt = result.attempt?.expiresAt || result.expiresAt;
    if (expiresAt) {
      startCountdown(expiresAt);
    }

    switch (result.status) {
      case 'paid':
        _terminal = true;
        stopPolling();
        stopCountdown();
        showOnly(PANEL_PAID);
        return true;

      case 'review':
        _terminal = true;
        stopPolling();
        stopCountdown();
        showOnly(PANEL_REVIEW);
        return true;

      case 'expired':
        _terminal = true;
        stopPolling();
        stopCountdown();
        showOnly(PANEL_EXPIRED);
        return true;

      case 'revoked':
        _terminal = true;
        stopPolling();
        stopCountdown();
        showOnly(PANEL_REVOKED);
        return true;

      case 'not_found':
        _terminal = true;
        stopPolling();
        stopCountdown();
        showOnly(PANEL_NOT_FOUND);
        return true;

      case 'pending':
      case 'active':
        if (result.paymentRail === 'mia') {
          const qrUrl = result.attempt?.checkoutUrl || result.attempt?.qrUrl;
          if (qrUrl) {
            const expiredNotice = el('[data-pay-link-mia-expired]');
            if (expiredNotice) expiredNotice.hidden = true;
            renderQr(qrUrl);
            showOnly(PANEL_MIA);
          } else {
            if (_activePanel === PANEL_MIA) {
              const expiredNotice = el('[data-pay-link-mia-expired]');
              if (expiredNotice) expiredNotice.hidden = false;
            } else {
              showOnly(PANEL_PAY);
            }
          }
        } else if (result.paymentRail === 'card') {
          const checkoutUrl = result.attempt?.checkoutUrl;
          const continueLink = el('[data-pay-link-continue]');
          if (checkoutUrl && continueLink) {
            continueLink.href = checkoutUrl;
            continueLink.hidden = false;
          }
          if (_activePanel !== PANEL_PAY) {
            showOnly(PANEL_PAY);
          }
        }
        return false;

      default:
        return false;
    }
  }

  async function poll(context) {
    if (_terminal) {
      return;
    }

    stopPolling();
    _pollAttempts += 1;

    try {
      const result = await fetchStatus(context);
      if (_terminal) {
        return;
      }
      const finished = handleStatus(context, result);
      if (finished || _terminal) {
        return;
      }
    } catch (_error) {
      if (_terminal) {
        return;
      }
      // Transient error, poller continues
    }

    schedulePoll(context);
  }

  // ── start payment ────────────────────────────────────────────────────────

  async function startPayment(context, rail) {
    if (_terminal || !context.linkId) {
      return;
    }

    const effectiveRail = rail || _currentRail || 'card';
    const startBtn = el('[data-pay-link-start]');
    const errorNode = el('[data-pay-link-error]');
    const refreshBtn = el('[data-pay-link-mia-refresh]');

    if (errorNode) {
      errorNode.hidden = true;
      errorNode.textContent = '';
    }

    if (startBtn) {
      startBtn.disabled = true;
      if (effectiveRail === 'card') {
        startBtn.textContent = t('payLink.cardRedirecting');
      }
    }

    if (effectiveRail === 'mia' && refreshBtn) {
      refreshBtn.disabled = true;
    }

    try {
      const helpers = root.EcoVilaSupabase || supabaseHelpers;
      const client = helpers.getSupabaseClient();
      const result = await helpers.startPaymentLink(client, {
        linkId: context.linkId,
      });

      if (_terminal) {
        return;
      }

      if (result && result.status && ['paid', 'review', 'revoked', 'expired', 'not_found'].includes(result.status)) {
        handleStatus(context, result);
        return;
      }

      _pollAttempts = 0; // Fresh attempt, reset poll budget

      if (result?.attemptId) {
        if (_currentAttemptId && _currentAttemptId !== result.attemptId) {
          _qrRendered = false;
          _renderedQrUrl = '';
        }
        _currentAttemptId = result.attemptId;
        context.attemptId = result.attemptId;
        _currentContext.attemptId = result.attemptId;
        saveAttempt(context.linkId, result.attemptId);
      }

      if (result?.expiresAt) {
        startCountdown(result.expiresAt);
      }

      if (effectiveRail === 'card') {
        const payUrl = result?.payUrl || result?.attempt?.checkoutUrl;
        const continueLink = el('[data-pay-link-continue]');
        if (continueLink && payUrl) {
          continueLink.href = payUrl;
          continueLink.hidden = false;
        }

        if (payUrl) {
          if (root.location?.assign) {
            root.location.assign(payUrl);
          } else if (root.location) {
            root.location.href = payUrl;
          }
        }

        schedulePoll(context);
      } else if (effectiveRail === 'mia') {
        const qrUrl = result?.qrUrl || result?.attempt?.checkoutUrl;
        if (qrUrl) {
          const expiredNotice = el('[data-pay-link-mia-expired]');
          if (expiredNotice) expiredNotice.hidden = true;
          renderQr(qrUrl);
          showOnly(PANEL_MIA);
        }
        schedulePoll(context);
      }
    } catch (error) {
      if (startBtn) {
        startBtn.disabled = false;
        // Restore the label for whichever rail this link is, not just card:
        // a failed MIA start used to leave the button on its previous wording.
        renderRailIdentity(effectiveRail);
      }

      const helpers = root.EcoVilaSupabase || supabaseHelpers;
      const isRateLimited = helpers?.isRateLimited?.(error) || error?.rateLimited;
      let message = isRateLimited
        ? t('payLink.rateLimited')
        : (error?.message || t('payLink.errorText'));

      if (errorNode) {
        errorNode.textContent = message;
        errorNode.hidden = false;
      }
    } finally {
      if (effectiveRail === 'mia' && refreshBtn) {
        refreshBtn.disabled = false;
      }
    }
  }

  // ── i18n & DOM ───────────────────────────────────────────────────────────

  function applyI18nToPage() {
    const nodes = root.document?.querySelectorAll('[data-i18n]') || [];
    const translations = root.EcoVilaTranslations || {};
    const lang = getLanguage();

    nodes.forEach((node) => {
      const key = node.dataset.i18n;
      const value = translations[lang]?.[key] || translations.ro?.[key];
      if (value && !Array.isArray(value)) {
        node.textContent = value;
      }
    });

    if (root.document) {
      root.document.title = t('payLink.pageTitle');
      const metaDesc = root.document.querySelector('meta[name="description"]');
      if (metaDesc) {
        metaDesc.setAttribute('content', t('payLink.metaDescription'));
      }
    }
  }

  // Register languagechange listener immediately
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('ecovila:languagechange', () => {
      applyI18nToPage();
    });
  }

  // ── init ─────────────────────────────────────────────────────────────────

  async function init() {
    applyI18nToPage();

    _terminal = false;
    _pollAttempts = 0;

    const context = getContext();
    _currentContext = context;

    if (!context.linkId && !context.attemptId) {
      _terminal = true;
      stopPolling();
      stopCountdown();
      showOnly(PANEL_NOT_FOUND);
      return;
    }

    showOnly(PANEL_LOADING);

    const startBtn = el('[data-pay-link-start]');
    if (startBtn && !startBtn._hasClickListener) {
      startBtn._hasClickListener = true;
      startBtn.addEventListener('click', () => {
        startPayment(_currentContext, _currentRail || 'card');
      });
    }

    const miaRefreshBtn = el('[data-pay-link-mia-refresh]');
    if (miaRefreshBtn && !miaRefreshBtn._hasClickListener) {
      miaRefreshBtn._hasClickListener = true;
      miaRefreshBtn.addEventListener('click', () => {
        startPayment(_currentContext, 'mia');
      });
    }

    const retryBtn = el('[data-pay-link-retry]');
    if (retryBtn && !retryBtn._hasClickListener) {
      retryBtn._hasClickListener = true;
      retryBtn.addEventListener('click', () => {
        init();
      });
    }

    try {
      const result = await fetchStatus(context);
      if (_terminal) {
        return;
      }
      const finished = handleStatus(context, result);
      if (!finished && !_terminal) {
        schedulePoll(context);
      }
    } catch (error) {
      if (_terminal) {
        return;
      }
      const helpers = root.EcoVilaSupabase || supabaseHelpers;
      const isRateLimited = helpers?.isRateLimited?.(error) || error?.rateLimited;
      if (isRateLimited) {
        const errorText = el('[data-pay-link-error]');
        if (errorText) {
          errorText.textContent = t('payLink.rateLimited');
          errorText.hidden = false;
        }
      }
      schedulePoll(context);
    }
  }

  function resetState() {
    stopPolling();
    stopCountdown();
    _pollTimeout = null;
    _pollAttempts = 0;
    _countdownTimer = null;
    _countdownDeadline = 0;
    _qrRendered = false;
    _renderedQrUrl = '';
    _currentAttemptId = '';
    _terminal = false;
    _currentContext = { linkId: '', attemptId: '' };
    _currentRail = '';
    _activePanel = PANEL_LOADING;
  }

  if (root.document) {
    root.document.addEventListener('DOMContentLoaded', init);
  }

  return {
    init,
    getContext,
    fetchStatus,
    renderQr,
    renderAmount,
    renderLabel,
    startCountdown,
    stopCountdown,
    showOnly,
    poll,
    stopPolling,
    handleStatus,
    startPayment,
    formatRemainingTime,
    saveAttempt,
    applyI18nToPage,
    resetState,
  };
});
