(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmSidebar = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const CHILD_BUCKET_AGES = Object.freeze({
    '0-3': 3,
    '4-11': 4,
    '12+': 12,
  });
  // Full international number: non-zero country code + national part, 10–15 digits
  // after the "+". Staff local formats (069…, 69…) are coerced to +373 by
  // normalizeStaffPhone first; this floor still rejects a bare "+60843453".
  const INTERNATIONAL_PHONE_PATTERN = /^\+[1-9]\d{9,14}$/;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Mirrors the normalization in the public reservation Edge Function so staff
  // can type local Moldovan formats (069..., 69...) without the +373 prefix.
  function normalizeStaffPhone(value) {
    const compact = String(value || '').trim().replace(/[\s().-]/g, '');

    if (/^0\d{8}$/.test(compact)) {
      return `+373${compact.slice(1)}`;
    }

    if (/^\d{8}$/.test(compact)) {
      return `+373${compact}`;
    }

    if (/^373\d{8}$/.test(compact)) {
      return `+${compact}`;
    }

    return compact;
  }

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function qsa(selector, scope) {
    return Array.from((scope || root.document).querySelectorAll(selector));
  }

  function escapeHtml(value) {
    if (root.EcoVilaCrmCalendar?.escapeHtml) {
      return root.EcoVilaCrmCalendar.escapeHtml(value);
    }

    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  function readNumberList(value) {
    return String(value || '')
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((number) => Number.isInteger(number));
  }

  function uniqueRoomNumbers(roomNumbers) {
    return Array.from(new Set((roomNumbers || []).map((number) => Number(number)).filter(Number.isInteger)));
  }

  function splitFullName(value) {
    const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
      return { firstName: '', lastName: '' };
    }
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
    };
  }

  function bucketValuesToAges(values) {
    return (values || [])
      .map((value) => CHILD_BUCKET_AGES[value])
      .filter((age) => Number.isInteger(age));
  }

  function readChildBucketValues(form) {
    return qsa('[data-add-child-bucket]:checked', form).map((input) => input.value);
  }

  function selectedRoomsFromNumbers(rooms, roomNumbers) {
    const byNumber = new Map((rooms || []).map((room) => [Number(room.number), room]));
    return uniqueRoomNumbers(roomNumbers)
      .map((number) => byNumber.get(number))
      .filter(Boolean);
  }

  function areSelectedRoomsAvailable(input) {
    const roomNumbers = uniqueRoomNumbers(input.roomNumbers);
    const selectedRooms = selectedRoomsFromNumbers(input.rooms, roomNumbers);
    const calendar = root.EcoVilaCalendar;

    if (
      !calendar?.areRoomsAvailable ||
      !roomNumbers.length ||
      selectedRooms.length !== roomNumbers.length ||
      !input.checkIn ||
      !input.checkOut ||
      input.checkOut <= input.checkIn
    ) {
      return false;
    }

    return calendar.areRoomsAvailable({
      roomIds: selectedRooms.map((room) => room.id),
      reservations: input.reservations || [],
      checkIn: input.checkIn,
      checkOut: input.checkOut,
    });
  }

  function calculateStaffBillableGuests(rooms, party) {
    const pricing = root.EcoVilaPricing;
    const normalized = pricing.normalizeParty(party);
    const minimumAdults = (rooms || []).reduce((sum, room) => {
      return sum + Number(pricing.ROOM_TYPES[room.type]?.minimumAdults || 0);
    }, 0);
    const sortedChildAges = normalized.kidsAges
      .filter((age) => Number.isInteger(age) && age >= 1 && age <= 17)
      .slice()
      .sort((left, right) => right - left);
    const minimumAdultFeeChildren = Math.max(0, minimumAdults - normalized.adults);
    const adultFeeChildCount = Math.min(
      sortedChildAges.length,
      Math.max(normalized.teensAsAdults, minimumAdultFeeChildren),
    );
    const childFeeAges = sortedChildAges.slice(adultFeeChildCount);
    const kidsChargedAsAdults = adultFeeChildCount;
    const emptyAdultSlots = Math.max(0, minimumAdults - normalized.adults - kidsChargedAsAdults);

    return {
      actualAdults: normalized.adults,
      actualKids: normalized.kidsAges.length,
      freeKids: childFeeAges.filter((age) => age >= 1 && age <= 3).length,
      chargeableKids: normalized.chargeableKids,
      teensAsAdults: normalized.teensAsAdults,
      billableAdults: normalized.adults + kidsChargedAsAdults + emptyAdultSlots,
      billableKids: childFeeAges.filter((age) => age >= 4 && age <= 11).length,
      kidsChargedAsAdults,
      emptyAdultSlots,
      minimumAdults,
    };
  }

  function calculateStaffTotal(input) {
    const pricing = root.EcoVilaPricing;
    const roomNumbers = uniqueRoomNumbers(input.roomNumbers);
    const selectedRooms = selectedRoomsFromNumbers(input.rooms, roomNumbers);

    if (
      !pricing ||
      !roomNumbers.length ||
      selectedRooms.length !== roomNumbers.length ||
      !input.checkIn ||
      !input.checkOut ||
      input.checkOut <= input.checkIn
    ) {
      return { total: 0, nightlyBreakdown: [], selectedRooms };
    }

    const nights = pricing.enumerateNights(input.checkIn, input.checkOut);
    const nightsTier = pricing.getNightsTier(nights.length);
    const billable = calculateStaffBillableGuests(selectedRooms, {
      adults: input.adults,
      kidsAges: input.kidsAges || [],
    });
    const nightlyBreakdown = nights.map((date) => {
      const dayType = pricing.getDayType(date, input.holidays || []);
      const row = pricing.findPricingRow(input.pricingTiers || [], {
        nightsTier,
        dayType,
        stayDate: date,
      });
      const adultPrice = Number(row.adult_price);
      const kidPrice = Number(row.kid_price);
      const subtotal = billable.billableAdults * adultPrice + billable.billableKids * kidPrice;

      return {
        date,
        dayType,
        adultPrice,
        kidPrice,
        subtotal,
      };
    });

    return {
      selectedRooms,
      nights: nights.length,
      nightsTier,
      billable,
      nightlyBreakdown,
      total: nightlyBreakdown.reduce((sum, night) => sum + night.subtotal, 0),
    };
  }

  function splitTotalPrice(total, count) {
    const normalizedCount = Math.max(1, Number(count || 1));
    const normalizedTotal = Math.max(0, Math.round(Number(total || 0)));
    const base = Math.floor(normalizedTotal / normalizedCount);
    const remainder = normalizedTotal % normalizedCount;

    return Array.from({ length: normalizedCount }, (_, index) => base + (index < remainder ? 1 : 0));
  }

  function createBookingGroupId(options) {
    if (typeof options?.createGroupId === 'function') {
      return options.createGroupId();
    }

    if (root.crypto?.randomUUID) {
      return root.crypto.randomUUID();
    }

    return `staff-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function wireToggles() {
    root.document.querySelectorAll('[data-sidebar-toggle]').forEach((button) => {
      const target = button.dataset.sidebarToggle;
      const form = qs(target === 'add' ? '[data-add-reservation-form]' : '[data-search-reservation-form]');
      button.setAttribute('aria-expanded', String(Boolean(form && !form.hidden)));
      button.addEventListener('click', () => {
        if (form) {
          form.hidden = !form.hidden;
          button.setAttribute('aria-expanded', String(!form.hidden));
        }
      });
    });
  }

  function buildStaffReservationRows(form, rooms, context, options) {
    const roomNumbers = readNumberList(qs('[data-add-room-numbers]', form)?.value);
    const selectedRooms = selectedRoomsFromNumbers(rooms, roomNumbers);
    const bookingGroupId = createBookingGroupId(options);
    const childBucketValues = readChildBucketValues(form);
    const totalParts = splitTotalPrice(qs('[data-add-total]', form)?.dataset.total || 0, selectedRooms.length);
    const fullName = splitFullName(qs('[data-add-full-name]', form)?.value);

    return selectedRooms.map((room, index) => ({
      booking_group_id: bookingGroupId,
      room_id: room.id,
      guest_first_name: fullName.firstName || 'Client',
      guest_last_name: fullName.lastName,
      guest_phone: normalizeStaffPhone(qs('[data-add-phone]', form)?.value) || '',
      // Email is optional for staff bookings (walk-ins often have no email). Store
      // null when blank rather than a stand-in address — same stance as guest_phone.
      guest_email: qs('[data-add-email]', form)?.value?.trim() || null,
      check_in: qs('[data-add-check-in]', form)?.value,
      check_out: qs('[data-add-check-out]', form)?.value,
      adults: Number(qs('[data-add-adults]', form)?.value || 0),
      kids_ages: bucketValuesToAges(childBucketValues),
      total_price: totalParts[index] || 0,
      payment_type: 'office',
      payment_status: 'paid',
      paid_at: (options?.now || new Date()).toISOString(),
      room_explicitly_selected: true,
      conference_room: Boolean(qs('[data-add-conference]', form)?.checked),
      notes: qs('[data-add-notes]', form)?.value?.trim() || null,
      cash_expires_at: null,
      created_by: context.role,
    }));
  }

  function formatCalendarMonth(date) {
    const formatted = new Intl.DateTimeFormat('ro-MD', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }

  function firstOfMonth(date) {
    const pricing = root.EcoVilaPricing;
    const parsed = pricing.parseISODate(date);
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1)).toISOString().slice(0, 10);
  }

  function addMonths(date, amount) {
    const pricing = root.EcoVilaPricing;
    const parsed = pricing.parseISODate(date);
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + amount, 1))
      .toISOString()
      .slice(0, 10);
  }

  function todayISO() {
    return root.EcoVilaCrmCalendar?.todayISO?.() || new Date().toISOString().slice(0, 10);
  }

  function isClickInsideAddDatePicker(event) {
    return Boolean(
      event.composedPath?.().some((node) => {
        return node?.dataset && 'addDatePicker' in node.dataset;
      }) || event.target.closest?.('[data-add-date-picker]'),
    );
  }

  function getRoomNumbers(form) {
    return readNumberList(qs('[data-add-room-numbers]', form)?.value);
  }

  function getAddAvailabilityReservations(state) {
    return state.addReservations || state.reservations || [];
  }

  function hasCompleteChildBuckets(form, formState) {
    return Number(qs('[data-add-kids]', form)?.value || 0) === formState.childBuckets.length &&
      formState.childBuckets.every(Boolean);
  }

  function renderAddTotal(form, amount) {
    const total = qs('[data-add-total]', form);
    if (!total) {
      return;
    }

    total.dataset.total = String(Number(amount || 0));
    total.textContent = `Total: ${root.EcoVilaPricing.formatMDL(amount || 0)}`;
  }

  function renderAddDateSummary(context, form) {
    const checkIn = qs('[data-add-check-in]', form)?.value;
    const checkOut = qs('[data-add-check-out]', form)?.value;
    const checkInLabel = qs('[data-add-check-in-label]', form);
    const checkOutLabel = qs('[data-add-check-out-label]', form);

    if (checkInLabel) {
      checkInLabel.textContent = checkIn ? context.formatDate(checkIn) : '--';
    }
    if (checkOutLabel) {
      checkOutLabel.textContent = checkOut ? context.formatDate(checkOut) : '--';
    }
  }

  function quoteAddForm(context, state, form, formState) {
    const roomNumbers = getRoomNumbers(form);
    const checkIn = qs('[data-add-check-in]', form)?.value;
    const checkOut = qs('[data-add-check-out]', form)?.value;
    const kidsAges = bucketValuesToAges(formState.childBuckets);
    const adults = Number(qs('[data-add-adults]', form)?.value || 0);

    if (
      !hasCompleteChildBuckets(form, formState) ||
      !areSelectedRoomsAvailable({
        rooms: state.rooms || [],
        reservations: getAddAvailabilityReservations(state),
        roomNumbers,
        checkIn,
        checkOut,
      })
    ) {
      return { total: 0 };
    }

    try {
      return calculateStaffTotal({
        rooms: state.rooms || [],
        roomNumbers,
        adults,
        kidsAges,
        checkIn,
        checkOut,
        pricingTiers: state.pricingTiers || [],
        holidays: state.holidays || [],
      });
    } catch (error) {
      return { total: 0, error };
    }
  }

  function updateAddTotal(context, state, form, formState) {
    const quote = quoteAddForm(context, state, form, formState);
    renderAddTotal(form, quote.total);
    return quote;
  }

  function renderChildBuckets(context, state, form, formState) {
    const container = qs('[data-add-child-buckets]', form);
    if (!container) {
      return;
    }

    const count = Math.max(0, Number(qs('[data-add-kids]', form)?.value || 0));
    formState.childBuckets = formState.childBuckets.slice(0, count);
    while (formState.childBuckets.length < count) {
      formState.childBuckets.push('');
    }

    if (!count) {
      container.innerHTML = '<p class="crm-empty">Adaugă copii pentru a selecta intervalele de vârstă.</p>';
      updateAddTotal(context, state, form, formState);
      return;
    }

    container.innerHTML = formState.childBuckets.map((value, index) => `
      <div class="crm-child-bucket-row">
        <span>Copil ${index + 1}</span>
        <div class="crm-child-bucket-options">
          ${Object.keys(CHILD_BUCKET_AGES).map((bucket) => `
            <label class="crm-child-bucket-option">
              <input
                type="radio"
                name="add-child-bucket-${index}"
                value="${bucket}"
                data-add-child-bucket
                data-add-child-index="${index}"
                ${value === bucket ? 'checked' : ''}
              >
              <span>${bucket}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `).join('');

    qsa('[data-add-child-bucket]', container).forEach((input) => {
      input.addEventListener('change', () => {
        formState.childBuckets[Number(input.dataset.addChildIndex)] = input.value;
        updateAddTotal(context, state, form, formState);
      });
    });

    updateAddTotal(context, state, form, formState);
  }

  function isAddDateSelectable(state, form, formState, date) {
    const pricing = root.EcoVilaPricing;
    const checkIn = qs('[data-add-check-in]', form)?.value;
    const checkOut = qs('[data-add-check-out]', form)?.value;
    const roomNumbers = getRoomNumbers(form);

    if (date < todayISO()) {
      return false;
    }

    if (state.addAvailabilityEnd && date >= state.addAvailabilityEnd) {
      return false;
    }

    if (checkIn && !checkOut && date > checkIn) {
      return areSelectedRoomsAvailable({
        rooms: state.rooms || [],
        reservations: getAddAvailabilityReservations(state),
        roomNumbers,
        checkIn,
        checkOut: date,
      });
    }

    return areSelectedRoomsAvailable({
      rooms: state.rooms || [],
      reservations: getAddAvailabilityReservations(state),
      roomNumbers,
      checkIn: date,
      checkOut: pricing.addDays(date, 1),
    });
  }

  function renderAddCalendar(context, state, form, formState) {
    const pricing = root.EcoVilaPricing;
    const title = qs('[data-add-calendar-title]', form);
    const grid = qs('[data-add-calendar-grid]', form);
    const calendar = qs('[data-add-range-calendar]', form);
    if (!grid || !calendar) {
      return;
    }

    calendar.hidden = !formState.calendarOpen;
    if (title) {
      title.textContent = formatCalendarMonth(formState.currentMonth);
    }
    grid.innerHTML = '';

    const monthStart = pricing.parseISODate(formState.currentMonth);
    const mondayOffset = (monthStart.getUTCDay() + 6) % 7;
    const startDate = pricing.addDays(formState.currentMonth, -mondayOffset);
    const checkIn = qs('[data-add-check-in]', form)?.value;
    const checkOut = qs('[data-add-check-out]', form)?.value;

    for (let index = 0; index < 42; index += 1) {
      const date = pricing.addDays(startDate, index);
      const parsed = pricing.parseISODate(date);
      const button = root.document.createElement('button');
      const selectable = isAddDateSelectable(state, form, formState, date);
      button.type = 'button';
      button.textContent = String(parsed.getUTCDate());
      button.dataset.date = date;
      button.disabled = !selectable;
      button.classList.toggle('is-muted', parsed.getUTCMonth() !== monthStart.getUTCMonth());
      button.classList.toggle('is-unavailable', !selectable);
      button.classList.toggle('is-selected', date === checkIn || date === checkOut);
      button.classList.toggle('is-in-range', Boolean(checkIn && checkOut && date > checkIn && date < checkOut));
      button.addEventListener('click', () => selectAddDate(context, state, form, formState, date));
      grid.appendChild(button);
    }
  }

  function selectAddDate(context, state, form, formState, date) {
    const checkInInput = qs('[data-add-check-in]', form);
    const checkOutInput = qs('[data-add-check-out]', form);

    if (!checkInInput.value || checkOutInput.value || date <= checkInInput.value) {
      checkInInput.value = date;
      checkOutInput.value = '';
    } else {
      checkOutInput.value = date;
    }

    formState.calendarOpen = true;
    renderAddDateSummary(context, form);
    updateAddTotal(context, state, form, formState);
    renderAddCalendar(context, state, form, formState);
  }

  function clearInvalidCheckout(context, state, form, formState) {
    const checkIn = qs('[data-add-check-in]', form)?.value;
    const checkOutInput = qs('[data-add-check-out]', form);
    if (!checkIn || !checkOutInput?.value) {
      return;
    }

    if (!areSelectedRoomsAvailable({
      rooms: state.rooms || [],
      reservations: getAddAvailabilityReservations(state),
      roomNumbers: getRoomNumbers(form),
      checkIn,
      checkOut: checkOutInput.value,
    })) {
      checkOutInput.value = '';
      renderAddDateSummary(context, form);
    }
  }

  function initAddForm(context, state, form) {
    if (!form) {
      return null;
    }

    const formState = {
      childBuckets: [],
      calendarOpen: false,
      currentMonth: firstOfMonth(todayISO()),
    };

    renderChildBuckets(context, state, form, formState);
    renderAddDateSummary(context, form);
    renderAddTotal(form, 0);

    qs('[data-add-kids]', form)?.addEventListener('input', () => {
      renderChildBuckets(context, state, form, formState);
    });
    qs('[data-add-adults]', form)?.addEventListener('input', () => {
      updateAddTotal(context, state, form, formState);
    });
    qs('[data-add-room-numbers]', form)?.addEventListener('input', () => {
      clearInvalidCheckout(context, state, form, formState);
      updateAddTotal(context, state, form, formState);
      renderAddCalendar(context, state, form, formState);
    });
    qsa('[data-add-focus-calendar]', form).forEach((button) => {
      button.addEventListener('click', () => {
        formState.calendarOpen = true;
        renderAddCalendar(context, state, form, formState);
      });
    });
    qs('[data-add-calendar-prev]', form)?.addEventListener('click', () => {
      formState.currentMonth = addMonths(formState.currentMonth, -1);
      renderAddCalendar(context, state, form, formState);
    });
    qs('[data-add-calendar-next]', form)?.addEventListener('click', () => {
      formState.currentMonth = addMonths(formState.currentMonth, 1);
      renderAddCalendar(context, state, form, formState);
    });
    qs('[data-add-calendar-clear]', form)?.addEventListener('click', () => {
      qs('[data-add-check-in]', form).value = '';
      qs('[data-add-check-out]', form).value = '';
      renderAddDateSummary(context, form);
      updateAddTotal(context, state, form, formState);
      renderAddCalendar(context, state, form, formState);
    });
    qs('[data-add-calendar-apply]', form)?.addEventListener('click', () => {
      formState.calendarOpen = false;
      renderAddCalendar(context, state, form, formState);
    });
    root.document.addEventListener('click', (event) => {
      if (!formState.calendarOpen || isClickInsideAddDatePicker(event)) {
        return;
      }
      formState.calendarOpen = false;
      renderAddCalendar(context, state, form, formState);
    });

    return {
      formState,
      refresh() {
        clearInvalidCheckout(context, state, form, formState);
        renderChildBuckets(context, state, form, formState);
        renderAddDateSummary(context, form);
        renderAddCalendar(context, state, form, formState);
        updateAddTotal(context, state, form, formState);
      },
    };
  }

  function validateAddForm(state, form, formState) {
    const roomNumbers = getRoomNumbers(form);
    const uniqueNumbers = uniqueRoomNumbers(roomNumbers);
    const selectedRooms = selectedRoomsFromNumbers(state.rooms || [], uniqueNumbers);
    const kidsCount = Number(qs('[data-add-kids]', form)?.value || 0);
    const adults = Number(qs('[data-add-adults]', form)?.value || 0);
    const email = qs('[data-add-email]', form)?.value?.trim() || '';
    const checkIn = qs('[data-add-check-in]', form)?.value;
    const checkOut = qs('[data-add-check-out]', form)?.value;

    if (!uniqueNumbers.length) {
      return 'Alege cel puțin o cameră.';
    }
    if (selectedRooms.length !== uniqueNumbers.length || roomNumbers.length !== uniqueNumbers.length) {
      return 'Verifică numerele camerelor selectate.';
    }
    if (!Number.isInteger(adults) || adults < 1) {
      return 'Indică cel puțin un adult.';
    }
    if (kidsCount !== formState.childBuckets.length || !formState.childBuckets.every(Boolean)) {
      return 'Selectează intervalul de vârstă pentru fiecare copil.';
    }
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      return 'Alege check-in și check-out.';
    }
    if (!INTERNATIONAL_PHONE_PATTERN.test(normalizeStaffPhone(qs('[data-add-phone]', form)?.value))) {
      return 'Introdu un telefon valid în format internațional.';
    }
    if (email && !EMAIL_PATTERN.test(email)) {
      return 'Introdu un email valid sau lasă câmpul gol.';
    }
    if (!areSelectedRoomsAvailable({
      rooms: state.rooms || [],
      reservations: getAddAvailabilityReservations(state),
      roomNumbers,
      checkIn,
      checkOut,
    })) {
      return 'Camerele selectate nu sunt disponibile pentru perioada aleasă.';
    }
    if (Number(qs('[data-add-total]', form)?.dataset.total || 0) <= 0) {
      return 'Totalul nu a putut fi calculat pentru selecția curentă.';
    }

    return '';
  }

  function renderSearchResults(container, reservations, openReservation) {
    if (!container) {
      return;
    }

    if (!reservations?.length) {
      container.innerHTML = '<p class="crm-empty">Nu au fost găsite rezervări.</p>';
      return;
    }

    container.innerHTML = reservations.map((reservation) => {
      const room = escapeHtml(root.EcoVilaCrmCalendar.roomLabel(reservation));
      const name = escapeHtml(root.EcoVilaCrmCalendar.guestName(reservation));
      const reservationId = escapeHtml(reservation.id || '');
      const checkIn = escapeHtml(reservation.check_in || '');
      const checkOut = escapeHtml(reservation.check_out || '');
      const phone = escapeHtml(reservation.guest_phone || '');
      return `
        <button class="crm-search-card" type="button" data-result-id="${reservationId}">
          <strong>${name}</strong>
          <span>${room}</span>
          <span>${checkIn} - ${checkOut}</span>
          <span>${phone}</span>
        </button>
      `;
    }).join('');

    container.querySelectorAll('[data-result-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const reservation = reservations.find((item) => item.id === button.dataset.resultId);
        openReservation?.(reservation);
      });
    });
  }

  function init(context, state) {
    const helpers = root.EcoVilaSupabase;
    wireToggles();

    const addForm = qs('[data-add-reservation-form]');

    // A read-only dashboard (Angela) hides the "add reservation" tool entirely
    // and skips its wiring; server-side RLS also denies her reservation inserts.
    // The search form below stays available — it only reads.
    if (context.permissions?.dashboardReadOnly) {
      const addSection = addForm?.closest('.crm-sidebar-section');
      if (addSection) {
        addSection.hidden = true;
      }
    } else {
      const addController = initAddForm(context, state, addForm);
      state.refreshAddReservationForm = () => addController?.refresh?.();

      addForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const validationError = validateAddForm(state, addForm, addController.formState);
          if (validationError) {
            context.setAlert(validationError);
            return;
          }

          const rows = buildStaffReservationRows(addForm, state.rooms || [], context);
          await helpers.insertStaffReservations(context.client, rows);
          addForm.reset();
          addController.formState.childBuckets = [];
          addController.formState.calendarOpen = false;
          addController.formState.currentMonth = firstOfMonth(todayISO());
          addController.refresh();
          await state.reload?.();
        } catch (error) {
          // 23P01 = exclusion constraint (reservations_no_room_overlap): another
          // booking won the room between the local availability check and the
          // insert. Reload so the calendar reflects the conflict.
          if (error?.code === '23P01' || String(error?.message || '').includes('reservations_no_room_overlap')) {
            context.setAlert('Camerele selectate tocmai au fost rezervate pentru perioada aleasă. Calendarul a fost actualizat — verifică disponibilitatea.');
            await state.reload?.();
            return;
          }
          context.setAlert(error?.message || 'Rezervarea nu a putut fi adăugată.');
        }
      });
    }

    const searchForm = qs('[data-search-reservation-form]');
    searchForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const roomNumbers = readNumberList(qs('[data-search-room]', searchForm)?.value);
        const roomIds = selectedRoomsFromNumbers(state.rooms || [], roomNumbers).map((room) => room.id);
        const results = await helpers.searchReservations(context.client, {
          date: qs('[data-search-date]', searchForm)?.value,
          name: qs('[data-search-name]', searchForm)?.value?.trim(),
          phone: qs('[data-search-phone]', searchForm)?.value?.trim(),
          roomIds,
        });
        renderSearchResults(qs('[data-search-results]'), results, state.openReservation);
      } catch (error) {
        context.setAlert(error?.message || 'Căutarea nu a reușit.');
      }
    });
  }

  return {
    areSelectedRoomsAvailable,
    bucketValuesToAges,
    buildStaffReservationRows,
    calculateStaffBillableGuests,
    calculateStaffTotal,
    init,
    isClickInsideAddDatePicker,
    readNumberList,
    renderSearchResults,
    selectedRoomsFromNumbers,
    splitTotalPrice,
    validateAddForm,
  };
});
