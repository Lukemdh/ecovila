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
      '[data-anulare-too-late]', '[data-anulare-form]', '[data-anulare-success]'];

    all.forEach((sel) => {
      const node = el(sel);
      if (node) node.hidden = sel !== activeAttr;
    });
  }

  function showTooLate(reservation) {
    showState('[data-anulare-too-late]');

    const phone = t('anulare.contactPhone');
    setText('[data-anulare-too-late-text]', t('anulare.tooLateText', { phone }));

    if (reservation) {
      const detailsEl = el('[data-too-late-details]');
      if (detailsEl) detailsEl.hidden = false;

      setText('[data-tl-dates]', `${formatDate(reservation.check_in)} – ${formatDate(reservation.check_out)}`);
      setText('[data-tl-room]', formatRoomLabel(reservation.room_type, reservation.room_number));
    }
  }

  function showForm(reservation) {
    showState('[data-anulare-form]');

    const nights = countNights(reservation.check_in, reservation.check_out);
    setText('[data-res-dates]', `${formatDate(reservation.check_in)} – ${formatDate(reservation.check_out)}`);
    setText('[data-res-nights]', nights === 1 ? t('booking.night') : t('booking.nights', { count: nights }));
    setText('[data-res-guests]', formatGuests(reservation.adults, reservation.kids_ages));
    setText('[data-res-room]', formatRoomLabel(reservation.room_type, reservation.room_number));
    setText('[data-res-total]', pricing ? pricing.formatMDL(reservation.total_price) : `${reservation.total_price} MDL`);
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
    btn.textContent = t('anulare.cancellingButton');
    if (errorEl) errorEl.hidden = true;

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const result = await supabaseHelpers.cancelReservationByToken(client, token, normalizedPhone);

      switch (result) {
        case 'cancelled':
          // Store success flag so refreshing the page still shows success
          try { root.sessionStorage?.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
          showState('[data-anulare-success]');
          break;

        case 'phone_mismatch':
          btn.disabled = false;
          btn.textContent = t('anulare.cancelButton');
          if (errorEl) {
            errorEl.textContent = t('anulare.phoneMismatch');
            errorEl.hidden = false;
          }
          phoneInput.focus();
          break;

        case 'too_late':
          showTooLate(null);
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
      btn.textContent = t('anulare.cancelButton');

      if (errorEl) {
        const isConfigError = !supabaseHelpers;
        errorEl.textContent = isConfigError
          ? t('checkout.errorSupabaseConfig')
          : t('anulare.cancelError');
        errorEl.hidden = false;
      }
    }
  }

  // ── 72-hour check (client-side pre-check) ───────────────────────────────────

  function isWithin72Hours(checkInDate) {
    try {
      const checkInTs = new Date(checkInDate).getTime() + 13 * 60 * 60 * 1000; // 13:00 check-in
      return Date.now() + 72 * 60 * 60 * 1000 > checkInTs;
    } catch {
      return false;
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async function init() {
    // If success was already stored in session (e.g., user refreshed after cancel)
    try {
      if (root.sessionStorage?.getItem(SESSION_KEY)) {
        showState('[data-anulare-success]');
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

    if (reservation.payment_status === 'cancelled' || reservation.cancelled_at) {
      showState('[data-anulare-already-cancelled]');
      return;
    }

    // Client-side 72h pre-check (server will enforce this too, but give early feedback)
    if (isWithin72Hours(reservation.check_in)) {
      showTooLate(reservation);
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
    root.document.addEventListener('DOMContentLoaded', init);
  }

  return { init };
});
