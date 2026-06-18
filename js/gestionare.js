(function (root, factory) {
  const pricing = root.EcoVilaPricing;
  const supabaseHelpers = root.EcoVilaSupabase;
  const api = factory(root, pricing, supabaseHelpers);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaGestionare = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root, pricing, supabaseHelpers) {
  'use strict';

  const STORAGE_SELECTION = 'ecovila_booking_selection';
  const STORAGE_PENDING = 'ecovila_pending_reservation';
  const STORAGE_LANGUAGE = 'ecovila_language';
  const WARNING_MS = 10 * 60 * 1000;   // 10 minutes
  const CRITICAL_MS = 3 * 60 * 1000;   // 3 minutes
  const CARD_STATUS_POLL_MS = 5000;
  const CARD_STATUS_POLL_LIMIT = 180;

  let _timerInterval = null;
  let _cardPollTimeout = null;
  let _cardPollAttempts = 0;
  let _expiresAt = 0;
  let _managedContext = null;
  let _purchaseTracked = false;

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

  function getManageToken() {
    try {
      return new URLSearchParams(root.location?.search).get('manage') || '';
    } catch {
      return '';
    }
  }

  function getOrderId() {
    try {
      return new URLSearchParams(root.location?.search).get('orderId') || '';
    } catch {
      return '';
    }
  }

  /**
   * Maib redirects the browser back to successUrl/failUrl but does not preserve
   * our `id`/`manage` query parameters (it appends its own checkoutId/orderId
   * instead). Recover the reservation id and manage token from the pending
   * reservation persisted by checkout before the payment redirect, matching on
   * maib's `orderId` (our booking group id) when present.
   */
  function recoverFromPendingStorage() {
    const pending = readStorage(STORAGE_PENDING);
    if (!pending?.primaryReservationId || !pending?.manageToken) {
      return null;
    }

    const orderId = getOrderId();
    if (orderId && pending.bookingGroupId && orderId !== pending.bookingGroupId) {
      return null;
    }

    return {
      reservationId: pending.primaryReservationId,
      manageToken: pending.manageToken,
    };
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
      return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
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

  function renderManagedSummary(summary, reservations) {
    if (!summary) return;

    const rows = Array.isArray(reservations) ? reservations : [];
    const nights = pricing ? pricing.enumerateNights(summary.checkIn, summary.checkOut).length : 0;
    const roomLabels = Array.isArray(summary.roomLabels) ? summary.roomLabels : [];

    setText('[data-summary-dates]', `${formatDate(summary.checkIn)} – ${formatDate(summary.checkOut)}`);
    setText('[data-summary-nights]', nights === 1 ? t('booking.night') : t('booking.nights', { count: nights }));
    setText('[data-summary-guests]', formatManagedGuests(rows));
    setText('[data-summary-accommodation]', roomLabels.join(', ') || '--');
    setText('[data-summary-total]', pricing ? pricing.formatMDL(summary.totalPrice || 0) : `${summary.totalPrice || 0} MDL`);

    const roomsRow = el('[data-summary-rooms-row]');
    if (roomsRow) roomsRow.hidden = !roomLabels.length;
    setText('[data-summary-rooms]', roomLabels.join(', ') || '--');

    renderManagedBreakdown(rows, summary);
  }

  function formatManagedGuests(reservations) {
    const rows = Array.isArray(reservations) ? reservations : [];
    const adults = rows.reduce((sum, row) => sum + Number(row.adults || 0), 0);
    const kids = rows.flatMap((row) => Array.isArray(row.kids_ages) ? row.kids_ages : []);
    const adultsCopy = adults === 1 ? t('checkout.oneAdult') : t('checkout.adultsCount', { count: adults });
    const kidsCopy = kids.length === 1 ? t('checkout.oneChild') : t('checkout.childrenCount', { count: kids.length });
    const ages = kids.length ? ` (${kids.join(', ')})` : '';

    return `${adultsCopy} · ${kidsCopy}${ages}`;
  }

  function renderManagedBreakdown(reservations, summary) {
    const container = el('[data-summary-breakdown]');
    if (!container) return;

    container.innerHTML = '';
    const rows = Array.isArray(reservations) ? reservations : [];

    if (!rows.length) {
      const row = root.document.createElement('li');
      const label = root.document.createElement('span');
      const price = root.document.createElement('strong');
      label.textContent = `${formatDate(summary.checkIn)} – ${formatDate(summary.checkOut)}`;
      price.textContent = pricing ? pricing.formatMDL(summary.totalPrice || 0) : `${summary.totalPrice || 0} MDL`;
      row.append(label, price);
      container.appendChild(row);
      return;
    }

    rows.forEach((reservation) => {
      const row = root.document.createElement('li');
      const label = root.document.createElement('span');
      const price = root.document.createElement('strong');
      label.textContent = `${roomLabel(reservation)} · ${formatDate(reservation.check_in)}`;
      price.textContent = pricing ? pricing.formatMDL(reservation.total_price || 0) : `${reservation.total_price || 0} MDL`;
      row.append(label, price);
      container.appendChild(row);
    });
  }

  // ── Included facilities (all-inclusive list) ─────────────────────────────────

  function renderIncluded() {
    const container = el('[data-included-list]');
    if (!container) return;

    const all = root.EcoVilaTranslations || {};
    const lang = getLanguage();
    const items = all[lang]?.['accommodation.shared.facilities'] ||
      all.ro?.['accommodation.shared.facilities'] || [];

    container.innerHTML = '';
    items.forEach((label) => {
      const li = root.document.createElement('li');
      li.className = 'gm-included__item';
      li.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg><span></span>';
      li.querySelector('span').textContent = label;
      container.appendChild(li);
    });
  }

  function roomLabel(reservation) {
    const room = Array.isArray(reservation?.rooms) ? reservation.rooms[0] : reservation?.rooms;
    const type = room?.type || 'hotel';
    const typeLabel = type === 'small'
      ? t('accommodation.small.title')
      : type === 'large'
        ? t('accommodation.large.title')
        : t('accommodation.hotel.title');
    return room?.number ? `${typeLabel} #${room.number}` : typeLabel;
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
    const status = serverStatus?.payment_status;
    const cashPanel = el('[data-cash-panel]');
    const successPanel = el('[data-success-panel]');

    // The cash hold panel (countdown timer + extend/cancel) is only meaningful
    // while a cash reservation is still awaiting payment. Paid/cancelled cash
    // reservations never show the timer.
    const showCashHold = isCash && status === 'pending';
    // The confirmation ("card") box is only shown for card reservations.
    const showSuccess = !isCash;

    if (cashPanel) cashPanel.hidden = !showCashHold;
    if (successPanel) successPanel.hidden = !showSuccess;

    if (isCash) {
      setText('[data-confirmare-lead]', t('confirmare.cashTitle'));

      if (showCashHold && serverStatus?.cash_expires_at) {
        startCountdown(serverStatus.cash_expires_at, serverStatus.cash_extended);
      }

      if (status === 'cancelled') {
        showExpiredOverlay(true);
        return;
      }
    } else {
      if (serverStatus?.payment_status === 'cancelled') {
        showExpiredOverlay(true);
        return;
      }

      const isPaid = serverStatus?.payment_status === 'paid';
      const titleKey = isPaid ? 'confirmare.successTitle' : 'confirmare.cardPendingTitle';
      const leadKey = isPaid ? 'confirmare.successLead' : 'confirmare.cardPendingText';
      setText('[data-success-title]', t(titleKey));
      setText('[data-confirmare-lead]', t(titleKey));

      const leadEl = el('[data-i18n="confirmare.successLead"]');
      if (leadEl) leadEl.textContent = t(leadKey);
    }
  }

  async function loadManagedReservation(reservationId, manageToken) {
    const client = supabaseHelpers.getSupabaseClient();
    return supabaseHelpers.fetchManagedReservationDetails(client, { reservationId, manageToken });
  }

  function renderManagedReservation(details, reservationId, manageToken) {
    const summary = details?.reservation || null;
    if (!summary) {
      throw new Error('Missing reservation details.');
    }

    _managedContext = { details, reservationId, manageToken };

    renderManagedSummary(summary, details.reservations || []);
    renderIncluded();
    setupAddGuests(summary, details.reservations || [], reservationId, manageToken);
    const serverStatus = managedServerStatus(summary, details.reservations || []);
    showContentState(summary.paymentType || 'card', serverStatus);
    trackBrowserPurchaseIfPaid(summary, details.reservations || []);

    if (summary.paymentType === 'cash' && summary.paymentStatus === 'pending') {
      hide('[data-manage-panel]');
      wireCashActions(reservationId, manageToken);
      setText('[data-confirmare-lead]', t('confirmare.cashTitle'));
      return;
    }

    if (summary.paymentType === 'card' && !isTerminalCardStatus(serverStatus)) {
      startCardStatusPolling(reservationId, manageToken, serverStatus);
    }

    renderManagePanel(summary, details.payment || null, reservationId, manageToken);
    updateConfirmationLink(summary.paymentStatus, reservationId, manageToken);
    setText('[data-confirmare-lead]', t('confirmare.manageLead'));
  }

  function updateConfirmationLink(paymentStatus, reservationId, manageToken) {
    const link = el('[data-view-confirmation]');
    if (!link) return;

    const params = new URLSearchParams();
    params.set('id', reservationId);
    params.set('manage', manageToken);
    link.href = `confirmare.html?${params.toString()}`;
    link.hidden = paymentStatus !== 'paid';
  }

  function managedServerStatus(summary, reservations) {
    const primary = Array.isArray(reservations) ? reservations[0] || {} : {};

    return {
      payment_status: summary.paymentStatus,
      payment_type: summary.paymentType,
      cash_expires_at: primary.cash_expires_at || null,
      cash_extended: Boolean(primary.cash_extended),
    };
  }

  function trackBrowserPurchaseIfPaid(summary, reservations) {
    if (_purchaseTracked || summary?.paymentStatus !== 'paid') {
      return;
    }

    const pending = readStorage(STORAGE_PENDING) || {};
    const rows = Array.isArray(reservations) ? reservations : [];
    const eventId = pending.trackingEventId ||
      rows.find((row) => row.tracking_event_id)?.tracking_event_id ||
      summary.bookingGroupId ||
      summary.id;
    const value = Number(summary.totalPrice || pending.totalPrice || 0);

    if (!eventId || !value) {
      return;
    }

    _purchaseTracked = true;
    root.EcoVilaTracking?.trackPurchase?.({
      eventId,
      value,
      currency: 'MDL',
    });
    root.EcoVilaTracking?.clearEventId?.('booking');
  }

  function wireCashActions(reservationId, manageToken) {
    const extendBtn = el('[data-extend-btn]');
    extendBtn?.addEventListener('click', () => handleExtend(reservationId, manageToken));

    const cancelBtn = el('[data-cancel-btn]');
    cancelBtn?.addEventListener('click', showCancelConfirm);

    const cancelYes = el('[data-cancel-yes]');
    cancelYes?.addEventListener('click', () => handleConfirmCancel(reservationId, manageToken));

    const cancelNo = el('[data-cancel-no]');
    cancelNo?.addEventListener('click', hideCancelConfirm);
  }

  function renderManagePanel(summary, payment, reservationId, manageToken) {
    const panel = el('[data-manage-panel]');
    if (!panel) return;

    panel.hidden = false;

    // Cash-paid reservations can only be cancelled at the office, so the MAIB
    // online-refund policy and the online cancel action are irrelevant — show
    // only the office-refund note.
    const isCashReservation = summary.paymentType === 'cash';
    const policyEl = panel.querySelector('.cf-manage__policy');
    if (policyEl) policyEl.hidden = isCashReservation;
    const actionsEl = el('[data-managed-actions]');
    if (actionsEl) actionsEl.hidden = isCashReservation;

    const statusEl = el('[data-managed-status]');
    if (statusEl) {
      statusEl.textContent = managedStatusLabel(summary, payment);
      statusEl.classList.toggle('cf-badge--paid', summary.paymentStatus === 'paid' || payment?.status === 'refunded');
      statusEl.classList.toggle('cf-badge--pending', summary.paymentStatus !== 'paid' && payment?.status !== 'refunded');
    }

    const paidCard = summary.paymentType === 'card' && summary.paymentStatus === 'paid';
    const isCash = summary.paymentType === 'cash';
    const alreadyRefunded = payment?.status === 'refunded' || Boolean(payment?.refunded_at);
    const refundable = paidCard && summary.refundable && !alreadyRefunded;
    const note = isCash
      ? t('confirmare.cashOfficeRefund')
      : alreadyRefunded
      ? t('confirmare.alreadyRefunded')
      : refundable
        ? t('confirmare.refundEligible')
        : paidCard
          ? t('confirmare.refundIneligible')
          : t('confirmare.cancelOnly');

    setText('[data-managed-refund-note]', note);

    const cancelBtn = el('[data-managed-cancel-btn]');
    if (cancelBtn) {
      const canCancelOnline = summary.paymentStatus !== 'cancelled' &&
        !isCash &&
        (summary.refundable || alreadyRefunded);
      cancelBtn.disabled = !canCancelOnline;
      setBtnText(
        cancelBtn,
        refundable ? t('confirmare.cancelAndRefund') : t('confirmare.cancelWithoutRefund'),
      );
      cancelBtn.onclick = showManagedCancelConfirm;
    }

    const cancelYes = el('[data-managed-cancel-yes]');
    if (cancelYes) {
      cancelYes.onclick = () => handleManagedCancel(reservationId, manageToken);
    }

    const cancelNo = el('[data-managed-cancel-no]');
    if (cancelNo) {
      cancelNo.onclick = hideManagedCancelConfirm;
    }
  }

  function managedStatusLabel(summary, payment) {
    if (payment?.status === 'refunded' || payment?.refunded_at) {
      return t('confirmare.statusRefunded');
    }
    if (summary.paymentStatus === 'cancelled') {
      return t('confirmare.statusCancelled');
    }
    if (summary.paymentStatus === 'paid') {
      return t('confirmare.statusPaid');
    }
    if (summary.paymentType === 'cash') {
      return t('confirmare.statusPending');
    }
    return t('confirmare.statusPaymentProcessing');
  }

  function showManagedCancelConfirm() {
    hide('[data-managed-actions]');
    show('[data-managed-cancel-confirm]');
    hide('[data-managed-action-error]');
  }

  function hideManagedCancelConfirm() {
    show('[data-managed-actions]');
    hide('[data-managed-cancel-confirm]');
  }

  async function handleManagedCancel(reservationId, manageToken) {
    const yesBtn = el('[data-managed-cancel-yes]');
    if (!yesBtn) return;

    yesBtn.disabled = true;
    setBtnText(yesBtn, t('confirmare.cancelling'));
    hide('[data-managed-action-error]');

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const result = await supabaseHelpers.cancelManagedReservation(client, { reservationId, manageToken });

      hideManagedCancelConfirm();
      const cancelBtn = el('[data-managed-cancel-btn]');
      if (cancelBtn) {
        cancelBtn.disabled = true;
        setBtnText(cancelBtn, t('confirmare.cancelledTitle'));
      }

      setText('[data-confirmare-lead]', t('confirmare.cancelledTitle'));
      setText('[data-managed-status]', t(result?.refunded ? 'confirmare.statusRefunded' : 'confirmare.statusCancelled'));
      setText(
        '[data-managed-refund-note]',
        result?.refunded ? t('confirmare.cancelledWithRefund') : t('confirmare.cancelledWithoutRefund'),
      );

      if (_managedContext?.details?.reservation) {
        _managedContext.details.reservation.paymentStatus = 'cancelled';
      }
    } catch {
      yesBtn.disabled = false;
      setBtnText(yesBtn, t('confirmare.cancelYes'));
      setText('[data-managed-action-error]', t('confirmare.cancelError'));
      show('[data-managed-action-error]');
    }
  }

  function isTerminalCardStatus(serverStatus) {
    return serverStatus?.payment_status === 'paid' || serverStatus?.payment_status === 'cancelled';
  }

  function clearCardStatusPolling() {
    if (_cardPollTimeout !== null) {
      root.clearTimeout?.(_cardPollTimeout);
      _cardPollTimeout = null;
    }
  }

  function startCardStatusPolling(reservationId, manageToken, serverStatus) {
    clearCardStatusPolling();
    _cardPollAttempts = 0;

    if (isTerminalCardStatus(serverStatus)) {
      return;
    }

    scheduleCardStatusPoll(reservationId, manageToken);
  }

  function scheduleCardStatusPoll(reservationId, manageToken) {
    if (_cardPollAttempts >= CARD_STATUS_POLL_LIMIT || !root.setTimeout) {
      return;
    }

    _cardPollTimeout = root.setTimeout(() => pollCardReservationStatus(reservationId, manageToken), CARD_STATUS_POLL_MS);
  }

  async function pollCardReservationStatus(reservationId, manageToken) {
    _cardPollTimeout = null;
    _cardPollAttempts += 1;

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const rows = await supabaseHelpers.fetchPendingReservationStatus(client, { reservationId, manageToken });
      const serverStatus = rows?.[0] || null;
      const paymentType = serverStatus?.payment_type || 'card';

      if (serverStatus) {
        showContentState(paymentType, serverStatus);
        updateConfirmationLink(serverStatus.payment_status, reservationId, manageToken);
        if (serverStatus.payment_status === 'paid' && !_purchaseTracked) {
          const pending = readStorage(STORAGE_PENDING) || {};
          root.EcoVilaTracking?.trackPurchase?.({
            eventId: pending.trackingEventId || pending.bookingGroupId || reservationId,
            value: Number(pending.totalPrice || 0),
            currency: 'MDL',
          });
          root.EcoVilaTracking?.clearEventId?.('booking');
          _purchaseTracked = true;
        }
      }

      if (paymentType === 'cash' || isTerminalCardStatus(serverStatus)) {
        return;
      }
    } catch {
      // Keep the pending payment state visible and try again until the polling window closes.
    }

    scheduleCardStatusPoll(reservationId, manageToken);
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

  async function handleExtend(reservationId, manageToken) {
    const btn = el('[data-extend-btn]');
    if (!btn || btn.disabled) return;

    btn.disabled = true;
    setBtnText(btn, t('confirmare.extending'));
    hide('[data-confirmare-action-error]');

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const newExpiry = await supabaseHelpers.extendCashReservation(client, { reservationId, manageToken });

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

  async function handleConfirmCancel(reservationId, manageToken) {
    const yesBtn = el('[data-cancel-yes]');
    if (!yesBtn) return;

    yesBtn.disabled = true;
    setBtnText(yesBtn, t('confirmare.cancelling'));
    hide('[data-confirmare-action-error]');

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const cancelled = await supabaseHelpers.cancelPendingReservation(client, { reservationId, manageToken });

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

  // ── Add guests (pay the price difference) ────────────────────────────────────

  const STORAGE_PENDING_CHANGE = 'ecovila_pending_change';
  const DEFAULT_KID_AGE = 5;
  const CHANGE_POLL_MS = 3000;
  const CHANGE_POLL_LIMIT = 40;

  let _ag = null;
  // null while choosing; 'processing' / 'success' / 'failed' after a payment return.
  let _agReturnState = null;
  let _changePollTimer = null;
  let _changePollAttempts = 0;

  function writeStorage(key, value) {
    try {
      root.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      // Storage may be unavailable (private mode); the return poll just won't run.
    }
  }

  function clearStorage(key) {
    try {
      root.localStorage?.removeItem(key);
    } catch {
      // ignore
    }
  }

  function getChangeParam() {
    try {
      return new URLSearchParams(root.location?.search).get('change') || '';
    } catch {
      return '';
    }
  }

  function isAddGuestsEligible(summary) {
    if (!summary || !pricing) return false;
    // Online-paid bookings only (cash/pending settle at the office). Both card
    // and MIA originals are stored as payment_type 'card'.
    if (summary.paymentType !== 'card' || summary.paymentStatus !== 'paid') return false;
    const today = pricing.todayISO ? pricing.todayISO() : new Date().toISOString().slice(0, 10);
    return String(summary.checkOut || '') > today;
  }

  function reservationRoomType(reservation) {
    const room = Array.isArray(reservation?.rooms) ? reservation.rooms[0] : reservation?.rooms;
    return room?.type || '';
  }

  function setupAddGuests(summary, reservations, reservationId, manageToken) {
    const panel = el('[data-addguests-panel]');
    if (!panel) return;

    const rows = Array.isArray(reservations) ? reservations : [];
    const primary = rows[0] || {};
    const roomType = reservationRoomType(primary);

    if (!isAddGuestsEligible(summary) || !roomType || !pricing.ROOM_TYPES?.[roomType]) {
      panel.hidden = true;
      return;
    }

    _ag = {
      reservationId,
      manageToken,
      roomType,
      units: rows.length || 1,
      checkIn: summary.checkIn,
      checkOut: summary.checkOut,
      prevAdults: Number(primary.adults || 0),
      prevKidsAges: (Array.isArray(primary.kids_ages) ? primary.kids_ages : []).map(Number),
      addedAdults: 0,
      addedKidsAges: [],
      pricingTiers: null,
      holidays: null,
      submitting: false,
    };

    panel.hidden = false;
    wireAddGuestsControls();

    if (_agReturnState === 'success') {
      showAddGuestsOutcome('success');
      return;
    }
    if (_agReturnState === 'processing') {
      showAddGuestsOutcome('processing');
      return;
    }

    resetAddGuestsView();
    renderAddGuests();
    loadAddGuestsPricing();

    if (_agReturnState === 'failed') {
      setText('[data-addguests-error]', t('addguests.paymentFailed'));
      show('[data-addguests-error]');
    }
  }

  const AG_INPUT_SELECTORS = [
    '.gm-addguests__lead',
    '.gm-addguests__steppers',
    '.gm-kid-ages',
    '.gm-addguests__summary',
    '.gm-addguests__capacity',
    '.gm-addguests__submit',
  ];

  function resetAddGuestsView() {
    const panel = el('[data-addguests-panel]');
    if (!panel) return;
    AG_INPUT_SELECTORS.forEach((sel) => {
      const node = panel.querySelector(sel);
      if (node) node.hidden = false;
    });
    hide('[data-addguests-done]');
    hide('[data-addguests-error]');
  }

  function showAddGuestsOutcome(state) {
    const panel = el('[data-addguests-panel]');
    if (!panel) return;
    AG_INPUT_SELECTORS.forEach((sel) => {
      const node = panel.querySelector(sel);
      if (node) node.hidden = true;
    });
    hide('[data-addguests-error]');
    show('[data-addguests-done]');
    setText('[data-addguests-done-text]', t(state === 'processing' ? 'addguests.processing' : 'addguests.successApplied'));
  }

  async function loadAddGuestsPricing() {
    if (!_ag || _ag.pricingTiers) return;
    try {
      const client = supabaseHelpers.getSupabaseClient();
      const [tiers, holidays] = await Promise.all([
        supabaseHelpers.fetchPricingTiers(client),
        supabaseHelpers.fetchHolidays(client),
      ]);
      _ag.pricingTiers = tiers || [];
      _ag.holidays = holidays || [];
      renderAddGuests();
    } catch {
      // Without tiers the live preview shows "--"; the server still computes the
      // authoritative difference on submit.
      _ag.pricingTiers = [];
      _ag.holidays = [];
    }
  }

  function agNewAdults() {
    return _ag.prevAdults + _ag.addedAdults;
  }

  function agNewKidsAges() {
    return _ag.prevKidsAges.concat(_ag.addedKidsAges);
  }

  function agFits(adults, kidsAges) {
    try {
      return pricing.getUnitsNeeded(_ag.roomType, { adults, kidsAges }) <= _ag.units;
    } catch {
      return false;
    }
  }

  function agCanAddAdult() {
    return agFits(agNewAdults() + 1, agNewKidsAges());
  }

  function agCanAddKid() {
    return agFits(agNewAdults(), agNewKidsAges().concat([DEFAULT_KID_AGE]));
  }

  function wireAddGuestsControls() {
    const adultsInc = el('[data-adults-inc]');
    if (adultsInc) {
      adultsInc.onclick = () => {
        if (agCanAddAdult()) {
          _ag.addedAdults += 1;
          renderAddGuests();
        }
      };
    }

    const adultsDec = el('[data-adults-dec]');
    if (adultsDec) {
      adultsDec.onclick = () => {
        if (_ag.addedAdults > 0) {
          _ag.addedAdults -= 1;
          renderAddGuests();
        }
      };
    }

    const kidsInc = el('[data-kids-inc]');
    if (kidsInc) {
      kidsInc.onclick = () => {
        if (agCanAddKid()) {
          _ag.addedKidsAges.push(DEFAULT_KID_AGE);
          renderAddGuests();
        }
      };
    }

    const kidsDec = el('[data-kids-dec]');
    if (kidsDec) {
      kidsDec.onclick = () => {
        if (_ag.addedKidsAges.length > 0) {
          _ag.addedKidsAges.pop();
          renderAddGuests();
        }
      };
    }

    const submit = el('[data-addguests-submit]');
    if (submit) submit.onclick = submitAddGuests;
  }

  function renderAddGuests() {
    if (!_ag) return;

    setText('[data-adults-value]', String(_ag.addedAdults));
    setText('[data-kids-value]', String(_ag.addedKidsAges.length));

    const adultsInc = el('[data-adults-inc]');
    if (adultsInc) adultsInc.disabled = !agCanAddAdult();
    const adultsDec = el('[data-adults-dec]');
    if (adultsDec) adultsDec.disabled = _ag.addedAdults <= 0;
    const kidsInc = el('[data-kids-inc]');
    if (kidsInc) kidsInc.disabled = !agCanAddKid();
    const kidsDec = el('[data-kids-dec]');
    if (kidsDec) kidsDec.disabled = _ag.addedKidsAges.length <= 0;

    renderKidAgeSelectors();

    const added = _ag.addedAdults > 0 || _ag.addedKidsAges.length > 0;
    setText('[data-addguests-party]', formatPartyLabel(agNewAdults(), agNewKidsAges().length));

    const diffEl = el('[data-addguests-difference]');
    if (diffEl) {
      const diff = added ? previewDifference() : null;
      diffEl.textContent = diff === null || diff === undefined
        ? '--'
        : pricing.formatMDL(diff);
    }

    const capEl = el('[data-addguests-capacity]');
    if (capEl) {
      const atMax = !agCanAddAdult() && !agCanAddKid();
      capEl.hidden = !atMax;
      if (atMax) capEl.textContent = t('addguests.capacityFull');
    }

    const submit = el('[data-addguests-submit]');
    if (submit) submit.disabled = !added || _ag.submitting;
  }

  function renderKidAgeSelectors() {
    const container = el('[data-kid-ages]');
    const list = el('[data-kid-ages-list]');
    if (!container || !list) return;

    const count = _ag.addedKidsAges.length;
    container.hidden = count === 0;
    list.innerHTML = '';

    for (let index = 0; index < count; index += 1) {
      const wrap = root.document.createElement('label');
      wrap.className = 'gm-kid-age';

      const label = root.document.createElement('span');
      label.className = 'gm-kid-age__label';
      label.textContent = t('addguests.kidLabel', { n: index + 1 });

      const select = root.document.createElement('select');
      select.className = 'gm-kid-age__select';

      for (let age = 1; age <= 17; age += 1) {
        const option = root.document.createElement('option');
        option.value = String(age);
        option.textContent = t('addguests.ageOption', { age });
        if (age === _ag.addedKidsAges[index]) option.selected = true;
        select.appendChild(option);
      }

      select.addEventListener('change', (event) => {
        _ag.addedKidsAges[index] = Number(event.target.value);
        renderAddGuests();
      });

      wrap.append(label, select);
      list.appendChild(wrap);
    }
  }

  function previewDifference() {
    if (!_ag.pricingTiers || !_ag.pricingTiers.length) return null;

    try {
      const base = {
        roomType: _ag.roomType,
        checkIn: _ag.checkIn,
        checkOut: _ag.checkOut,
        units: _ag.units,
        pricingTiers: _ag.pricingTiers,
        holidays: _ag.holidays,
      };
      const oldQuote = pricing.calculateStayPrice(
        Object.assign({}, base, { adults: _ag.prevAdults, kidsAges: _ag.prevKidsAges }),
      );
      const newQuote = pricing.calculateStayPrice(
        Object.assign({}, base, { adults: agNewAdults(), kidsAges: agNewKidsAges() }),
      );
      return Math.max(0, Math.round(newQuote.total) - Math.round(oldQuote.total));
    } catch {
      return null;
    }
  }

  function formatPartyLabel(adults, kids) {
    const adultsCopy = adults === 1 ? t('checkout.oneAdult') : t('checkout.adultsCount', { count: adults });
    const kidsCopy = kids === 1 ? t('checkout.oneChild') : t('checkout.childrenCount', { count: kids });
    return kids ? `${adultsCopy} · ${kidsCopy}` : adultsCopy;
  }

  function buildGestionareReturn(state) {
    const params = new URLSearchParams({ id: _ag.reservationId, change: state });
    if (_ag.manageToken) params.set('manage', _ag.manageToken);
    return `gestionare.html?${params.toString()}`;
  }

  async function submitAddGuests() {
    if (!_ag || _ag.submitting) return;
    if (_ag.addedAdults === 0 && _ag.addedKidsAges.length === 0) return;

    _ag.submitting = true;
    const submit = el('[data-addguests-submit]');
    if (submit) submit.disabled = true;
    setBtnText(submit, t('addguests.submitting'));
    hide('[data-addguests-error]');

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const result = await supabaseHelpers.createReservationChange(client, {
        manageToken: _ag.manageToken,
        reservationId: _ag.reservationId,
        adults: agNewAdults(),
        kidsAges: agNewKidsAges(),
      });

      if (result.changeId) {
        writeStorage(STORAGE_PENDING_CHANGE, {
          changeId: result.changeId,
          reservationId: _ag.reservationId,
          manageToken: _ag.manageToken,
          createdAt: new Date().toISOString(),
        });
      }

      // Free addition (only young children): already applied server-side.
      if (result.applied && Number(result.difference) === 0) {
        root.location.href = buildGestionareReturn('success');
        return;
      }

      if (result.rail === 'mia' || result.qrUrl) {
        const params = new URLSearchParams({ change: result.changeId, id: _ag.reservationId });
        if (_ag.manageToken) params.set('manage', _ag.manageToken);
        root.location.href = `plata-mia.html?${params.toString()}`;
        return;
      }

      if (result.payUrl) {
        root.location.href = result.payUrl;
        return;
      }

      throw new Error('No payment url returned.');
    } catch {
      _ag.submitting = false;
      if (submit) submit.disabled = false;
      setBtnText(submit, t('addguests.submit'));
      setText('[data-addguests-error]', t('addguests.error'));
      show('[data-addguests-error]');
    }
  }

  // ── Payment-return handling ──────────────────────────────────────────────────

  function handleChangeReturn() {
    if (_agReturnState !== 'processing') return;

    const pending = readStorage(STORAGE_PENDING_CHANGE);
    if (!pending?.changeId) {
      // No tracked change id — refresh and assume applied (the details reload
      // reflects the new party either way).
      _agReturnState = 'success';
      refreshManagedDetails();
      return;
    }

    pollChangeStatus(pending.changeId);
  }

  function pollChangeStatus(changeId) {
    clearChangePoll();
    _changePollAttempts = 0;
    runChangePoll(changeId);
  }

  function clearChangePoll() {
    if (_changePollTimer !== null) {
      root.clearTimeout?.(_changePollTimer);
      _changePollTimer = null;
    }
  }

  function scheduleChangePoll(changeId) {
    if (_changePollAttempts >= CHANGE_POLL_LIMIT || !root.setTimeout) return;
    _changePollTimer = root.setTimeout(() => runChangePoll(changeId), CHANGE_POLL_MS);
  }

  async function runChangePoll(changeId) {
    _changePollTimer = null;
    _changePollAttempts += 1;

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const result = await supabaseHelpers.fetchReservationChangeStatus(client, { changeId });

      if (result.status === 'paid') {
        clearStorage(STORAGE_PENDING_CHANGE);
        _agReturnState = 'success';
        await refreshManagedDetails();
        return;
      }

      if (result.status === 'failed' || result.status === 'expired') {
        clearStorage(STORAGE_PENDING_CHANGE);
        _agReturnState = 'failed';
        await refreshManagedDetails();
        return;
      }
    } catch {
      // Transient — keep polling until the window closes.
    }

    scheduleChangePoll(changeId);
  }

  async function refreshManagedDetails() {
    if (!_managedContext) return;
    try {
      const details = await loadManagedReservation(
        _managedContext.reservationId,
        _managedContext.manageToken,
      );
      renderManagedReservation(details, _managedContext.reservationId, _managedContext.manageToken);
    } catch {
      // Keep the current view; the token may have expired after the gateway hop.
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
    let reservationId = getReservationId();
    let manageToken = getManageToken();

    if (!reservationId || !manageToken) {
      const recovered = recoverFromPendingStorage();
      if (recovered) {
        reservationId = recovered.reservationId;
        manageToken = recovered.manageToken;
      }
    }

    if (!reservationId || !manageToken) {
      showErrorState();
      return;
    }

    // Returning from a difference payment: render the add-guests panel in its
    // pending/failed state before resolving the final outcome below.
    const changeParam = getChangeParam();
    if (changeParam === 'success') {
      _agReturnState = 'processing';
    } else if (changeParam === 'failed') {
      _agReturnState = 'failed';
    }

    showLoadingState();

    try {
      const details = await loadManagedReservation(reservationId, manageToken);
      renderManagedReservation(details, reservationId, manageToken);
    } catch {
      showErrorState();
      return;
    }

    handleChangeReturn();

    root.addEventListener?.('ecovila:languagechange', () => {
      applyI18nToPage();
      if (_managedContext) {
        renderManagedReservation(
          _managedContext.details,
          _managedContext.reservationId,
          _managedContext.manageToken,
        );
      }
    });
  }

  if (root.document) {
    root.document.addEventListener('DOMContentLoaded', init);
  }

  return { init, loadManagedReservation, handleManagedCancel };
});
