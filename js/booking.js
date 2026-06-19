(function () {
  'use strict';

  const pricing = window.EcoVilaPricing;
  const calendar = window.EcoVilaCalendar;
  const supabaseHelpers = window.EcoVilaSupabase;
  const app = document.querySelector('[data-booking-app]');

  if (!app || !pricing || !calendar) {
    return;
  }

  const STORAGE_SELECTION = 'ecovila_booking_selection';
  const STORAGE_LANGUAGE = 'ecovila_language';
  const TYPE_ORDER = ['small', 'large', 'hotel'];
  const LOOKAHEAD_DAYS = 210;

  const cardImages = {
    small: '/assets/photos/small-villa/exterior.svg',
    large: '/assets/photos/large-villa/exterior.svg',
    hotel: '/assets/photos/hotel/room.svg',
  };

  const PHOTO_TYPE_SECTIONS = {
    small: 'small-villa',
    large: 'large-villa',
    hotel: 'hotel',
  };

  const typeGalleries = {
    small: [
      '/assets/photos/small-villa/exterior.svg',
      '/assets/photos/small-villa/interior.svg',
      '/assets/photos/territory/terrace.svg',
      '/assets/photos/spa/pool.svg',
    ],
    large: [
      '/assets/photos/large-villa/exterior.svg',
      '/assets/photos/large-villa/living.svg',
      '/assets/photos/territory/garden.svg',
      '/assets/photos/restaurant/dining.svg',
    ],
    hotel: [
      '/assets/photos/hotel/room.svg',
      '/assets/photos/hotel/building.svg',
      '/assets/photos/spa/salt-room.svg',
      '/assets/photos/restaurant/tea.svg',
    ],
  };

  const typeImages = {
    small: '/assets/photos/small-villa/interior.svg',
    large: '/assets/photos/large-villa/living.svg',
    hotel: '/assets/photos/hotel/building.svg',
  };

  const fallbackRooms = createFallbackRooms();

  const state = {
    language: localStorage.getItem(STORAGE_LANGUAGE) || document.documentElement.lang || 'ro',
    adults: 1,
    kidsAges: [],
    checkIn: '',
    checkOut: '',
    calendarOpen: false,
    childAgeOverlayOpen: false,
    selectedType: '',
    currentMonth: firstOfMonth(todayISO()),
    rooms: fallbackRooms,
    reservations: [],
    // Prices are never guessed: until the DB load resolves, there are no tiers,
    // so no price renders and checkout stays blocked (see loadBookingData).
    pricingTiers: [],
    holidays: [],
    loading: true,
    loadError: '',
    activeModalType: '',
    activeRoomType: '',
    activeSoldoutType: '',
    soldoutCheckIn: '',
    soldoutMonth: firstOfMonth(todayISO()),
    selectedRoomNumbers: {
      small: [],
      large: [],
      hotel: [],
    },
  };

  function getTranslations() {
    return window.EcoVilaTranslations || {};
  }

  function t(key, replacements) {
    const translations = getTranslations();
    const language = translations[state.language] ? state.language : 'ro';
    let value = translations[language]?.[key] || translations.ro?.[key] || key;

    if (Array.isArray(value)) {
      return value;
    }

    Object.entries(replacements || {}).forEach(([name, replacement]) => {
      value = value.replaceAll(`{${name}}`, String(replacement));
    });

    return value;
  }

  function todayISO() {
    // Single source of truth: the Europe/Chisinau business day (see pricing.js).
    return pricing?.todayISO ? pricing.todayISO() : new Date().toISOString().slice(0, 10);
  }

  function firstOfMonth(date) {
    const parsed = pricing.parseISODate(date);
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1)).toISOString().slice(0, 10);
  }

  function addMonths(date, amount) {
    const parsed = pricing.parseISODate(date);
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + amount, 1))
      .toISOString()
      .slice(0, 10);
  }

  function createFallbackRooms() {
    return Object.values(pricing.ROOM_TYPES).flatMap((config) => {
      return config.roomNumbers.map((number) => ({
        id: `${config.type}-${number}`,
        number,
        type: config.type,
        is_active: true,
      }));
    });
  }

  function normalizeAvailabilityBlocks(blocks) {
    return (blocks || []).map((block) => ({
      room_id: block.room_id,
      check_in: block.check_in,
      check_out: block.check_out,
      payment_status: 'paid',
      cancelled_at: null,
    }));
  }

  function mergePublishedPhotos(library) {
    Object.entries(PHOTO_TYPE_SECTIONS).forEach(([type, section]) => {
      const photos = (library?.[section] || [])
        .filter((photo) => photoUrl(photo, 'preview'));

      if (!photos.length) {
        return;
      }

      cardImages[type] = photoUrl(photos[0], 'card');
      typeImages[type] = photoUrl(photos[0], 'full');
      typeGalleries[type] = photos;
    });
  }

  async function loadBookingData() {
    try {
      const client = supabaseHelpers.getSupabaseClient();
      const startDate = todayISO();
      const endDate = pricing.addDays(startDate, LOOKAHEAD_DAYS);
      const photoLibraryPromise = supabaseHelpers.fetchPublicPhotoLibrary
        ? supabaseHelpers.fetchPublicPhotoLibrary(client).catch(() => ({}))
        : Promise.resolve({});
      // Holidays are recurring month-day rules, so every row applies to future
      // stays regardless of the stored year — never filter them by date range.
      const [rooms, pricingTiers, holidays, blocks, photoLibrary] = await Promise.all([
        supabaseHelpers.fetchRooms(client),
        supabaseHelpers.fetchPricingTiers(client),
        supabaseHelpers.fetchHolidays(client),
        supabaseHelpers.fetchAvailabilityBlocks(client, { startDate, endDate }),
        photoLibraryPromise,
      ]);

      if (!pricingTiers.length) {
        throw new Error('No pricing tiers configured.');
      }

      mergePublishedPhotos(photoLibrary);
      // Share the published photo library so other modules (e.g. facilities.js)
      // can reuse it instead of issuing a second fetch.
      window.EcoVilaPhotoLibrary = photoLibrary;
      window.dispatchEvent(new CustomEvent('ecovila:photolibrary', { detail: { library: photoLibrary } }));
      state.rooms = rooms.length ? rooms : createFallbackRooms();
      state.pricingTiers = pricingTiers;
      state.holidays = holidays || [];
      state.reservations = normalizeAvailabilityBlocks(blocks);
      state.loadError = '';
    } catch (error) {
      // Booking must not proceed on guessed prices or stale availability, so a
      // failed load blocks checkout instead of silently using fallbacks.
      state.pricingTiers = [];
      state.loadError = t('booking.loadError');
    } finally {
      state.loading = false;
      render();
    }
  }

  function getPricingParty() {
    return {
      adults: state.adults,
      kidsAges: state.kidsAges.map((age) => (age === '' ? 4 : Number(age))),
    };
  }

  function getCheckoutParty() {
    return {
      adults: state.adults,
      kidsAges: state.kidsAges.map((age) => Number(age)),
    };
  }

  function hasMissingChildAges() {
    return state.kidsAges.some((age) => age === '' || Number.isNaN(Number(age)));
  }

  function getPartyError() {
    if (state.adults < 1) {
      return t('booking.adultRequired');
    }

    if (hasMissingChildAges()) {
      return t('booking.ageRequired');
    }

    const validation = pricing.validateParty(getCheckoutParty(), { publicBooking: true });
    return validation.valid ? '' : validation.errors[0];
  }

  function getStayNights() {
    if (!state.checkIn || !state.checkOut) {
      return 0;
    }

    try {
      return pricing.enumerateNights(state.checkIn, state.checkOut).length;
    } catch (error) {
      return 0;
    }
  }

  function hasSelectedDates() {
    return getStayNights() > 0;
  }

  function calculateQuote(type, checkIn, checkOut, units, forceDayType) {
    try {
      return pricing.calculateStayPrice({
        roomType: type,
        adults: state.adults,
        kidsAges: getPricingParty().kidsAges,
        checkIn,
        checkOut,
        units,
        forceDayType,
        pricingTiers: state.pricingTiers,
        holidays: state.holidays,
      });
    } catch (error) {
      return null;
    }
  }

  function formatDate(date) {
    if (!date) {
      return '--';
    }

    const locale = state.language === 'ro' ? 'ro-MD' : state.language;
    return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(pricing.parseISODate(date));
  }

  function formatMonth(date) {
    const locale = state.language === 'ro' ? 'ro-MD' : state.language;
    const formatted = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(pricing.parseISODate(date));
    return formatted.charAt(0).toLocaleUpperCase(locale) + formatted.slice(1);
  }

  function getCardTitle(type, neededUnits) {
    const title = t(`accommodation.${type}.title`);
    return neededUnits > 1 ? `${title} x${neededUnits}` : title;
  }

  function getTranslatedList(key) {
    const value = t(key);
    return Array.isArray(value) ? value : [];
  }

  function renderPlainList(container, items) {
    container.innerHTML = '';

    items.forEach((item) => {
      const listItem = document.createElement('li');
      listItem.textContent = item;
      container.appendChild(listItem);
    });
  }

  function photoUrl(photo, variant) {
    if (!photo) {
      return '';
    }

    if (typeof photo === 'string') {
      return photo;
    }

    const key = `${variant || 'preview'}Url`;
    return photo[key] || photo.url || photo.previewUrl || photo.originalUrl || '';
  }

  function prepareLazyImage(image) {
    image.loading = 'lazy';
    image.decoding = 'async';
  }

  function markImageOrientation(image) {
    const update = () => {
      const { naturalHeight, naturalWidth } = image;
      const isPortrait = naturalHeight > naturalWidth;
      image.classList.toggle('is-portrait', isPortrait);
      image.classList.toggle('is-landscape', !isPortrait);
      image.dataset.orientation = isPortrait ? 'portrait' : 'landscape';
    };

    image.classList.remove('is-portrait', 'is-landscape');
    image.dataset.orientation = '';

    if (image.complete && image.naturalWidth) {
      update();
      return;
    }

    image.addEventListener('load', update, { once: true });
  }

  function getCardInfo(type) {
    const party = getPricingParty();
    const partyFits = pricing.isTypeAvailableForParty(type, party);

    if (!partyFits) {
      return {
        mode: 'unavailable',
        neededUnits: pricing.getUnitsNeeded(type, party),
        availableRooms: [],
        availableCount: 0,
        isAvailable: false,
        isUnavailableForParty: true,
        quote: null,
      };
    }

    const neededUnits = pricing.getUnitsNeeded(type, party);

    if (hasSelectedDates()) {
      const availableRooms = calendar.getAvailableRooms({
        rooms: state.rooms,
        reservations: state.reservations,
        checkIn: state.checkIn,
        checkOut: state.checkOut,
        type,
      });
      const quote = calculateQuote(type, state.checkIn, state.checkOut, neededUnits);

      return {
        mode: 'selected',
        neededUnits,
        availableRooms,
        availableCount: availableRooms.length,
        isAvailable: availableRooms.length >= neededUnits,
        quote,
      };
    }

    const earliest = calendar.findEarliestAvailability({
      rooms: state.rooms,
      reservations: state.reservations,
      startDate: todayISO(),
      maxDays: LOOKAHEAD_DAYS,
      stayNights: 1,
      type,
      party,
    });
    // Before any dates are chosen the "De la" teaser always quotes a weekday
    // rate, so the headline price never jumps because the earliest opening
    // happens to land on a premium night.
    const quote = earliest ? calculateQuote(type, earliest.checkIn, earliest.checkOut, neededUnits, 'weekday') : null;

    return {
      mode: 'preview',
      neededUnits,
      availableRooms: earliest?.availableRooms || [],
      availableCount: earliest?.availableCount || 0,
      isAvailable: Boolean(earliest),
      earliest,
      quote,
    };
  }

  function syncAvailableSelectedRooms(type, info) {
    if (!hasSelectedDates()) {
      return;
    }

    const availableNumbers = new Set(info.availableRooms.map((room) => Number(room.number)));
    state.selectedRoomNumbers[type] = state.selectedRoomNumbers[type]
      .filter((number) => availableNumbers.has(Number(number)))
      .slice(0, info.neededUnits);
  }

  function render() {
    state.language = document.documentElement.lang || localStorage.getItem(STORAGE_LANGUAGE) || state.language;

    if (state.selectedType && !pricing.isTypeAvailableForParty(state.selectedType, getPricingParty())) {
      state.selectedType = '';
    }

    renderGuestControls();
    renderCalendar();
    renderStaySummary();
    renderCards();
    renderStatus();
  }

  function renderGuestControls() {
    document.querySelector('[data-adults-value]').textContent = String(state.adults);
    document.querySelector('[data-kids-value]').textContent = String(state.kidsAges.length);

    document.querySelectorAll('[data-counter="adults"][data-counter-action="decrease"]').forEach((button) => {
      button.disabled = state.adults <= 0;
    });
    document.querySelectorAll('[data-counter="children"][data-counter-action="decrease"]').forEach((button) => {
      button.disabled = state.kidsAges.length <= 0;
    });

    const container = document.querySelector('[data-child-ages]');
    const template = document.querySelector('template[data-age-placeholder]');
    const overlay = document.querySelector('[data-child-age-overlay]');
    container.innerHTML = '';
    overlay.hidden = !state.childAgeOverlayOpen || !state.kidsAges.length;

    state.kidsAges.forEach((age, index) => {
      const fragment = template.content.cloneNode(true);
      const row = fragment.querySelector('.child-age-row');
      const label = row.querySelector('span');
      const select = row.querySelector('select');
      label.textContent = `${t('booking.childAge')} ${index + 1}`;
      select.value = age;
      select.querySelector('option[value=""]').textContent = t('booking.childAgePlaceholder');
      select.addEventListener('change', () => {
        state.kidsAges[index] = select.value;
        render();
      });
      container.appendChild(fragment);
    });

    const error = getPartyError();
    const errorElement = document.querySelector('[data-party-error]');
    if (state.childAgeOverlayOpen) {
      errorElement.hidden = true;
      errorElement.textContent = '';
      return;
    }
    errorElement.hidden = !error;
    errorElement.textContent = error;
  }

  function renderStatus() {
    const status = document.querySelector('[data-status-message]');
    if (!status) {
      return;
    }

    if (state.loading) {
      status.textContent = t('booking.loading');
    } else if (state.loadError) {
      status.textContent = state.loadError;
    } else if (hasSelectedDates()) {
      status.textContent = t('booking.selectedRange', {
        checkIn: formatDate(state.checkIn),
        checkOut: formatDate(state.checkOut),
      });
    } else {
      status.textContent = t('booking.noDates');
    }
  }

  function showChildAgeOverlay() {
    state.childAgeOverlayOpen = state.kidsAges.length > 0;
  }

  function confirmChildAges() {
    state.childAgeOverlayOpen = false;
    render();
  }

  function renderStaySummary() {
    document.querySelector('[data-check-in]').textContent = formatDate(state.checkIn);
    document.querySelector('[data-check-out]').textContent = formatDate(state.checkOut);

    const summary = document.querySelector('[data-stay-summary]');
    const nights = getStayNights();
    if (!nights) {
      summary.textContent = t('booking.noDates');
      return;
    }

    summary.textContent = nights === 1 ? t('booking.night') : t('booking.nights', { count: nights });
  }

  function renderCalendar() {
    const title = document.querySelector('[data-calendar-title]');
    const grid = document.querySelector('[data-calendar-grid]');
    const shell = document.querySelector('[data-date-picker-shell]');
    const calendarElement = document.querySelector('[data-booking-calendar]');
    shell.classList.toggle('is-calendar-open', state.calendarOpen);
    calendarElement.setAttribute('aria-hidden', String(!state.calendarOpen));
    title.textContent = formatMonth(state.currentMonth);
    grid.innerHTML = '';

    const monthStart = pricing.parseISODate(state.currentMonth);
    const mondayOffset = (monthStart.getUTCDay() + 6) % 7;
    const startDate = pricing.addDays(state.currentMonth, -mondayOffset);
    const party = getPricingParty();

    for (let index = 0; index < 42; index += 1) {
      const date = pricing.addDays(startDate, index);
      const parsed = pricing.parseISODate(date);
      const isOutsideMonth = parsed.getUTCMonth() !== monthStart.getUTCMonth();
      const isPast = date < todayISO();
      const dateSelection = isPast ? null : calendar.getDateSelectionState({
        rooms: state.rooms,
        reservations: state.reservations,
        date,
        checkIn: state.checkIn,
        checkOut: state.checkOut,
        party,
      });
      const unavailable = Boolean(dateSelection?.isUnavailable);
      const button = document.createElement('button');
      const numberElement = document.createElement('span');
      const isCheckIn = date === state.checkIn;
      const isCheckOut = date === state.checkOut;
      button.type = 'button';
      numberElement.className = 'calendar-day__number';
      numberElement.textContent = String(parsed.getUTCDate());
      button.appendChild(numberElement);
      button.dataset.date = date;
      button.disabled = isPast || !dateSelection?.isSelectable;
      button.classList.toggle('is-muted', isOutsideMonth);
      button.classList.toggle('is-unavailable', unavailable);
      button.classList.toggle('is-selected', isCheckIn || isCheckOut);
      button.classList.toggle('is-range-start', isCheckIn);
      button.classList.toggle('is-range-end', isCheckOut);
      button.classList.toggle(
        'is-in-range',
        Boolean(state.checkIn && state.checkOut && date > state.checkIn && date < state.checkOut),
      );
      button.setAttribute(
        'aria-label',
        unavailable ? `${date}, ${t('booking.calendarUnavailable')}` : date,
      );
      button.addEventListener('click', () => selectDate(date));
      grid.appendChild(button);
    }
  }

  function renderCards() {
    TYPE_ORDER.forEach((type) => {
      const card = document.querySelector(`[data-stay-card="${type}"]`);
      const info = getCardInfo(type);
      syncAvailableSelectedRooms(type, info);
      const selectedNumbers = state.selectedRoomNumbers[type];
      const isUnavailableForParty = Boolean(info.isUnavailableForParty);
      const isSoldOut = !isUnavailableForParty && hasSelectedDates() && !info.isAvailable;
      const isSelected = state.selectedType === type;

      card.classList.toggle('is-sold-out', isSoldOut);
      card.classList.toggle('is-unavailable-party', isUnavailableForParty);
      card.classList.toggle('is-selected', isSelected && !isUnavailableForParty);
      const cardImage = card.querySelector('[data-card-image]');
      prepareLazyImage(cardImage);
      cardImage.src = cardImages[type];
      markImageOrientation(cardImage);
      card.querySelector('[data-card-title]').textContent = getCardTitle(type, info.neededUnits);
      card.querySelector('[data-card-capacity]').textContent = t(`accommodation.${type}.capacity`);

      const soldoutBadge = card.querySelector('[data-soldout-badge]');

      if (isUnavailableForParty) {
        soldoutBadge.hidden = false;
        soldoutBadge.textContent = t('booking.unavailableForParty');
      } else {
        soldoutBadge.hidden = !isSoldOut;
        soldoutBadge.textContent = t('booking.soldOut');
      }

      const availability = card.querySelector('[data-card-availability]');
      const price = card.querySelector('[data-card-price]');
      const reserveButton = card.querySelector('[data-card-reserve]');
      const roomButton = card.querySelector('[data-card-room]');
      const soldoutButton = card.querySelector('[data-card-soldout]');
      const selectedRooms = card.querySelector('[data-card-selected-rooms]');
      const roomChoiceText = selectedNumbers.length
        ? t('booking.roomSelected', { numbers: selectedNumbers.map((number) => `#${number}`).join(', ') })
        : t('booking.chooseRoomNumber');

      if (isUnavailableForParty) {
        availability.textContent = '';
        price.textContent = '';
        reserveButton.hidden = true;
        reserveButton.disabled = true;
        roomButton.hidden = true;
        roomButton.disabled = true;
        soldoutButton.hidden = true;
      } else if (hasSelectedDates()) {
        availability.textContent = '';
        price.textContent = info.isAvailable && info.quote
          ? t('booking.priceForStay', { price: pricing.formatMDL(info.quote.total) })
          : '';
        reserveButton.hidden = isSoldOut;
        reserveButton.disabled = isSoldOut;
        roomButton.disabled = isSoldOut;
        soldoutButton.hidden = !isSoldOut;
      } else if (info.earliest) {
        availability.textContent = t('booking.earliest', { date: formatDate(info.earliest.checkIn) });
        price.textContent = info.quote
          ? t('booking.priceFrom', { price: pricing.formatMDL(info.quote.total) })
          : '';
        reserveButton.hidden = true;
        reserveButton.disabled = true;
        roomButton.disabled = true;
        soldoutButton.hidden = true;
      } else {
        availability.textContent = t('booking.noAvailability');
        price.textContent = '';
        reserveButton.hidden = true;
        reserveButton.disabled = true;
        roomButton.disabled = true;
        soldoutButton.hidden = false;
      }

      // Selecting a card turns its primary button into the checkout CTA, so the
      // separate continue bar is no longer needed.
      if (isSelected) {
        reserveButton.textContent = t('booking.continue');
        if (!reserveButton.hidden) {
          reserveButton.disabled = Boolean(getPartyError());
        }
      } else {
        reserveButton.textContent = t('booking.reserve');
      }
      roomButton.hidden = state.selectedType !== type || isUnavailableForParty;
      if (isSoldOut) {
        roomButton.hidden = true;
      }
      roomButton.textContent = selectedNumbers.length
        ? t('booking.roomSelected', { numbers: selectedNumbers.map((number) => `#${number}`).join(', ') })
        : t('booking.chooseRoomNumber');
      roomButton.setAttribute('aria-label', roomChoiceText);
      selectedRooms.hidden = true;
      selectedRooms.textContent = '';
    });
  }

  let suppressCalendarClose = false;
  const lookupState = {
    lookupId: '',
    manageToken: '',
    reservations: [],
  };

  function selectDate(date) {
    if (!state.checkIn || state.checkOut || date <= state.checkIn) {
      state.checkIn = date;
      state.checkOut = '';
    } else {
      state.checkOut = date;
    }

    state.calendarOpen = true;
    suppressCalendarClose = true;
    render();
    requestAnimationFrame(() => { suppressCalendarClose = false; });
  }

  function openCalendar() {
    state.calendarOpen = true;
    renderCalendar();
  }

  function closeCalendar() {
    if (!state.calendarOpen) {
      return;
    }

    state.calendarOpen = false;
    renderCalendar();
  }

  function clearCalendarDates() {
    state.checkIn = '';
    state.checkOut = '';
    state.calendarOpen = true;
    render();
  }

  function updateCounter(counter, action) {
    const direction = action === 'increase' ? 1 : -1;

    if (counter === 'adults') {
      state.adults = Math.max(0, Math.min(10, state.adults + direction));
    }

    if (counter === 'children') {
      if (direction > 0 && state.kidsAges.length < 10) {
        state.kidsAges.push('');
      }

      if (direction < 0) {
        state.kidsAges.pop();
      }

      showChildAgeOverlay();
    }

    render();
  }

  function selectType(type) {
    if (!TYPE_ORDER.includes(type)) {
      return;
    }

    const party = getPricingParty();
    if (!pricing.isTypeAvailableForParty(type, party)) {
      return;
    }

    state.selectedType = type;
    renderCards();
    renderCalendar();
  }

  function continueToCheckout() {
    if (!state.selectedType) {
      return;
    }

    reserveType(state.selectedType);
  }

  function openDetails(type) {
    state.activeModalType = type;
    renderDetailsModal(type, { resetIndex: true });
    showModal(document.querySelector('[data-booking-modal]'));
  }

  function galleryLabels() {
    return {
      prev: t('gallery.prev'),
      next: t('gallery.next'),
      close: t('gallery.close'),
      expand: t('gallery.expand'),
      image: t('booking.image'),
    };
  }

  function renderDetailsModal(type, options) {
    const modal = document.querySelector('[data-booking-modal]');
    const gallery = typeGalleries[type] || [typeImages[type]];
    const galleryElement = modal.querySelector('[data-booking-modal-gallery]');

    if (galleryElement && window.EcoVilaGallery) {
      window.EcoVilaGallery.attach(galleryElement).update({
        photos: gallery,
        alt: t(`accommodation.${type}.title`),
        labels: galleryLabels(),
        startIndex: options?.resetIndex ? 0 : undefined,
      });
    }

    modal.querySelector('[data-booking-modal-title]').textContent = t(`accommodation.${type}.title`);
    modal.querySelector('[data-booking-modal-body]').textContent = t(`accommodation.${type}.details`);

    renderPlainList(modal.querySelector('[data-booking-modal-bathroom]'), getTranslatedList('accommodation.shared.bathroom'));
    renderPlainList(modal.querySelector('[data-booking-modal-facilities]'), getTranslatedList('accommodation.shared.facilities'));

    modal.querySelector('[data-booking-modal-error]').hidden = true;
    syncDetailsReserve(type);
  }

  function showDetailsError(message) {
    const error = document.querySelector('[data-booking-modal-error]');
    error.textContent = message;
    error.hidden = false;
  }

  // Mirrors the stay card's primary button inside the details modal: once the
  // villa is selected the CTA flips to "Continuă" and a second click checks out.
  function syncDetailsReserve(type) {
    const button = document.querySelector('[data-booking-modal-reserve]');
    const isSelected = state.selectedType === type;
    button.textContent = isSelected ? t('booking.continue') : t('booking.select');
    button.disabled = isSelected && Boolean(getPartyError());
  }

  function reserveType(type) {
    if (state.loading || state.loadError || !state.pricingTiers.length) {
      showDetailsError(state.loading ? t('booking.loading') : t('booking.loadError'));
      return;
    }

    const partyError = getPartyError();
    if (partyError) {
      showDetailsError(partyError);
      return;
    }

    if (!hasSelectedDates()) {
      showDetailsError(t('booking.checkoutMissingDates'));
      return;
    }

    const info = getCardInfo(type);
    if (!info.isAvailable) {
      showDetailsError(t('booking.checkoutUnavailable'));
      return;
    }

    try {
      const party = getCheckoutParty();
      const assignment = calendar.chooseRoomsForAssignment({
        rooms: state.rooms,
        reservations: state.reservations,
        type,
        checkIn: state.checkIn,
        checkOut: state.checkOut,
        party,
        selectedRoomNumbers: state.selectedRoomNumbers[type],
      });
      const quote = pricing.calculateStayPrice({
        roomType: type,
        adults: party.adults,
        kidsAges: party.kidsAges,
        checkIn: state.checkIn,
        checkOut: state.checkOut,
        units: assignment.neededUnits,
        pricingTiers: state.pricingTiers,
        holidays: state.holidays,
      });

      localStorage.setItem(
        STORAGE_SELECTION,
        JSON.stringify({
          type,
          checkIn: state.checkIn,
          checkOut: state.checkOut,
          adults: party.adults,
          kidsAges: party.kidsAges,
          units: assignment.neededUnits,
          roomNumbers: assignment.roomNumbers,
          roomIds: assignment.roomIds,
          roomExplicitlySelected: state.selectedRoomNumbers[type].length > 0,
          totalPrice: quote.total,
          pricingBreakdown: quote,
          language: state.language,
        }),
      );

      window.location.href = 'checkout.html';
    } catch (error) {
      showDetailsError(error.message || t('booking.checkoutUnavailable'));
    }
  }

  function openRoomPanel(type) {
    if (!hasSelectedDates()) {
      return;
    }

    state.activeRoomType = type;
    const info = getCardInfo(type);
    const modal = document.querySelector('[data-room-panel]');
    modal.querySelector('[data-room-panel-title]').textContent = `${t('booking.roomPanelTitle')} · ${t(`accommodation.${type}.title`)}`;
    modal.querySelector('[data-room-panel-intro]').textContent = t('booking.roomPanelIntro', {
      count: info.neededUnits,
    });
    renderRoomNumbers(type, info);
    showModal(modal);
  }

  function renderRoomNumbers(type, info) {
    const grid = document.querySelector('[data-room-number-grid]');
    const selected = state.selectedRoomNumbers[type];
    grid.innerHTML = '';

    info.availableRooms
      .slice()
      .sort((left, right) => Number(left.number) - Number(right.number))
      .forEach((room) => {
        const number = Number(room.number);
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = String(number);
        button.setAttribute('aria-label', t('booking.roomNumber', { number }));
        button.classList.toggle('is-selected', selected.includes(number));
        button.disabled = !selected.includes(number) && selected.length >= info.neededUnits;
        button.addEventListener('click', () => {
          if (selected.includes(number)) {
            state.selectedRoomNumbers[type] = selected.filter((item) => item !== number);
          } else if (selected.length < info.neededUnits) {
            state.selectedRoomNumbers[type] = selected.concat(number);
          }

          closeAllModals();
          renderCards();
        });
        grid.appendChild(button);
      });
  }

  function openSoldoutModal(type) {
    state.activeSoldoutType = type;
    state.soldoutCheckIn = '';
    state.soldoutMonth = firstOfMonth(todayISO());
    const modal = document.querySelector('[data-soldout-modal]');
    modal.querySelector('[data-soldout-title]').textContent = `${t('booking.futureAvailability')} · ${t(`accommodation.${type}.title`)}`;
    modal.querySelector('[data-soldout-intro]').textContent = t('booking.soldoutPickCheckIn');
    renderSoldoutCalendar(type);
    showModal(modal);
  }

  function isTypeRangeAvailable(type, checkIn, checkOut) {
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      return false;
    }

    const rooms = calendar.getAvailableRooms({
      rooms: state.rooms,
      reservations: state.reservations,
      checkIn,
      checkOut,
      type,
    });
    const neededUnits = pricing.getUnitsNeeded(type, getPricingParty());
    return rooms.length >= neededUnits;
  }

  function selectSoldoutDate(type, date) {
    if (!state.soldoutCheckIn || date <= state.soldoutCheckIn) {
      state.soldoutCheckIn = date;
      renderSoldoutCalendar(type);
      return;
    }

    if (!isTypeRangeAvailable(type, state.soldoutCheckIn, date)) {
      return;
    }

    state.checkIn = state.soldoutCheckIn;
    state.checkOut = date;
    state.soldoutCheckIn = '';
    closeAllModals();
    render();
  }

  function renderSoldoutCalendar(type) {
    const wrapper = document.querySelector('[data-soldout-calendar]');
    const grid = wrapper.querySelector('[data-soldout-grid]');
    const title = wrapper.querySelector('[data-soldout-month]');
    const prevButton = wrapper.querySelector('[data-soldout-prev]');
    const intro = document.querySelector('[data-soldout-intro]');

    intro.textContent = state.soldoutCheckIn
      ? t('booking.soldoutPickCheckOut', { date: formatDate(state.soldoutCheckIn) })
      : t('booking.soldoutPickCheckIn');

    title.textContent = formatMonth(state.soldoutMonth);
    prevButton.disabled = state.soldoutMonth <= firstOfMonth(todayISO());
    grid.innerHTML = '';

    const monthStart = pricing.parseISODate(state.soldoutMonth);
    const mondayOffset = (monthStart.getUTCDay() + 6) % 7;
    const startDate = pricing.addDays(state.soldoutMonth, -mondayOffset);

    for (let index = 0; index < 42; index += 1) {
      const date = pricing.addDays(startDate, index);
      const parsed = pricing.parseISODate(date);
      const isOutsideMonth = parsed.getUTCMonth() !== monthStart.getUTCMonth();
      const isPast = date < todayISO();
      const isPendingCheckIn = date === state.soldoutCheckIn;
      const oneNightAvailable = !isPast && isTypeRangeAvailable(type, date, pricing.addDays(date, 1));
      const checkoutAvailable = Boolean(
        state.soldoutCheckIn &&
        date > state.soldoutCheckIn &&
        isTypeRangeAvailable(type, state.soldoutCheckIn, date),
      );
      const available = state.soldoutCheckIn
        ? (date <= state.soldoutCheckIn ? oneNightAvailable : checkoutAvailable)
        : oneNightAvailable;
      const unavailable = !isPast && !available;
      const button = document.createElement('button');
      const numberElement = document.createElement('span');
      button.type = 'button';
      numberElement.className = 'calendar-day__number';
      numberElement.textContent = String(parsed.getUTCDate());
      button.appendChild(numberElement);
      button.dataset.date = date;
      button.disabled = isPast || !available;
      button.classList.toggle('is-muted', isOutsideMonth);
      button.classList.toggle('is-unavailable', unavailable);
      button.classList.toggle('is-selected', isPendingCheckIn);
      button.classList.toggle('is-range-start', isPendingCheckIn);
      button.setAttribute(
        'aria-label',
        unavailable ? `${date}, ${t('booking.calendarUnavailable')}` : date,
      );
      button.addEventListener('click', () => selectSoldoutDate(type, date));
      grid.appendChild(button);
    }
  }

  function showModal(modal) {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeAllModals() {
    document.querySelectorAll('.booking-modal').forEach((modal) => {
      modal.hidden = true;
    });
    document.body.style.overflow = '';
  }

  function normalizeLookupPhone(value) {
    return String(value || '').trim().replace(/[\s().-]/g, '');
  }

  // Country-specific phone length guard. Moldova (+373) numbers carry 8 national
  // digits, Romania (+40) and Ukraine (+380) carry 9. Any other country falls
  // back to the generic E.164 length (8–15 digits). Keep this in sync with the
  // identical helper in checkout.js / anulare.js and the server reservations.ts
  // guard.
  function isValidGuestPhone(phone) {
    const value = String(phone || '');
    if (value.startsWith('+373')) return /^\+373\d{8}$/.test(value);
    if (value.startsWith('+380')) return /^\+380\d{9}$/.test(value);
    if (value.startsWith('+40')) return /^\+40\d{9}$/.test(value);
    return /^\+\d{8,15}$/.test(value);
  }

  function openReservationLookup() {
    const modal = document.querySelector('[data-reservation-lookup-modal]');
    const error = document.querySelector('[data-lookup-error]');
    const phoneStep = document.querySelector('[data-lookup-phone-step]');
    const codeStep = document.querySelector('[data-lookup-code-step]');
    const results = document.querySelector('[data-lookup-results]');

    lookupState.lookupId = '';
    lookupState.manageToken = '';
    lookupState.reservations = [];
    if (error) error.hidden = true;
    if (phoneStep) phoneStep.hidden = false;
    if (codeStep) codeStep.hidden = true;
    if (results) {
      results.hidden = true;
      results.innerHTML = '';
    }
    if (!modal) return;
    showModal(modal);
    document.querySelector('[data-lookup-phone]')?.focus();
  }

  function setLookupError(message) {
    const error = document.querySelector('[data-lookup-error]');
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
  }

  async function startReservationLookup() {
    const button = document.querySelector('[data-lookup-start]');
    const phoneInput = document.querySelector('[data-lookup-phone]');
    const phone = normalizeLookupPhone(phoneInput?.value);

    if (!isValidGuestPhone(phone)) {
      setLookupError(t('checkout.errorPhone'));
      phoneInput?.focus();
      return;
    }

    if (!supabaseHelpers) {
      setLookupError(t('checkout.errorSupabaseConfig'));
      return;
    }

    if (button) button.disabled = true;
    const error = document.querySelector('[data-lookup-error]');
    if (error) error.hidden = true;

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const result = await supabaseHelpers.startReservationLookup(client, phone);

      // Too many code requests for this number in a short window: tell the guest
      // to wait instead of advancing to a code step that can never be verified.
      if (result.rateLimited) {
        setLookupError(t('booking.lookupRateLimited'));
        return;
      }

      // No active reservation matches this phone, so no SMS was sent. Surface the
      // mismatch on the phone step instead of asking for a code that never came.
      // Only an explicit `false` triggers this: a missing field (e.g. an older
      // Edge Function during rollout) falls through to the normal code step.
      if (result.hasReservations === false) {
        setLookupError(t('booking.lookupNoReservations'));
        return;
      }

      lookupState.lookupId = result.lookupId || '';
      const phoneStep = document.querySelector('[data-lookup-phone-step]');
      const codeStep = document.querySelector('[data-lookup-code-step]');
      if (phoneStep) phoneStep.hidden = true;
      if (codeStep) codeStep.hidden = false;
      document.querySelector('[data-lookup-code]')?.focus();
    } catch {
      setLookupError(t('booking.lookupError'));
    } finally {
      if (button) button.disabled = false;
    }
  }

  function openManagedReservation(reservation) {
    const reservationId = reservation?.primaryReservationId || '';
    if (!reservationId || !lookupState.manageToken) {
      setLookupError(t('booking.lookupError'));
      return;
    }

    window.location.href = `gestionare.html?id=${encodeURIComponent(reservationId)}&manage=${
      encodeURIComponent(lookupState.manageToken)
    }`;
  }

  function renderLookupResults(reservations) {
    const results = document.querySelector('[data-lookup-results]');
    if (!results) return;

    results.innerHTML = '';
    results.hidden = false;

    if (!reservations.length) {
      const empty = document.createElement('p');
      empty.textContent = t('booking.lookupNoReservations');
      results.appendChild(empty);
      return;
    }

    if (reservations.length === 1) {
      openManagedReservation(reservations[0]);
      return;
    }

    const title = document.createElement('p');
    title.textContent = t('booking.lookupChooseReservation');
    results.appendChild(title);

    reservations.forEach((reservation) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'booking-lookup__result';
      button.textContent = `${formatDate(reservation.checkIn)} - ${formatDate(reservation.checkOut)} · ${
        pricing.formatMDL(reservation.totalPrice || 0)
      }`;
      button.addEventListener('click', () => openManagedReservation(reservation));
      results.appendChild(button);
    });
  }

  async function verifyReservationLookup() {
    const button = document.querySelector('[data-lookup-verify]');
    const codeInput = document.querySelector('[data-lookup-code]');
    const code = String(codeInput?.value || '').replace(/\D/g, '').slice(0, 4);

    if (!lookupState.lookupId || code.length !== 4) {
      setLookupError(t('booking.lookupCodeError'));
      codeInput?.focus();
      return;
    }

    if (button) button.disabled = true;
    const error = document.querySelector('[data-lookup-error]');
    if (error) error.hidden = true;

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const result = await supabaseHelpers.verifyReservationLookup(client, {
        lookupId: lookupState.lookupId,
        code,
      });
      lookupState.manageToken = result.manageToken || '';
      lookupState.reservations = Array.isArray(result.reservations) ? result.reservations : [];
      renderLookupResults(lookupState.reservations);
    } catch (error) {
      setLookupError(
        t(supabaseHelpers.isRateLimited?.(error) ? 'common.rateLimited' : 'booking.lookupCodeError'),
      );
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bindEvents() {
    document.querySelectorAll('[data-counter]').forEach((button) => {
      button.addEventListener('click', () => {
        updateCounter(button.dataset.counter, button.dataset.counterAction);
      });
    });

    document.querySelector('[data-calendar-prev]').addEventListener('click', () => {
      state.currentMonth = addMonths(state.currentMonth, -1);
      renderCalendar();
    });

    document.querySelector('[data-calendar-next]').addEventListener('click', () => {
      state.currentMonth = addMonths(state.currentMonth, 1);
      renderCalendar();
    });

    document.querySelector('[data-soldout-prev]').addEventListener('click', () => {
      const earliest = firstOfMonth(todayISO());
      const candidate = addMonths(state.soldoutMonth, -1);
      state.soldoutMonth = candidate < earliest ? earliest : candidate;
      renderSoldoutCalendar(state.activeSoldoutType);
    });

    document.querySelector('[data-soldout-next]').addEventListener('click', () => {
      state.soldoutMonth = addMonths(state.soldoutMonth, 1);
      renderSoldoutCalendar(state.activeSoldoutType);
    });

    document.querySelectorAll('[data-focus-calendar]').forEach((button) => {
      button.addEventListener('click', () => {
        openCalendar();
      });
    });

    document.querySelector('[data-calendar-clear]').addEventListener('click', clearCalendarDates);
    document.querySelector('[data-calendar-apply]').addEventListener('click', closeCalendar);

    TYPE_ORDER.forEach((type) => {
      const card = document.querySelector(`[data-stay-card="${type}"]`);
      card.addEventListener('click', (event) => {
        const target = event.target;
        if (target.closest('button, a, select, input, textarea')) {
          return;
        }

        openDetails(type);
      });
      card.addEventListener('keydown', (event) => {
        const target = event.target;
        if (
          target.closest('button, a, select, input, textarea') ||
          !['Enter', ' '].includes(event.key)
        ) {
          return;
        }

        event.preventDefault();
        openDetails(type);
      });
      card.querySelector('[data-card-room]').addEventListener('click', () => openRoomPanel(type));
      card.querySelector('[data-card-reserve]').addEventListener('click', () => {
        if (state.selectedType === type) {
          continueToCheckout();
        } else {
          selectType(type);
        }
      });
      card.querySelector('[data-card-soldout]').addEventListener('click', () => openSoldoutModal(type));
    });

    document.querySelector('[data-reservation-lookup-open]')?.addEventListener('click', openReservationLookup);
    document.querySelector('[data-lookup-start]')?.addEventListener('click', startReservationLookup);
    document.querySelector('[data-lookup-verify]')?.addEventListener('click', verifyReservationLookup);
    document.querySelector('[data-lookup-phone]')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') startReservationLookup();
    });
    document.querySelector('[data-lookup-code]')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') verifyReservationLookup();
    });
    document.querySelectorAll('[data-lookup-close]').forEach((button) => {
      button.addEventListener('click', closeAllModals);
    });

    document.querySelector('[data-booking-modal-reserve]').addEventListener('click', () => {
      const type = state.activeModalType;

      if (state.selectedType === type) {
        reserveType(type);
        return;
      }

      selectType(type);
      if (state.selectedType !== type) {
        showDetailsError(getPartyError() || t('booking.unavailableForParty'));
        return;
      }

      syncDetailsReserve(type);
    });

    document.querySelector('[data-child-age-confirm]').addEventListener('click', confirmChildAges);

    document.querySelector('[data-room-clear]').addEventListener('click', () => {
      if (state.activeRoomType) {
        state.selectedRoomNumbers[state.activeRoomType] = [];
        renderRoomNumbers(state.activeRoomType, getCardInfo(state.activeRoomType));
        renderCards();
      }
    });

    document.querySelectorAll('[data-modal-close], [data-room-panel-close], [data-soldout-close]').forEach((button) => {
      button.addEventListener('click', closeAllModals);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeCalendar();
        closeAllModals();
      }
    });

    document.addEventListener('click', (event) => {
      if (!state.calendarOpen || suppressCalendarClose) {
        return;
      }

      if (event.target.closest('[data-date-picker-shell]')) {
        return;
      }

      closeCalendar();
    });

    window.addEventListener('ecovila:languagechange', (event) => {
      state.language = event.detail.language;
      render();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    render();
    loadBookingData();
  });
})();
