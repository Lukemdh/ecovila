(function (root, factory) {
  let pricing = root.EcoVilaPricing;
  let supabaseHelpers = root.EcoVilaSupabase;

  if (!pricing && typeof require === 'function') {
    pricing = require('./pricing.js');
  }

  if (!supabaseHelpers && typeof require === 'function') {
    supabaseHelpers = require('./supabase.js');
  }

  const api = factory(root, pricing, supabaseHelpers);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.EcoVilaCheckout = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root, pricing, supabaseHelpers) {
  'use strict';

  const STORAGE_SELECTION = 'ecovila_booking_selection';
  const STORAGE_PENDING = 'ecovila_pending_reservation';
  const STORAGE_LANGUAGE = 'ecovila_language';
  const STORAGE_TRACKING_EVENT = 'ecovila_booking_tracking_event_id';
  const CASH_EXPIRY_MINUTES = 30;
  const INTERNATIONAL_PHONE_PATTERN = /^\+\d{8,15}$/;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PAYMENT_TYPES = new Set(['cash', 'card']);
  const SUPPORTED_LANGUAGES = new Set(['ro', 'ru', 'en']);

  function getTranslations() {
    return root.EcoVilaTranslations || {};
  }

  function getDocument() {
    return root.document;
  }

  function getLanguage() {
    const documentRef = getDocument();
    return documentRef?.documentElement?.lang || root.localStorage?.getItem(STORAGE_LANGUAGE) || 'ro';
  }

  function t(key, replacements) {
    const translations = getTranslations();
    const language = translations[getLanguage()] ? getLanguage() : 'ro';
    let value = translations[language]?.[key] || translations.ro?.[key] || key;

    Object.entries(replacements || {}).forEach(([name, replacement]) => {
      value = value.replaceAll(`{${name}}`, String(replacement));
    });

    return value;
  }

  function trimText(value) {
    return String(value || '').trim();
  }

  function createReservationId() {
    if (root.crypto?.randomUUID) {
      return root.crypto.randomUUID();
    }

    return `reservation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getOrCreateTrackingEventId(storage) {
    const source = storage || root.localStorage;
    const fromTrackingApi = root.EcoVilaTracking?.getOrCreateEventId?.('booking');

    if (fromTrackingApi) {
      return fromTrackingApi;
    }

    try {
      const stored = source?.getItem(STORAGE_TRACKING_EVENT);
      if (stored) {
        return stored;
      }

      const next = createReservationId();
      source?.setItem(STORAGE_TRACKING_EVENT, next);
      return next;
    } catch (_error) {
      return createReservationId();
    }
  }

  function getCheckoutTrackingContext(selection) {
    const browserIds = root.EcoVilaTracking?.captureBrowserIds?.() || {};

    return {
      tracking_event_id: getOrCreateTrackingEventId(),
      tracking_fbp: browserIds.fbp || '',
      tracking_fbc: browserIds.fbc || '',
      tracking_user_agent: browserIds.userAgent || root.navigator?.userAgent || '',
      tracking_source_url: browserIds.sourceUrl || safeSourceUrl(),
      value: Number(selection?.totalPrice || 0),
      currency: 'MDL',
    };
  }

  function safeSourceUrl() {
    try {
      return `${root.location.origin}${root.location.pathname}`;
    } catch (_error) {
      return 'https://ecovila.md/checkout.html';
    }
  }

  function normalizeInternationalPhone(value) {
    const compact = trimText(value).replace(/[\s().-]/g, '');
    return compact;
  }

  // Rule: a phone number always starts with "+". The field is pre-filled
  // with "+373" but stays fully editable — the user can delete it down to
  // empty. As soon as they type anything, we guarantee a single leading "+"
  // (dropping any stray "+" elsewhere), so the number can never start
  // without one.
  function enforcePhonePlus(input) {
    const raw = input.value;
    const rest = raw.replace(/\+/g, '');
    const next = rest ? `+${rest}` : '';
    if (next === raw) {
      return;
    }
    const atEnd = input.selectionStart === raw.length;
    input.value = next;
    if (atEnd) {
      try {
        input.setSelectionRange(next.length, next.length);
      } catch (_error) {
        // setSelectionRange is unsupported on some input types; ignore.
      }
    }
  }

  function normalizeLanguage(value) {
    const language = trimText(value).toLowerCase();
    return SUPPORTED_LANGUAGES.has(language) ? language : 'ro';
  }

  function getPaymentRail(phone) {
    return normalizeInternationalPhone(phone).startsWith('+373') ? 'mia' : 'card';
  }

  function getOnlinePaymentCopy(phone) {
    return getPaymentRail(phone) === 'mia'
      ? { titleKey: 'checkout.payMia' }
      : { titleKey: 'checkout.payCard' };
  }

  function normalizeGuestDetails(details) {
    return {
      firstName: trimText(details?.firstName),
      lastName: trimText(details?.lastName),
      phone: normalizeInternationalPhone(details?.phone),
      email: trimText(details?.email).toLowerCase(),
      gdprAccepted: Boolean(details?.gdprAccepted),
    };
  }

  function validateGuestDetails(details) {
    const guest = normalizeGuestDetails(details);
    const errors = [];

    if (!guest.firstName || !guest.lastName || !guest.phone || !guest.email) {
      errors.push('checkout.errorRequired');
    } else if (!INTERNATIONAL_PHONE_PATTERN.test(guest.phone)) {
      errors.push('checkout.errorPhone');
    } else if (!EMAIL_PATTERN.test(guest.email)) {
      errors.push('checkout.errorEmail');
    }

    if (!guest.gdprAccepted) {
      errors.push('checkout.errorGdpr');
    }

    return {
      valid: errors.length === 0,
      errors,
      guest,
    };
  }

  function validateCheckoutSelection(selection) {
    const errors = [];

    if (!selection || typeof selection !== 'object') {
      errors.push('checkout.errorSelection');
      return { valid: false, errors };
    }

    if (!pricing?.ROOM_TYPES?.[selection.type]) {
      errors.push('checkout.errorSelection');
    }

    try {
      pricing.enumerateNights(selection.checkIn, selection.checkOut);
    } catch (error) {
      errors.push('checkout.errorSelection');
    }

    const partyValidation = pricing?.validateParty?.({
      adults: Number(selection.adults || 0),
      kidsAges: Array.isArray(selection.kidsAges) ? selection.kidsAges : [],
    });

    if (!partyValidation?.valid) {
      errors.push('checkout.errorSelection');
    }

    if (!Array.isArray(selection.roomIds) || selection.roomIds.length < 1) {
      errors.push('checkout.errorSelection');
    }

    if (!Number.isFinite(Number(selection.totalPrice)) || Number(selection.totalPrice) < 0) {
      errors.push('checkout.errorSelection');
    }

    return {
      valid: errors.length === 0,
      errors: Array.from(new Set(errors)),
    };
  }

  function readStoredSelection(storage) {
    const source = storage || root.localStorage;

    try {
      return JSON.parse(source?.getItem(STORAGE_SELECTION) || 'null');
    } catch (error) {
      return null;
    }
  }

  function splitTotalPrice(total, count) {
    const normalizedCount = Math.max(1, Number(count || 1));
    const normalizedTotal = Math.max(0, Math.round(Number(total || 0)));
    const base = Math.floor(normalizedTotal / normalizedCount);
    const remainder = normalizedTotal - base * normalizedCount;

    return Array.from({ length: normalizedCount }, (_, index) => base + (index === 0 ? remainder : 0));
  }

  function getCashExpiry(now) {
    return new Date(now.getTime() + CASH_EXPIRY_MINUTES * 60 * 1000).toISOString();
  }

  function buildReservationPayloads(selection, guestDetails, paymentType, options) {
    const selectionValidation = validateCheckoutSelection(selection);
    const guestValidation = validateGuestDetails(Object.assign({}, guestDetails, { gdprAccepted: true }));

    if (!selectionValidation.valid) {
      throw new Error(selectionValidation.errors[0]);
    }

    if (!guestValidation.valid) {
      throw new Error(guestValidation.errors[0]);
    }

    if (!PAYMENT_TYPES.has(paymentType)) {
      throw new Error('checkout.errorPayment');
    }

    const now = options?.now || new Date();
    const createId = options?.createId || createReservationId;
    const roomIds = selection.roomIds.map((roomId) => String(roomId));
    const priceParts = splitTotalPrice(selection.totalPrice, roomIds.length);
    const cashExpiresAt = paymentType === 'cash' ? getCashExpiry(now) : null;
    const guest = guestValidation.guest;
    const guestLanguage = normalizeLanguage(selection.language || getLanguage());

    return roomIds.map((roomId, index) => {
      const payload = {
        id: createId(),
        room_id: roomId,
        guest_first_name: guest.firstName,
        guest_last_name: guest.lastName,
        guest_phone: guest.phone,
        guest_email: guest.email,
        guest_language: guestLanguage,
        check_in: selection.checkIn,
        check_out: selection.checkOut,
        adults: Number(selection.adults),
        kids_ages: Array.isArray(selection.kidsAges) ? selection.kidsAges.map((age) => Number(age)) : [],
        total_price: priceParts[index],
        payment_type: paymentType,
        payment_status: 'pending',
        room_explicitly_selected: Boolean(selection.roomExplicitlySelected),
        conference_room: false,
        notes: null,
        cash_expires_at: cashExpiresAt,
        cash_extended: false,
        created_by: 'guest',
      };

      for (const [key, value] of Object.entries(options?.tracking || {})) {
        if (key.startsWith('tracking_') && value) {
          payload[key] = value;
        }
      }

      return payload;
    });
  }

  function formatDate(date) {
    if (!date || !pricing) {
      return '--';
    }

    const language = getLanguage();
    const locale = language === 'ro' ? 'ro-MD' : language;
    return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' })
      .format(pricing.parseISODate(date));
  }

  function formatGuests(selection) {
    const adults = Number(selection?.adults || 0);
    const kidsAges = Array.isArray(selection?.kidsAges) ? selection.kidsAges : [];
    const adultsCopy = adults === 1 ? t('checkout.oneAdult') : t('checkout.adultsCount', { count: adults });
    const kidsCopy = kidsAges.length === 1 ? t('checkout.oneChild') : t('checkout.childrenCount', { count: kidsAges.length });
    const ages = kidsAges.length ? ` (${kidsAges.join(', ')})` : '';

    return `${adultsCopy} · ${kidsCopy}${ages}`;
  }

  function getSelectionNights(selection) {
    try {
      return pricing.enumerateNights(selection.checkIn, selection.checkOut).length;
    } catch (error) {
      return 0;
    }
  }

  function getAccommodationCopy(selection) {
    const title = t(`accommodation.${selection.type}.title`);
    const units = Number(selection.units || selection.roomIds?.length || 1);

    return units > 1 ? `${title} x${units}` : title;
  }

  function hasSelectedRoomNumber(selection) {
    return Boolean(
      selection?.roomExplicitlySelected &&
      Array.isArray(selection.roomNumbers) &&
      selection.roomNumbers.length,
    );
  }

  function getRoomsCopy(selection) {
    if (hasSelectedRoomNumber(selection)) {
      return selection.roomNumbers.map((number) => `#${number}`).join(', ');
    }

    return '';
  }

  function renderBreakdown(container, selection) {
    if (!container) {
      return;
    }

    container.innerHTML = '';
    const nights = selection?.pricingBreakdown?.nightlyBreakdown || [];

    if (!nights.length) {
      const row = getDocument().createElement('li');
      row.textContent = t('checkout.breakdownFallback');
      container.appendChild(row);
      return;
    }

    nights.forEach((night) => {
      const row = getDocument().createElement('li');
      const label = getDocument().createElement('span');
      const price = getDocument().createElement('strong');
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

  function setText(selector, value) {
    const element = getDocument()?.querySelector(selector);

    if (element) {
      element.textContent = value;
    }
  }

  function showMessage(selector, message) {
    const element = getDocument()?.querySelector(selector);

    if (!element) {
      return;
    }

    element.textContent = message || '';
    element.hidden = !message;
  }

  function collectGuestDetails(form) {
    return {
      firstName: form.querySelector('[data-guest-first-name]')?.value,
      lastName: form.querySelector('[data-guest-last-name]')?.value,
      phone: form.querySelector('[data-guest-phone]')?.value,
      email: form.querySelector('[data-guest-email]')?.value,
      gdprAccepted: form.querySelector('[data-gdpr-consent]')?.checked,
    };
  }

  function getReservationIdsForPayment(payloadsOrIds, createResult) {
    if (Array.isArray(createResult?.reservationIds) && createResult.reservationIds.length) {
      return createResult.reservationIds.map((id) => String(id)).filter(Boolean);
    }

    return (Array.isArray(payloadsOrIds) ? payloadsOrIds : [])
      .map((item) => typeof item === 'string' ? item : item?.id)
      .map((id) => String(id || '').trim())
      .filter(Boolean);
  }

  function buildConfirmationUrl(primaryId, manageToken, params, page) {
    const query = new URLSearchParams();
    query.set('id', primaryId);

    if (manageToken) {
      query.set('manage', manageToken);
    }

    Object.entries(params || {}).forEach(([key, value]) => {
      if (value) {
        query.set(key, value);
      }
    });

    return `${page || 'confirmare.html'}?${query.toString()}`;
  }

  function redirectAfterReservation(primaryId, paymentType, payloads, selection, createResult, guestPhone) {
    const normalizedGuestPhone = normalizeInternationalPhone(guestPhone);
    const manageToken = String(createResult?.manageToken || '').trim();

    if (paymentType === 'card') {
      const client = supabaseHelpers.getSupabaseClient();
      return supabaseHelpers.createMaibPaymentRequest(client, {
        primaryReservationId: primaryId,
        bookingGroupId: createResult?.bookingGroupId || primaryId,
        reservationIds: getReservationIdsForPayment(payloads, createResult),
        manageToken,
        totalPrice: Number(selection.totalPrice),
        selection,
        guestPhone: normalizedGuestPhone,
        paymentRail: getPaymentRail(normalizedGuestPhone),
        trackingEventId: payloads[0]?.tracking_event_id || '',
      }).then((result) => {
        if (result?.payUrl) {
          root.location.href = result.payUrl;
          return;
        }

        root.location.href = buildConfirmationUrl(primaryId, manageToken);
      }).catch((error) => {
        // The reservation already exists, so resubmitting the checkout form
        // would only collide with its own pending hold. The confirmation page
        // polls the reservation status and offers the "Continuă plata" retry
        // (ADR-029), so the guest lands there instead of being stranded here.
        console.error('Maib payment could not be started; continuing on the confirmation page', error);
        root.location.href = buildConfirmationUrl(primaryId, manageToken);
      });
    }

    // Cash reservations are still awaiting payment, so they land on the
    // management page where the hold timer and cash actions live.
    root.location.href = buildConfirmationUrl(primaryId, manageToken, null, 'gestionare.html');
    return Promise.resolve();
  }

  function renderCheckout(state) {
    const documentRef = getDocument();
    const empty = documentRef?.querySelector('[data-checkout-empty]');
    const content = documentRef?.querySelector('[data-checkout-content]');
    const validation = validateCheckoutSelection(state.selection);

    if (!validation.valid) {
      if (empty) {
        empty.hidden = false;
      }

      if (content) {
        content.hidden = true;
      }

      return;
    }

    if (empty) {
      empty.hidden = true;
    }

    if (content) {
      content.hidden = false;
    }

    const nights = getSelectionNights(state.selection);
    const roomsRow = documentRef.querySelector('[data-summary-rooms-row]');
    const showRoomsRow = hasSelectedRoomNumber(state.selection);

    if (roomsRow) {
      roomsRow.hidden = !showRoomsRow;
    }

    setText('[data-summary-dates]', `${formatDate(state.selection.checkIn)} - ${formatDate(state.selection.checkOut)}`);
    setText('[data-summary-guests]', formatGuests(state.selection));
    setText('[data-summary-accommodation]', getAccommodationCopy(state.selection));
    setText('[data-summary-rooms]', showRoomsRow ? getRoomsCopy(state.selection) : '');
    setText('[data-summary-nights]', nights === 1 ? t('booking.night') : t('booking.nights', { count: nights }));
    setText('[data-summary-total]', pricing.formatMDL(state.selection.totalPrice));
    renderBreakdown(documentRef.querySelector('[data-summary-breakdown]'), state.selection);

    const guestPhone = documentRef.querySelector('[data-guest-phone]')?.value || '';
    const onlinePaymentCopy = getOnlinePaymentCopy(guestPhone);
    const onlinePaymentTitle = documentRef.querySelector('[data-online-payment-title]');

    if (onlinePaymentTitle) {
      onlinePaymentTitle.dataset.i18n = onlinePaymentCopy.titleKey;
      onlinePaymentTitle.textContent = t(onlinePaymentCopy.titleKey);
    }

    documentRef.querySelectorAll('[data-payment-option]').forEach((button) => {
      const isSelected = button.dataset.paymentOption === state.paymentType;
      button.classList.toggle('is-selected', isSelected);
      button.setAttribute('aria-pressed', String(isSelected));
    });

    const disclaimer = documentRef.querySelector('[data-cash-disclaimer]');
    if (disclaimer) {
      disclaimer.hidden = state.paymentType !== 'cash';
    }
  }

  function setSubmitting(isSubmitting) {
    const button = getDocument()?.querySelector('[data-checkout-submit]');

    if (button) {
      button.disabled = isSubmitting;
      button.textContent = isSubmitting ? t('checkout.submitting') : t('checkout.reserve');
    }
  }

  async function submitCheckout(state, form) {
    showMessage('[data-checkout-error]', '');
    showMessage('[data-checkout-status]', '');

    const guestValidation = validateGuestDetails(collectGuestDetails(form));

    if (!guestValidation.valid) {
      showMessage('[data-checkout-error]', t(guestValidation.errors[0]));
      return;
    }

    let payloads;

    const tracking = getCheckoutTrackingContext(state.selection);

    try {
      payloads = buildReservationPayloads(
        state.selection,
        guestValidation.guest,
        state.paymentType,
        { now: new Date(), tracking },
      );
    } catch (error) {
      showMessage('[data-checkout-error]', t(error.message || 'checkout.errorSelection'));
      return;
    }

    setSubmitting(true);

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const createResult = await supabaseHelpers.createReservationRequest(client, payloads);
      const primaryId = createResult.primaryReservationId || payloads[0].id;
      const reservationIds = Array.isArray(createResult.reservationIds) && createResult.reservationIds.length
        ? createResult.reservationIds
        : payloads.map((payload) => payload.id);

      root.localStorage?.setItem(
        STORAGE_PENDING,
        JSON.stringify({
          primaryReservationId: primaryId,
          bookingGroupId: createResult.bookingGroupId || primaryId,
          reservationIds,
          manageToken: createResult.manageToken || '',
          paymentType: state.paymentType,
          paymentRail: getPaymentRail(guestValidation.guest.phone),
          totalPrice: Number(state.selection.totalPrice),
          trackingEventId: tracking.tracking_event_id,
          createdAt: new Date().toISOString(),
        }),
      );

      root.EcoVilaTracking?.trackInitiateCheckout?.({
        eventId: tracking.tracking_event_id,
        value: Number(state.selection.totalPrice),
        currency: 'MDL',
      });

      // Card guests are sent straight to the payment gateway, so the button
      // stays in its loading state instead of flashing an interim notice; only
      // cash reservations announce the redirect to the confirmation page.
      if (state.paymentType === 'cash') {
        showMessage('[data-checkout-status]', t('checkout.createdCash'));
      }
      await redirectAfterReservation(
        primaryId,
        state.paymentType,
        payloads,
        state.selection,
        createResult,
        guestValidation.guest.phone,
      );
    } catch (error) {
      const message = String(error?.message || '');
      const key = message.includes('Missing Supabase config')
        ? 'checkout.errorSupabaseConfig'
        : 'checkout.errorCreate';
      showMessage('[data-checkout-status]', '');
      showMessage('[data-checkout-error]', t(key));
    } finally {
      setSubmitting(false);
    }
  }

  function initCheckout() {
    const documentRef = getDocument();
    const app = documentRef?.querySelector('[data-checkout-app]');

    if (!app || !pricing || !supabaseHelpers) {
      return;
    }

    const state = {
      selection: readStoredSelection(),
      paymentType: 'card',
    };
    const form = documentRef.querySelector('[data-checkout-form]');
    const phoneInput = documentRef.querySelector('[data-guest-phone]');

    documentRef.querySelectorAll('[data-payment-option]').forEach((button) => {
      button.addEventListener('click', () => {
        state.paymentType = button.dataset.paymentOption || 'card';
        renderCheckout(state);
      });
    });

    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitCheckout(state, form);
    });

    phoneInput?.addEventListener('input', () => {
      enforcePhonePlus(phoneInput);
      renderCheckout(state);
    });

    root.addEventListener?.('ecovila:languagechange', () => {
      renderCheckout(state);
    });

    renderCheckout(state);
  }

  if (getDocument()) {
    getDocument().addEventListener('DOMContentLoaded', initCheckout);
  }

  return {
    CASH_EXPIRY_MINUTES,
    STORAGE_PENDING,
    STORAGE_SELECTION,
    buildReservationPayloads,
    getCashExpiry,
    getOnlinePaymentCopy,
    getPaymentRail,
    getOrCreateTrackingEventId,
    getReservationIdsForPayment,
    buildConfirmationUrl,
    hasSelectedRoomNumber,
    initCheckout,
    normalizeInternationalPhone,
    normalizeLanguage,
    normalizeGuestDetails,
    readStoredSelection,
    redirectAfterReservation,
    splitTotalPrice,
    validateCheckoutSelection,
    validateGuestDetails,
  };
});
