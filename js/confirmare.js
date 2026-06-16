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

  const STORAGE_PENDING = 'ecovila_pending_reservation';
  const STORAGE_LANGUAGE = 'ecovila_language';
  const CARD_STATUS_POLL_MS = 5000;
  const CARD_STATUS_POLL_LIMIT = 180;
  const CHECK_IN_HOUR = '13:00';
  const CHECK_OUT_HOUR = '10:00';
  const MAPS_URL = 'https://maps.google.com/?q=EcoVila+Orheiul+Vechi';

  let _cardPollTimeout = null;
  let _cardPollAttempts = 0;
  let _purchaseTracked = false;
  let _context = null;

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

  function show(selector) {
    const node = el(selector);
    if (node) node.hidden = false;
  }

  function hide(selector) {
    const node = el(selector);
    if (node) node.hidden = true;
  }

  // ── URL params ──────────────────────────────────────────────────────────────

  function getParam(name) {
    try {
      return new URLSearchParams(root.location?.search).get(name) || '';
    } catch {
      return '';
    }
  }

  function getReservationId() {
    return getParam('id');
  }

  function getManageToken() {
    return getParam('manage');
  }

  function getPaymentHint() {
    return getParam('payment');
  }

  /**
   * Maib redirects the browser back to successUrl/failUrl but may not preserve
   * our `id`/`manage` query parameters. Recover the reservation id and manage
   * token from the pending reservation persisted by checkout before the payment
   * redirect, matching on maib's `orderId` (our booking group id) when present.
   */
  function recoverFromPendingStorage() {
    const pending = readStorage(STORAGE_PENDING);
    if (!pending?.primaryReservationId || !pending?.manageToken) {
      return null;
    }

    const orderId = getParam('orderId');
    if (orderId && pending.bookingGroupId && orderId !== pending.bookingGroupId) {
      return null;
    }

    return {
      reservationId: pending.primaryReservationId,
      manageToken: pending.manageToken,
    };
  }

  function readStorage(key) {
    try {
      return JSON.parse(root.localStorage?.getItem(key) || 'null');
    } catch {
      return null;
    }
  }

  // ── Formatting ──────────────────────────────────────────────────────────────

  function formatDate(dateStr, options) {
    if (!dateStr || !pricing) return '--';

    const lang = getLanguage();
    const locale = lang === 'ro' ? 'ro-MD' : lang;

    try {
      return new Intl.DateTimeFormat(
        locale,
        options || { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' },
      ).format(pricing.parseISODate(dateStr));
    } catch {
      return dateStr;
    }
  }

  function formatGuests(reservations) {
    const rows = Array.isArray(reservations) ? reservations : [];
    const adults = rows.reduce((sum, row) => sum + Number(row.adults || 0), 0);
    const kids = rows.flatMap((row) => Array.isArray(row.kids_ages) ? row.kids_ages : []);
    const adultsCopy = adults === 1 ? t('checkout.oneAdult') : t('checkout.adultsCount', { count: adults });

    if (!kids.length) {
      return adultsCopy;
    }

    const kidsCopy = kids.length === 1 ? t('checkout.oneChild') : t('checkout.childrenCount', { count: kids.length });
    return `${adultsCopy} · ${kidsCopy}`;
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

  // ── Countdown ───────────────────────────────────────────────────────────────

  function daysUntilCheckIn(checkIn) {
    if (!checkIn || !pricing) return null;

    try {
      const target = pricing.parseISODate(checkIn).getTime();
      const now = new Date();
      const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      return Math.round((target - today) / (24 * 60 * 60 * 1000));
    } catch {
      return null;
    }
  }

  function countdownCopy(days) {
    if (days === null || days < 0) return '';
    if (days === 0) return t('confirmare.countdownToday');
    if (days === 1) return t('confirmare.countdownTomorrow');
    return t('confirmare.countdownDays', { count: days });
  }

  // ── Calendar (ICS) ──────────────────────────────────────────────────────────

  function buildIcsContent(summary) {
    const start = String(summary.checkIn || '').replaceAll('-', '');
    const end = String(summary.checkOut || '').replaceAll('-', '');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//EcoVila//Reservation//RO',
      'BEGIN:VEVENT',
      `UID:${summary.bookingGroupId || summary.primaryReservationId || stamp}@ecovila.md`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${t('confirmare.icsSummary')}`,
      'LOCATION:EcoVila, Orheiul Vechi, Moldova',
      `DESCRIPTION:${t('confirmare.icsDescription')}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
  }

  function downloadIcs(summary) {
    try {
      const blob = new Blob([buildIcsContent(summary)], { type: 'text/calendar' });
      const url = URL.createObjectURL(blob);
      const link = root.document.createElement('a');
      link.href = url;
      link.download = 'ecovila-rezervare.ics';
      root.document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Calendar download is a nice-to-have; ignore failures silently.
    }
  }

  // ── States ──────────────────────────────────────────────────────────────────

  const STATE_PANELS = [
    '[data-confirmare-loading]',
    '[data-confirmare-error]',
    '[data-processing-panel]',
    '[data-failed-panel]',
    '[data-cancelled-panel]',
    '[data-celebrate-content]',
  ];

  function showOnly(selector) {
    STATE_PANELS.forEach((panel) => {
      if (panel === selector) {
        show(panel);
      } else {
        hide(panel);
      }
    });
  }

  function showLoadingState() {
    showOnly('[data-confirmare-loading]');
    setText('[data-confirmare-lead]', t('confirmare.loadingLead'));
  }

  function showErrorState() {
    showOnly('[data-confirmare-error]');
    setText('[data-confirmare-lead]', t('confirmare.errorTitle'));
  }

  function showProcessingState() {
    showOnly('[data-processing-panel]');
    setText('[data-confirmare-lead]', t('confirmare.cardPendingTitle'));
  }

  function showFailedState() {
    showOnly('[data-failed-panel]');
    setText('[data-confirmare-lead]', t('confirmare.failedTitle'));
  }

  function showCancelledState() {
    showOnly('[data-cancelled-panel]');
    setText('[data-confirmare-lead]', t('confirmare.cancelledTitle'));
  }

  // ── Celebration rendering ───────────────────────────────────────────────────

  function showCelebration(details, reservationId, manageToken) {
    const summary = details?.reservation || {};
    const reservations = Array.isArray(details?.reservations) ? details.reservations : [];

    showOnly('[data-celebrate-content]');
    setText('[data-confirmare-lead]', t('confirmare.celebrateLead'));

    // Countdown
    const days = daysUntilCheckIn(summary.checkIn);
    const countdown = countdownCopy(days);
    const countdownEl = el('[data-celebrate-countdown]');
    if (countdownEl) {
      countdownEl.hidden = !countdown;
      setText('[data-celebrate-countdown-value]', countdown);
    }

    // Stay details
    setText('[data-celebrate-checkin]', formatDate(summary.checkIn));
    setText('[data-celebrate-checkin-hour]', t('confirmare.fromHour', { hour: CHECK_IN_HOUR }));
    setText('[data-celebrate-checkout]', formatDate(summary.checkOut));
    setText('[data-celebrate-checkout-hour]', t('confirmare.untilHour', { hour: CHECK_OUT_HOUR }));

    const nights = pricing
      ? pricing.enumerateNights(summary.checkIn, summary.checkOut).length
      : 0;
    setText(
      '[data-celebrate-nights]',
      nights === 1 ? t('booking.night') : t('booking.nights', { count: nights }),
    );
    setText('[data-celebrate-guests]', formatGuests(reservations));
    setText(
      '[data-celebrate-total]',
      pricing ? pricing.formatMDL(summary.totalPrice || 0) : `${summary.totalPrice || 0} MDL`,
    );

    // Assigned rooms — the "your key" moment.
    const roomsContainer = el('[data-celebrate-rooms]');
    if (roomsContainer) {
      roomsContainer.innerHTML = '';
      const labels = reservations.length
        ? reservations.map((reservation) => roomLabel(reservation))
        : (Array.isArray(summary.roomLabels) ? summary.roomLabels : []);

      labels.forEach((label) => {
        const tag = root.document.createElement('span');
        tag.className = 'cb-room-tag';
        tag.textContent = label;
        roomsContainer.appendChild(tag);
      });
    }

    // Actions
    const calendarBtn = el('[data-add-calendar]');
    if (calendarBtn) {
      calendarBtn.onclick = () => downloadIcs(summary);
    }

    const directions = el('[data-celebrate-directions]');
    if (directions) {
      directions.href = MAPS_URL;
    }

    const manageLink = el('[data-celebrate-manage]');
    if (manageLink) {
      const params = new URLSearchParams();
      params.set('id', reservationId);
      params.set('manage', manageToken);
      manageLink.href = `gestionare.html?${params.toString()}`;
    }

    trackBrowserPurchaseIfPaid(summary, reservations, reservationId);
  }

  function trackBrowserPurchaseIfPaid(summary, reservations, reservationId) {
    if (_purchaseTracked || summary?.paymentStatus !== 'paid') {
      return;
    }

    const pending = readStorage(STORAGE_PENDING) || {};
    const rows = Array.isArray(reservations) ? reservations : [];
    const eventId = pending.trackingEventId ||
      rows.find((row) => row.tracking_event_id)?.tracking_event_id ||
      summary.bookingGroupId ||
      summary.primaryReservationId ||
      reservationId;
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

  // ── Payment retry ───────────────────────────────────────────────────────────

  let _retryContext = null;
  let _retryInFlight = false;

  /**
   * Rebuild the maib-create-payment request from the pending reservation the
   * checkout flow persisted before redirecting to the gateway. Only reused when
   * it belongs to the reservation on screen, so a stale blob from an unrelated
   * booking never drives a retry.
   */
  function getRetryContext(reservationId, manageToken) {
    const pending = readStorage(STORAGE_PENDING);
    if (!pending || !manageToken || pending.paymentType !== 'card') {
      return null;
    }

    const ids = Array.isArray(pending.reservationIds) ? pending.reservationIds : [];
    const belongsToReservation = pending.primaryReservationId === reservationId ||
      ids.includes(reservationId);

    if (!belongsToReservation || !pending.bookingGroupId || !ids.length) {
      return null;
    }

    return {
      bookingGroupId: pending.bookingGroupId,
      reservationIds: ids,
      primaryReservationId: pending.primaryReservationId || reservationId,
      manageToken,
      paymentRail: pending.paymentRail === 'mia' ? 'mia' : 'card',
    };
  }

  function setupRetryButtons(reservationId, manageToken) {
    _retryContext = getRetryContext(reservationId, manageToken);
    const buttons = root.document?.querySelectorAll('[data-retry-payment]') || [];

    buttons.forEach((button) => {
      if (!_retryContext) {
        button.hidden = true;
        return;
      }

      button.hidden = false;
      button.onclick = () => retryPayment(button);
    });
  }

  async function retryPayment(button) {
    if (!_retryContext || _retryInFlight || !supabaseHelpers) {
      return;
    }

    _retryInFlight = true;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = t('confirmare.retryPaymentLoading');

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const result = await supabaseHelpers.createMaibPaymentRequest(client, _retryContext);

      if (result?.rail === 'mia' || result?.qrUrl) {
        root.location.href = miaPaymentUrl(_retryContext);
        return;
      }

      if (result?.payUrl) {
        root.location.href = result.payUrl;
        return;
      }

      // No checkout URL means the hold has lapsed; leave the status polling to
      // flip the page to the cancelled state once the server confirms it.
      button.disabled = false;
      button.textContent = originalText;
    } catch {
      // A transient failure: re-enable so the guest can try again. If the window
      // truly closed, the card status poller will switch to the cancelled state.
      button.disabled = false;
      button.textContent = originalText;
    } finally {
      _retryInFlight = false;
    }
  }

  // ── Manage redirect ─────────────────────────────────────────────────────────

  function manageUrl(reservationId, manageToken) {
    const params = new URLSearchParams();
    params.set('id', reservationId);
    params.set('manage', manageToken);
    return `gestionare.html?${params.toString()}`;
  }

  function miaPaymentUrl(retryContext) {
    const params = new URLSearchParams();
    params.set('id', retryContext.primaryReservationId);
    params.set('group', retryContext.bookingGroupId);
    if (retryContext.manageToken) {
      params.set('manage', retryContext.manageToken);
    }
    return `plata-mia.html?${params.toString()}`;
  }

  // ── Card status polling ─────────────────────────────────────────────────────

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

    _cardPollTimeout = root.setTimeout(
      () => pollCardReservationStatus(reservationId, manageToken),
      CARD_STATUS_POLL_MS,
    );
  }

  async function pollCardReservationStatus(reservationId, manageToken) {
    _cardPollTimeout = null;
    _cardPollAttempts += 1;

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const rows = await supabaseHelpers.fetchPendingReservationStatus(client, { reservationId, manageToken });
      const serverStatus = rows?.[0] || null;

      if (serverStatus?.payment_status === 'paid') {
        const details = await loadManagedReservation(reservationId, manageToken);
        _context = { details, reservationId, manageToken };
        showCelebration(details, reservationId, manageToken);
        return;
      }

      if (serverStatus?.payment_status === 'cancelled') {
        // Honor the failure hint when the gateway already told us the payment
        // did not go through; a plain cancellation reads differently.
        if (getPaymentHint() === 'failed') {
          showFailedState();
        } else {
          showCancelledState();
        }
        return;
      }
    } catch {
      // Keep the pending payment state visible and try again until the polling window closes.
    }

    scheduleCardStatusPoll(reservationId, manageToken);
  }

  // ── Data loading ────────────────────────────────────────────────────────────

  async function loadManagedReservation(reservationId, manageToken) {
    const client = supabaseHelpers.getSupabaseClient();
    return supabaseHelpers.fetchManagedReservationDetails(client, { reservationId, manageToken });
  }

  function renderReservation(details, reservationId, manageToken) {
    const summary = details?.reservation || null;
    if (!summary) {
      throw new Error('Missing reservation details.');
    }

    _context = { details, reservationId, manageToken };

    // Cash holds (timer, extend, cancel) live on the management page; this page
    // only celebrates confirmed stays.
    if (summary.paymentType === 'cash' && summary.paymentStatus === 'pending') {
      root.location.replace(manageUrl(reservationId, manageToken));
      return;
    }

    if (summary.paymentStatus === 'cancelled') {
      if (getPaymentHint() === 'failed') {
        showFailedState();
      } else {
        showCancelledState();
      }
      return;
    }

    if (summary.paymentStatus === 'paid') {
      showCelebration(details, reservationId, manageToken);
      return;
    }

    // Card payment still pending: show the processing panel and poll until the
    // MAIB callback settles the reservation one way or the other. A failed or
    // closed gateway leaves the reservation pending for the rest of its
    // five-minute hold, so expose the retry action while the window is open.
    if (getPaymentHint() === 'failed') {
      showFailedState();
    } else {
      showProcessingState();
    }

    setupRetryButtons(reservationId, manageToken);

    const serverStatus = {
      payment_status: summary.paymentStatus,
      payment_type: summary.paymentType,
    };
    startCardStatusPolling(reservationId, manageToken, serverStatus);
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

    showLoadingState();

    try {
      const details = await loadManagedReservation(reservationId, manageToken);
      renderReservation(details, reservationId, manageToken);
    } catch {
      showErrorState();
      return;
    }

    root.addEventListener?.('ecovila:languagechange', () => {
      applyI18nToPage();
      if (_context?.details?.reservation?.paymentStatus === 'paid') {
        showCelebration(_context.details, _context.reservationId, _context.manageToken);
      }
    });
  }

  if (root.document) {
    root.document.addEventListener('DOMContentLoaded', init);
  }

  return { init, loadManagedReservation, renderReservation, buildIcsContent, daysUntilCheckIn };
});
