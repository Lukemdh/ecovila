(function (root, factory) {
  const pricing = root.EcoVilaPricing;
  const supabaseHelpers = root.EcoVilaSupabase;
  const api = factory(root, pricing, supabaseHelpers);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaAnulare = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root, pricing, supabaseHelpers) {
  'use strict';

  const STORAGE_LANGUAGE = 'ecovila_language';
  const SESSION_KEY = 'ecovila_anulare_success';
  const SESSION_REFUND_KEY = 'ecovila_anulare_refund_eligible';
  const BUSINESS_TIME_ZONE = 'Europe/Chisinau';
  const DAY_MS = 24 * 60 * 60 * 1000;

  let activeReservation = null;

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

  function getCancellationToken() {
    try {
      return new URLSearchParams(root.location?.search).get('token') || '';
    } catch {
      return '';
    }
  }

  // ── Phone normalization (same logic as checkout.js) ─────────────────────────

  function normalizeMoldovaPhone(value) {
    const compact = String(value || '').trim().replace(/[\s().-]/g, '');

    if (/^0\d{8}$/.test(compact)) return `+373${compact.slice(1)}`;
    if (/^\d{8}$/.test(compact)) return `+373${compact}`;
    if (/^373\d{8}$/.test(compact)) return `+${compact}`;

    return compact;
  }

  // ── Date formatting ─────────────────────────────────────────────────────────

  function formatDate(dateStr) {
    if (!dateStr || !pricing) return dateStr || '--';

    const lang = getLanguage();
    const locale = lang === 'ro' ? 'ro-MD' : lang;

    try {
      return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' })
        .format(pricing.parseISODate(dateStr));
    } catch {
      return dateStr;
    }
  }

  function formatGuests(adults, kidsAges) {
    const kids = Array.isArray(kidsAges) ? kidsAges : [];
    const adultsCopy = adults === 1 ? t('checkout.oneAdult') : t('checkout.adultsCount', { count: adults });
    const kidsCopy = kids.length === 1 ? t('checkout.oneChild') : t('checkout.childrenCount', { count: kids.length });
    const ages = kids.length ? ` (${kids.join(', ')})` : '';

    return `${adultsCopy} · ${kidsCopy}${ages}`;
  }

  function formatRoomLabel(roomType, roomNumber) {
    const typeLabel = t(`accommodation.${roomType || 'hotel'}.title`);
    return roomNumber ? `${typeLabel} #${roomNumber}` : typeLabel;
  }

  function countNights(checkIn, checkOut) {
    if (!pricing) return 0;

    try {
      return pricing.enumerateNights(checkIn, checkOut).length;
    } catch {
      return 0;
    }
  }

  // ── State transitions ───────────────────────────────────────────────────────

  function showState(activeAttr) {
    const all = ['[data-anulare-loading]', '[data-anulare-not-found]', '[data-anulare-already-cancelled]',
      '[data-anulare-form]', '[data-anulare-success]'];

    all.forEach((sel) => {
      const node = el(sel);
      if (node) node.hidden = sel !== activeAttr;
    });
  }

  function showForm(reservation) {
    showState('[data-anulare-form]');

    const nights = countNights(reservation.check_in, reservation.check_out);
    setText('[data-res-dates]', `${formatDate(reservation.check_in)} – ${formatDate(reservation.check_out)}`);
    setText('[data-res-nights]', nights === 1 ? t('booking.night') : t('booking.nights', { count: nights }));
    setText('[data-res-guests]', formatGuests(reservation.adults, reservation.kids_ages));
    setText('[data-res-room]', formatRoomLabel(reservation.room_type, reservation.room_number));
    setText('[data-res-total]', pricing ? pricing.formatMDL(reservation.total_price) : `${reservation.total_price} MDL`);
    updateRefundNote(reservation.check_in);
  }

  // ── Cancellation submit ─────────────────────────────────────────────────────

  async function handleCancel(token) {
    const btn = el('[data-anulare-cancel-btn]');
    const phoneInput = el('[data-phone-input]');
    const errorEl = el('[data-anulare-error]');

    if (!btn || !phoneInput) return;

    const rawPhone = phoneInput.value;
    const normalizedPhone = normalizeMoldovaPhone(rawPhone);

    // Basic client-side check before hitting the server
    if (!/^\+373\d{8}$/.test(normalizedPhone)) {
      if (errorEl) {
        errorEl.textContent = t('checkout.errorPhone');
        errorEl.hidden = false;
      }
      phoneInput.focus();
      return;
    }

    btn.disabled = true;
    setBtnText(btn, t('anulare.cancellingButton'));
    if (errorEl) errorEl.hidden = true;

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const result = await supabaseHelpers.cancelReservationByToken(client, token, normalizedPhone);

      switch (result) {
        case 'cancelled':
          // Store success flag so refreshing the page still shows success
          try {
            root.sessionStorage?.setItem(SESSION_KEY, '1');
            root.sessionStorage?.setItem(
              SESSION_REFUND_KEY,
              isRefundEligible(activeReservation?.check_in) ? 'eligible' : 'ineligible',
            );
          } catch { /* ignore */ }
          updateRefundNote(activeReservation?.check_in);
          showState('[data-anulare-success]');
          break;

        case 'phone_mismatch':
          btn.disabled = false;
          setBtnText(btn, t('anulare.cancelButton'));
          if (errorEl) {
            errorEl.textContent = t('anulare.phoneMismatch');
            errorEl.hidden = false;
          }
          phoneInput.focus();
          break;

        case 'already_cancelled':
          showState('[data-anulare-already-cancelled]');
          break;

        case 'not_found':
        default:
          showState('[data-anulare-not-found]');
          break;
      }
    } catch {
      btn.disabled = false;
      setBtnText(btn, t('anulare.cancelButton'));

      if (errorEl) {
        const isConfigError = !supabaseHelpers;
        errorEl.textContent = isConfigError
          ? t('checkout.errorSupabaseConfig')
          : t('anulare.cancelError');
        errorEl.hidden = false;
      }
    }
  }

  // ── Refund eligibility ──────────────────────────────────────────────────────

  function dateValue(dateString) {
    const [year, month, day] = String(dateString || '').split('-').map(Number);

    if (![year, month, day].every(Number.isFinite)) {
      return Number.NaN;
    }

    return Date.UTC(year, month - 1, day);
  }

  function currentBusinessDate(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: BUSINESS_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);

    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  }

  function isRefundEligible(checkInDate, now = new Date()) {
    const checkInValue = dateValue(checkInDate);
    const todayValue = dateValue(currentBusinessDate(now));

    if (!Number.isFinite(checkInValue) || !Number.isFinite(todayValue)) {
      return false;
    }

    return (checkInValue - todayValue) / DAY_MS >= 7;
  }

  function setRefundNoteByEligibility(eligible) {
    root.document?.querySelectorAll('[data-anulare-refund-note]').forEach((node) => {
      node.textContent = t(eligible ? 'anulare.refundEligibleNote' : 'anulare.refundIneligibleNote');
    });
  }

  function updateRefundNote(checkInDate) {
    if (!checkInDate) {
      return;
    }

    setRefundNoteByEligibility(isRefundEligible(checkInDate));
  }

  function readStoredRefundEligibility() {
    try {
      const stored = root.sessionStorage?.getItem(SESSION_REFUND_KEY);
      if (stored === 'eligible') return true;
      if (stored === 'ineligible') return false;
    } catch { /* ignore */ }

    return null;
  }

  function refreshRefundNotesForCurrentState() {
    if (activeReservation?.check_in) {
      updateRefundNote(activeReservation.check_in);
      return;
    }

    const storedEligibility = readStoredRefundEligibility();
    if (storedEligibility !== null) {
      setRefundNoteByEligibility(storedEligibility);
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async function init() {
    // If success was already stored in session (e.g., user refreshed after cancel)
    try {
      if (root.sessionStorage?.getItem(SESSION_KEY)) {
        showState('[data-anulare-success]');
        refreshRefundNotesForCurrentState();
        return;
      }
    } catch { /* ignore */ }

    const token = getCancellationToken();

    if (!token) {
      showState('[data-anulare-not-found]');
      return;
    }

    showState('[data-anulare-loading]');

    let reservation = null;

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const rows = await supabaseHelpers.fetchReservationByToken(client, token);
      reservation = rows?.[0] || null;
    } catch {
      // Supabase not configured
      showState('[data-anulare-not-found]');
      return;
    }

    if (!reservation) {
      showState('[data-anulare-not-found]');
      return;
    }

    activeReservation = reservation;

    if (reservation.payment_status === 'cancelled' || reservation.cancelled_at) {
      showState('[data-anulare-already-cancelled]');
      return;
    }

    showForm(reservation);

    // Wire up cancel button
    const btn = el('[data-anulare-cancel-btn]');
    btn?.addEventListener('click', () => handleCancel(token));

    // Allow Enter key on phone input to submit
    const phoneInput = el('[data-phone-input]');
    phoneInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleCancel(token);
    });
  }

  if (root.document) {
    root.addEventListener?.('ecovila:languagechange', refreshRefundNotesForCurrentState);
    root.document.addEventListener('DOMContentLoaded', init);
  }

  return { init, isRefundEligible };
});
