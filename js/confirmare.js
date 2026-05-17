(function (root, factory) {
  const pricing = root.EcoVilaPricing;
  const supabaseHelpers = root.EcoVilaSupabase;
  const api = factory(root, pricing, supabaseHelpers);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaConfirmare = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root, pricing, supabaseHelpers) {
  'use strict';

  const STORAGE_SELECTION = 'ecovila_booking_selection';
  const STORAGE_PENDING = 'ecovila_pending_reservation';
  const STORAGE_LANGUAGE = 'ecovila_language';
  const WARNING_MS = 10 * 60 * 1000;   // 10 minutes
  const CRITICAL_MS = 3 * 60 * 1000;   // 3 minutes

  let _timerInterval = null;
  let _expiresAt = 0;

  // ── Translation helper ──────────────────────────────────────────────────────

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

  // ── DOM helpers ─────────────────────────────────────────────────────────────

  function el(selector) {
    return root.document?.querySelector(selector) || null;
  }

  function setText(selector, value) {
    const node = el(selector);
    if (node) node.textContent = value;
  }

  /**
   * Set text on a button safely: targets the inner <span> so SVG icons are preserved.
   * Falls back to setting textContent on the button itself.
   */
  function setBtnText(btn, value) {
    if (!btn) return;
    const span = btn.querySelector('span');
    if (span) {
      span.textContent = value;
    } else {
      btn.textContent = value;
    }
  }

  function show(selector) {
    const node = el(selector);
    if (node) node.hidden = false;
  }

  function hide(selector) {
    const node = el(selector);
    if (node) node.hidden = true;
  }

  // ── URL param ───────────────────────────────────────────────────────────────

  function getReservationId() {
    try {
      return new URLSearchParams(root.location?.search).get('id') || '';
    } catch {
      return '';
    }
  }

  // ── localStorage ────────────────────────────────────────────────────────────

  function readStorage(key) {
    try {
      return JSON.parse(root.localStorage?.getItem(key) || 'null');
    } catch {
      return null;
    }
  }

  // ── Date formatting ─────────────────────────────────────────────────────────

  function formatDate(dateStr) {
    if (!dateStr || !pricing) return '--';

    const lang = getLanguage();
    const locale = lang === 'ro' ? 'ro-MD' : lang;

    try {
      return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' })
        .format(pricing.parseISODate(dateStr));
    } catch {
      return dateStr;
    }
  }

  function formatGuests(selection) {
    const adults = Number(selection?.adults || 0);
    const kids = Array.isArray(selection?.kidsAges) ? selection.kidsAges : [];
    const adultsCopy = adults === 1 ? t('checkout.oneAdult') : t('checkout.adultsCount', { count: adults });
    const kidsCopy = kids.length === 1 ? t('checkout.oneChild') : t('checkout.childrenCount', { count: kids.length });
    const ages = kids.length ? ` (${kids.join(', ')})` : '';

    return `${adultsCopy} · ${kidsCopy}${ages}`;
  }

  function formatTime(date) {
    try {
      const lang = getLanguage();
      const locale = lang === 'ro' ? 'ro-MD' : lang;
      return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
    } catch {
      return '--:--';
    }
  }

  // ── Summary rendering ───────────────────────────────────────────────────────

  function renderSummary(selection, pending) {
    if (!selection) return;

    const nights = pricing ? pricing.enumerateNights(selection.checkIn, selection.checkOut).length : 0;
    const showRooms = Boolean(
      selection.roomExplicitlySelected &&
      Array.isArray(selection.roomNumbers) &&
      selection.roomNumbers.length,
    );

    const roomsRow = el('[data-summary-rooms-row]');
    if (roomsRow) roomsRow.hidden = !showRooms;

    setText('[data-summary-dates]', `${formatDate(selection.checkIn)} – ${formatDate(selection.checkOut)}`);
    setText('[data-summary-nights]', nights === 1 ? t('booking.night') : t('booking.nights', { count: nights }));
    setText('[data-summary-guests]', formatGuests(selection));
    setText('[data-summary-accommodation]', buildAccommodationLabel(selection));

    if (showRooms) {
      setText('[data-summary-rooms]', selection.roomNumbers.map((n) => `#${n}`).join(', '));
    }

    const totalPrice = selection.totalPrice || pending?.totalPrice || 0;
    setText('[data-summary-total]', pricing ? pricing.formatMDL(totalPrice) : `${totalPrice} MDL`);

    renderBreakdown(selection);
  }

  function buildAccommodationLabel(selection) {
    const title = t(`accommodation.${selection.type}.title`);
    const units = Number(selection.units || selection.roomIds?.length || 1);
    return units > 1 ? `${title} ×${units}` : title;
  }

  function renderBreakdown(selection) {
    const container = el('[data-summary-breakdown]');
    if (!container) return;

    container.innerHTML = '';
    const nights = selection?.pricingBreakdown?.nightlyBreakdown || [];

    if (!nights.length || !pricing) {
      const row = root.document.createElement('li');
      row.textContent = t('checkout.breakdownFallback');
      container.appendChild(row);
      return;
    }

    nights.forEach((night) => {
      const row = root.document.createElement('li');
      const label = root.document.createElement('span');
      const price = root.document.createElement('strong');
      const dayTypeKey = night.dayType === 'holiday' ? 'checkout.dayHoliday' : 'checkout.dayWeekday';

      label.textContent = t('checkout.breakdownNight', {
        date: formatDate(night.date),
        dayType: t(dayTypeKey),
      });
      price.textContent = pricing.formatMDL(night.subtotal);
      row.append(label, price);
      container.appendChild(row);
    });
  }

  // ── State rendering ─────────────────────────────────────────────────────────

  function showLoadingState() {
    show('[data-confirmare-loading]');
    hide('[data-confirmare-error]');
    hide('[data-confirmare-content]');
    setText('[data-confirmare-lead]', t('confirmare.loadingLead'));
  }

  function showErrorState() {
    hide('[data-confirmare-loading]');
    show('[data-confirmare-error]');
    hide('[data-confirmare-content]');
    setText('[data-confirmare-lead]', t('confirmare.errorTitle'));
  }

  function showContentState(paymentType, serverStatus) {
    hide('[data-confirmare-loading]');
    hide('[data-confirmare-error]');
    show('[data-confirmare-content]');

    const isCash = paymentType === 'cash';
    const cashPanel = el('[data-cash-panel]');
    const successPanel = el('[data-success-panel]');

    if (cashPanel) cashPanel.hidden = !isCash;
    if (successPanel) successPanel.hidden = isCash;

    if (isCash) {
      setText('[data-confirmare-lead]', t('confirmare.cashTitle'));

      if (serverStatus?.cash_expires_at) {
        startCountdown(serverStatus.cash_expires_at, serverStatus.cash_extended);
      }

      if (serverStatus?.payment_status === 'cancelled') {
        showExpiredOverlay(true);
        return;
      }
    } else {
      const isPaid = serverStatus?.payment_status === 'paid';
      const titleKey = isPaid ? 'confirmare.successTitle' : 'confirmare.cardPendingTitle';
      const leadKey = isPaid ? 'confirmare.successLead' : 'confirmare.cardPendingText';
      setText('[data-success-title]', t(titleKey));
      setText('[data-confirmare-lead]', t(titleKey));

      const leadEl = el('[data-i18n="confirmare.successLead"]');
      if (leadEl) leadEl.textContent = t(leadKey);
    }
  }

  // ── Countdown timer ─────────────────────────────────────────────────────────

  function startCountdown(expiresAtISO, alreadyExtended) {
    _expiresAt = new Date(expiresAtISO).getTime();

    if (alreadyExtended) {
      const extendBtn = el('[data-extend-btn]');
      if (extendBtn) {
        extendBtn.disabled = true;
        setBtnText(extendBtn, t('confirmare.extended'));
      }
    }

    clearInterval(_timerInterval);
    updateTimerDisplay();
    _timerInterval = setInterval(updateTimerDisplay, 1000);
  }

  function updateTimerDisplay() {
    const remaining = Math.max(0, _expiresAt - Date.now());
    const totalSec = Math.floor(remaining / 1000);
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    const display = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    const digitsEl = el('[data-timer-digits]');
    const blockEl = el('[data-timer-block]');

    if (digitsEl) digitsEl.textContent = display;

    if (blockEl) {
      blockEl.classList.toggle('is-warning', remaining > CRITICAL_MS && remaining <= WARNING_MS);
      blockEl.classList.toggle('is-critical', remaining <= CRITICAL_MS);
    }

    if (remaining === 0) {
      clearInterval(_timerInterval);
      showExpiredOverlay(false);
    }
  }

  // ── Expired overlay ─────────────────────────────────────────────────────────

  function showExpiredOverlay(wasCancelledServer) {
    clearInterval(_timerInterval);

    const overlay = el('[data-expired-overlay]');
    if (!overlay) return;

    overlay.hidden = false;
    overlay.focus?.();

    if (wasCancelledServer) {
      setText('[data-expired-title]', t('confirmare.cancelledTitle'));
      setText('[data-expired-text]', t('confirmare.cancelledText'));
    } else {
      setText('[data-expired-title]', t('confirmare.expiredTitle'));
      setText('[data-expired-text]', t('confirmare.expiredText'));
    }
  }

  // ── Extend handler ──────────────────────────────────────────────────────────

  async function handleExtend(reservationId) {
    const btn = el('[data-extend-btn]');
    if (!btn || btn.disabled) return;

    btn.disabled = true;
    setBtnText(btn, t('confirmare.extending'));
    hide('[data-confirmare-action-error]');

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const newExpiry = await supabaseHelpers.extendCashReservation(client, reservationId);

      if (newExpiry) {
        _expiresAt = new Date(newExpiry).getTime();
        setBtnText(btn, t('confirmare.extended'));
        show('[data-extend-success]');
      } else {
        btn.disabled = false;
        setBtnText(btn, t('confirmare.extend'));
        setText('[data-confirmare-action-error]', t('confirmare.extendError'));
        show('[data-confirmare-action-error]');
      }
    } catch {
      btn.disabled = false;
      setBtnText(btn, t('confirmare.extend'));
      setText('[data-confirmare-action-error]', t('confirmare.extendError'));
      show('[data-confirmare-action-error]');
    }
  }

  // ── Cancel handlers ─────────────────────────────────────────────────────────

  function showCancelConfirm() {
    hide('[data-timer-actions]');
    show('[data-cancel-confirm]');
    hide('[data-confirmare-action-error]');
  }

  function hideCancelConfirm() {
    show('[data-timer-actions]');
    hide('[data-cancel-confirm]');
  }

  async function handleConfirmCancel(reservationId) {
    const yesBtn = el('[data-cancel-yes]');
    if (!yesBtn) return;

    yesBtn.disabled = true;
    setBtnText(yesBtn, t('confirmare.cancelling'));
    hide('[data-confirmare-action-error]');

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const cancelled = await supabaseHelpers.cancelPendingReservation(client, reservationId);

      if (cancelled) {
        showExpiredOverlay(true);
      } else {
        yesBtn.disabled = false;
        setBtnText(yesBtn, t('confirmare.cancelYes'));
        setText('[data-confirmare-action-error]', t('confirmare.cancelError'));
        show('[data-confirmare-action-error]');
      }
    } catch {
      yesBtn.disabled = false;
      setBtnText(yesBtn, t('confirmare.cancelYes'));
      setText('[data-confirmare-action-error]', t('confirmare.cancelError'));
      show('[data-confirmare-action-error]');
    }
  }

  // ── Language change ─────────────────────────────────────────────────────────

  function applyI18nToPage() {
    const allI18n = root.document?.querySelectorAll('[data-i18n]') || [];
    const translations = root.EcoVilaTranslations || {};
    const lang = getLanguage();

    allI18n.forEach((node) => {
      const value = translations[lang]?.[node.dataset.i18n] || translations.ro?.[node.dataset.i18n];
      if (value && !Array.isArray(value)) {
        node.textContent = value;
      }
    });
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async function init() {
    const reservationId = getReservationId();

    if (!reservationId) {
      showErrorState();
      return;
    }

    showLoadingState();

    const selection = readStorage(STORAGE_SELECTION);
    const pending = readStorage(STORAGE_PENDING);

    // Derive payment type: prefer server data, fall back to localStorage
    let paymentType = pending?.paymentType || 'card';
    let serverStatus = null;

    // Render summary from localStorage immediately so it's not blank while fetching
    if (selection) {
      renderSummary(selection, pending);
    }

    // Fetch live status from server
    try {
      const client = supabaseHelpers.getSupabaseClient();
      const rows = await supabaseHelpers.fetchPendingReservationStatus(client, reservationId);
      serverStatus = rows?.[0] || null;

      if (serverStatus) {
        paymentType = serverStatus.payment_type || paymentType;
      }
    } catch {
      // Supabase not configured or unavailable — proceed with localStorage data
    }

    showContentState(paymentType, serverStatus);

    // If no selection data was in localStorage, still attempt to show summary
    // fields using whatever we can from the pending record
    if (!selection && pending) {
      setText('[data-summary-total]', pricing ? pricing.formatMDL(pending.totalPrice) : `${pending.totalPrice} MDL`);
    }

    // Wire up action buttons
    const reservationIdCaptured = reservationId;

    const extendBtn = el('[data-extend-btn]');
    extendBtn?.addEventListener('click', () => handleExtend(reservationIdCaptured));

    const cancelBtn = el('[data-cancel-btn]');
    cancelBtn?.addEventListener('click', showCancelConfirm);

    const cancelYes = el('[data-cancel-yes]');
    cancelYes?.addEventListener('click', () => handleConfirmCancel(reservationIdCaptured));

    const cancelNo = el('[data-cancel-no]');
    cancelNo?.addEventListener('click', hideCancelConfirm);

    // Re-render on language change
    root.addEventListener?.('ecovila:languagechange', () => {
      applyI18nToPage();
      if (selection) renderSummary(selection, pending);
    });
  }

  if (root.document) {
    root.document.addEventListener('DOMContentLoaded', init);
  }

  return { init };
});
