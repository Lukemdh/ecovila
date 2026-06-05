(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmDaily = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const DAILY_STATUS_TABLE = 'crm_daily_statuses';
  const CHILD_BUCKET_AGES = Object.freeze({
    '0-3': 3,
    '4-11': 4,
    '12+': 12,
  });
  const CHECK_ICON = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;

  let activeDaily = null;

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function sortByRoomWithCompletedLast(cards) {
    return (cards || []).slice().sort((left, right) => {
      const completedDiff = Number(Boolean(left.completed)) - Number(Boolean(right.completed));
      if (completedDiff !== 0) {
        return completedDiff;
      }
      return root.EcoVilaCrmCalendar.roomNumber(left.reservation) - root.EcoVilaCrmCalendar.roomNumber(right.reservation);
    });
  }

  function statusFor(statuses, reservationId) {
    return statuses.find((status) => status.reservation_id === reservationId) || {};
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

  function bucketValueForAge(age) {
    const value = Number(age);
    if (value <= 3) {
      return '0-3';
    }
    if (value <= 11) {
      return '4-11';
    }
    return '12+';
  }

  function kidsAgesToBuckets(kidsAges) {
    return (Array.isArray(kidsAges) ? kidsAges : []).map(bucketValueForAge);
  }

  function bucketValuesToAges(values) {
    return (values || [])
      .map((value) => CHILD_BUCKET_AGES[value])
      .filter((age) => Number.isInteger(age));
  }

  function guestCount(reservation) {
    return Number(reservation.adults || 0) + (Array.isArray(reservation.kids_ages) ? reservation.kids_ages.length : 0);
  }

  function guestSummary(reservation) {
    const adults = Number(reservation.adults || 0);
    const kids = Array.isArray(reservation.kids_ages) ? reservation.kids_ages.length : 0;
    return `${adults} adulți · ${kids} copii`;
  }

  function normalizeSearchText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function isShortNumericQuery(query) {
    const compact = normalizeSearchText(query).replace(/\s/g, '');
    const digits = digitsOnly(query);
    return Boolean(digits && digits.length <= 2 && compact === digits);
  }

  function dailyReservationRoomNumber(reservation) {
    const calendar = root.EcoVilaCrmCalendar || {};
    return calendar.roomNumber
      ? calendar.roomNumber(reservation)
      : reservation.rooms?.number || '';
  }

  function dailyReservationSearchText(reservation) {
    const calendar = root.EcoVilaCrmCalendar || {};
    const roomNumber = dailyReservationRoomNumber(reservation);
    const roomLabel = calendar.roomLabel
      ? calendar.roomLabel(reservation)
      : `Camera ${roomNumber}`;
    const guestName = calendar.guestName
      ? calendar.guestName(reservation)
      : [reservation.guest_first_name, reservation.guest_last_name].filter(Boolean).join(' ');
    const formattedPhone = calendar.formatCalendarPhone
      ? calendar.formatCalendarPhone(reservation.guest_phone)
      : reservation.guest_phone || '';

    return [
      roomNumber,
      roomLabel,
      reservation.guest_first_name,
      reservation.guest_last_name,
      guestName,
      reservation.guest_phone,
      formattedPhone,
    ].filter(Boolean).join(' ');
  }

  function stripTrunkZero(digits) {
    return digits.startsWith('0') ? digits.slice(1) : digits;
  }

  function dailyTokenMatches(token, normalizedText, textDigits) {
    if (normalizedText.includes(token)) {
      return true;
    }
    const tokenDigits = digitsOnly(token);
    if (!tokenDigits) {
      return false;
    }
    return textDigits.includes(tokenDigits) || textDigits.includes(stripTrunkZero(tokenDigits));
  }

  function dailyReservationMatchesSearch(reservation, query) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      return true;
    }

    if (isShortNumericQuery(query)) {
      return String(dailyReservationRoomNumber(reservation)).startsWith(digitsOnly(query));
    }

    const searchText = dailyReservationSearchText(reservation);
    const normalizedText = normalizeSearchText(searchText);
    const textDigits = digitsOnly(searchText);
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

    return tokens.every((token) => dailyTokenMatches(token, normalizedText, textDigits));
  }

  function filterDailyReservations(reservations, query) {
    return (reservations || []).filter((reservation) => dailyReservationMatchesSearch(reservation, query));
  }

  function isConfirmedDailyReservation(reservation) {
    return Boolean(reservation && reservation.payment_status === 'paid' && !reservation.cancelled_at);
  }

  function groupReservations(reservations, reservation) {
    const groupId = reservation.booking_group_id;
    if (!groupId) {
      return [reservation];
    }

    const grouped = (reservations || []).filter((item) => item.booking_group_id === groupId);
    return grouped.length ? grouped : [reservation];
  }

  function groupTotal(reservations) {
    return (reservations || []).reduce((sum, item) => sum + Number(item.total_price || 0), 0);
  }

  function groupRooms(reservations) {
    const seen = new Set();
    return (reservations || [])
      .map((reservation) => reservation.rooms)
      .filter((room) => {
        if (!room?.id || seen.has(room.id)) {
          return false;
        }
        seen.add(room.id);
        return true;
      });
  }

  function addDays(date, amount) {
    if (root.EcoVilaCrmCalendar?.addDays) {
      return root.EcoVilaCrmCalendar.addDays(date, amount);
    }
    const parsed = new Date(`${date}T00:00:00Z`);
    parsed.setUTCDate(parsed.getUTCDate() + Number(amount || 0));
    return parsed.toISOString().slice(0, 10);
  }

  function normalizeExtraDays(value) {
    return Math.min(365, Math.max(0, Math.round(Number(value || 0))));
  }

  function isActiveReservation(reservation) {
    if (!reservation || reservation.cancelled_at || reservation.payment_status === 'cancelled') {
      return false;
    }
    return !reservation.payment_status || ['pending', 'paid'].includes(reservation.payment_status);
  }

  function checkDailyExtensionAvailability(input) {
    const reservation = input.reservation;
    const group = input.group || groupReservations(input.reservations, reservation);
    const checkIn = reservation?.check_out;
    const checkOut = input.checkOut;
    if (!reservation || !checkIn || !checkOut || checkOut <= checkIn) {
      return { available: true, conflict: null };
    }

    const groupReservationIds = new Set(group.map((item) => item.id).filter(Boolean));
    const groupId = reservation.booking_group_id;
    const roomIds = new Set(group.map((item) => item.room_id).filter(Boolean));
    const conflict = (input.reservations || []).find((item) => {
      return (
        isActiveReservation(item) &&
        roomIds.has(item.room_id) &&
        !groupReservationIds.has(item.id) &&
        (!groupId || item.booking_group_id !== groupId) &&
        item.check_in < checkOut &&
        checkIn < item.check_out
      );
    }) || null;

    return {
      available: !conflict,
      conflict,
    };
  }

  function towelCardsFor(reservation, type) {
    const cards = Number(reservation.towel_cards_issued);
    if (type === 'out' && Number.isFinite(cards) && cards > 0) {
      return cards;
    }
    return guestCount(reservation);
  }

  function towelCardLine(reservation, type) {
    const prefix = type === 'in' ? 'De eliberat' : 'De primit';
    return `${prefix}: ${towelCardsFor(reservation, type)} cartele`;
  }

  function calculateDailySupplement(input) {
    const reservation = input.reservation;
    const group = groupReservations(input.reservations, reservation);
    const kidsAges = bucketValuesToAges(input.childBuckets);
    const adults = Math.max(0, Number(input.adults || 0));
    const extraDays = normalizeExtraDays(input.extraDays);
    const existingTotal = groupTotal(group);
    const rooms = groupRooms(group);
    const checkOut = addDays(reservation.check_out, extraDays);
    const sidebar = root.EcoVilaCrmSidebar;
    const quote = sidebar?.calculateStaffTotal && rooms.length
      ? sidebar.calculateStaffTotal({
        rooms,
        roomNumbers: rooms.map((room) => Number(room.number)),
        adults,
        kidsAges,
        checkIn: reservation.check_in,
        checkOut,
        pricingTiers: input.pricingTiers || [],
        holidays: input.holidays || [],
        createdOn: reservation.created_at ? String(reservation.created_at).slice(0, 10) : reservation.check_in,
      })
      : { total: existingTotal };
    const quotedTotal = Math.max(0, Math.round(Number(quote.total || 0)));
    const balance = quotedTotal - existingTotal;
    const supplement = Math.max(0, balance);
    const reimbursement = Math.max(0, -balance);

    return {
      adults,
      balance,
      checkOut,
      existingTotal,
      extraDays,
      group,
      kidsAges,
      quotedTotal,
      reservation,
      reimbursement,
      supplement,
      total: quotedTotal,
    };
  }

  function syncDateControl(context, state) {
    const label = qs('[data-daily-date-label]') || qs('[data-daily-date-button]');
    const input = qs('[data-daily-date]');
    if (label) {
      label.textContent = context.formatDate(state.selectedDate);
    }
    if (input) {
      input.value = state.selectedDate;
    }
  }

  function dailyActionLabel(type) {
    return type === 'in' ? 'Marchează cazarea' : 'Marchează plecarea';
  }

  function buildDailyCard(context, state, reservation, type, status) {
    const card = root.document.createElement('article');
    const completed = type === 'in' ? Boolean(status.checked_in_at) : Boolean(status.checked_out_at);
    const group = groupReservations(state.reservations, reservation);
    const phone = root.EcoVilaCrmCalendar.formatCalendarPhone
      ? root.EcoVilaCrmCalendar.formatCalendarPhone(reservation.guest_phone)
      : reservation.guest_phone || '';
    const roomLabel = escapeHtml(root.EcoVilaCrmCalendar.roomLabel(reservation));
    const guestName = escapeHtml(root.EcoVilaCrmCalendar.guestName(reservation));
    const phoneLabel = escapeHtml(phone);
    card.className = [
      'crm-daily-card',
      `crm-daily-card--${type}`,
      completed ? 'is-complete' : '',
    ].filter(Boolean).join(' ');
    card.innerHTML = `
      <div class="crm-daily-card__details">
        <span class="crm-daily-card__room">${roomLabel}</span>
        <strong>${guestName}</strong>
        <span>${phoneLabel}</span>
        <span>${guestSummary(reservation)}</span>
        <span>Achitat: ${context.formatMDL(groupTotal(group))}</span>
        <span class="crm-daily-card__towels">${towelCardLine(reservation, type)}</span>
      </div>
    `;
    card.addEventListener('click', () => openDailyGuestEditor(context, state, reservation));

    if (!completed) {
      const button = root.document.createElement('button');
      button.type = 'button';
      button.className = 'crm-daily-check';
      button.setAttribute('aria-label', dailyActionLabel(type));
      button.title = dailyActionLabel(type);
      button.innerHTML = CHECK_ICON;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (type === 'out') {
          openCheckoutNote(context, state, reservation);
        } else {
          saveCheckIn(context, state, reservation);
        }
      });
      card.appendChild(button);
    }

    return card;
  }

  function emptyState(context, state, type) {
    if (state.dailySearchQuery) {
      return `
        <div class="crm-daily-empty">
          <strong>Nu există rezultate pentru căutarea curentă.</strong>
          <span>Încearcă numărul camerei, numele clientului sau telefonul.</span>
        </div>
      `;
    }

    const selectedIsToday = state.selectedDate === root.EcoVilaCrmCalendar.todayISO();
    const dateLabel = selectedIsToday ? 'de astăzi' : `din ${context.formatDate(state.selectedDate)}`;
    const body = type === 'in'
      ? `Toate cazările ${dateLabel} vor apărea aici.`
      : `Toate plecările ${dateLabel} vor apărea aici.`;

    return `
      <div class="crm-daily-empty">
        <svg class="crm-daily-empty__art" viewBox="0 0 220 160" aria-hidden="true">
          <circle cx="111" cy="76" r="62"></circle>
          <path d="M45 126h130"></path>
          <path d="M118 125V42h55v83"></path>
          <path d="M126 50h39v75"></path>
          <path d="M59 124V76c0-8 6-14 14-14h30c8 0 14 6 14 14v49"></path>
          <path d="M72 124V82"></path>
          <path d="M101 124V82"></path>
          <path d="M71 62V49c0-6 5-11 11-11h10c6 0 11 5 11 11v13"></path>
          <path d="M139 86h4"></path>
          <path d="M184 125V92"></path>
          <path d="M184 103c18-5 22-20 22-20-18 2-22 20-22 20Z"></path>
          <path d="M184 113c-17-6-25-20-25-20 18 0 25 20 25 20Z"></path>
        </svg>
        <strong>Nu sunt rezervări pentru această secțiune.</strong>
        <span>${body}</span>
      </div>
    `;
  }

  async function saveDailyStatus(context, state, reservation, values) {
    await root.EcoVilaSupabase.upsertDailyStatus(context.client, {
      reservation_id: reservation.id,
      service_date: state.selectedDate,
      updated_by: context.session.user.id,
      updated_at: new Date().toISOString(),
      ...values,
    });
    await loadDaily(context, state);
  }

  async function saveIssuedTowelCards(context, state, reservation, cards) {
    const group = groupReservations(state.reservations, reservation);
    await Promise.all(group.map((item) => root.EcoVilaSupabase.updateReservation(context.client, item.id, {
      towel_cards_issued: cards,
    })));
  }

  async function saveCheckIn(context, state, reservation) {
    await saveIssuedTowelCards(context, state, reservation, guestCount(reservation));
    await saveDailyStatus(context, state, reservation, { checked_in_at: new Date().toISOString() });
  }

  function renderDailyChildBuckets(context, state) {
    const editor = state.editor;
    const form = qs('[data-daily-guest-form]');
    const container = qs('[data-daily-edit-child-buckets]');
    const kidsInput = qs('[data-daily-edit-kids]');
    if (!editor || !form || !container || !kidsInput) {
      return;
    }

    const count = Math.max(0, Number(kidsInput.value || 0));
    editor.childBuckets = editor.childBuckets.slice(0, count);
    while (editor.childBuckets.length < count) {
      editor.childBuckets.push('4-11');
    }

    if (!count) {
      container.innerHTML = '<p class="crm-empty">Nu sunt copii în rezervare.</p>';
      updateDailySupplement(context, state);
      return;
    }

    container.innerHTML = editor.childBuckets.map((value, index) => `
      <div class="crm-child-bucket-row">
        <span>Copil ${index + 1}</span>
        <div class="crm-child-bucket-options">
          ${Object.keys(CHILD_BUCKET_AGES).map((bucket) => `
            <label class="crm-child-bucket-option">
              <input
                type="radio"
                name="daily-child-bucket-${index}"
                value="${bucket}"
                data-daily-child-bucket
                data-daily-child-index="${index}"
                ${value === bucket ? 'checked' : ''}
              >
              <span>${bucket}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-daily-child-bucket]').forEach((input) => {
      input.addEventListener('change', () => {
        editor.childBuckets[Number(input.dataset.dailyChildIndex)] = input.value;
        updateDailySupplement(context, state);
      });
    });

    updateDailySupplement(context, state);
  }

  function updateDailySupplement(context, state) {
    const editor = state.editor;
    const adultsInput = qs('[data-daily-edit-adults]');
    const extraDaysInput = qs('[data-daily-edit-extra-days]');
    const newCheckOut = qs('[data-daily-edit-new-check-out]');
    const availability = qs('[data-daily-edit-availability]');
    const supplement = qs('[data-daily-edit-supplement]');
    const currentTotal = qs('[data-daily-edit-current-total]');
    if (!editor || !adultsInput || !supplement) {
      return null;
    }

    const quote = calculateDailySupplement({
      reservations: state.reservations,
      reservation: editor.reservation,
      adults: adultsInput.value,
      childBuckets: editor.childBuckets,
      extraDays: extraDaysInput?.value || 0,
      pricingTiers: state.pricingTiers,
      holidays: state.holidays,
    });
    editor.quote = quote;
    if (extraDaysInput && Number(extraDaysInput.value || 0) !== quote.extraDays) {
      extraDaysInput.value = String(quote.extraDays);
    }
    if (newCheckOut) {
      newCheckOut.value = quote.checkOut;
    }
    if (availability) {
      availability.textContent = quote.extraDays > 0
        ? 'Disponibilitatea pentru zilele extra se verifică la salvare.'
        : 'Fără zile extra.';
    }
    if (currentTotal) {
      currentTotal.textContent = `Achitat: ${context.formatMDL(quote.existingTotal)}`;
    }
    supplement.textContent = quote.reimbursement > 0
      ? `De rambursat: ${context.formatMDL(quote.reimbursement)}`
      : `De încasat suplimentar: ${context.formatMDL(quote.supplement)}`;
    return quote;
  }

  async function fetchDailyExtensionReservations(context, quote) {
    if (!quote?.extraDays || !root.EcoVilaSupabase?.fetchAdminReservations) {
      return [];
    }
    return root.EcoVilaSupabase.fetchAdminReservations(context.client, {
      startDate: quote.reservation?.check_out || quote.group?.[0]?.check_out || '',
      endDate: quote.checkOut,
    });
  }

  async function saveDailyGuestEdit(context, state) {
    const editor = state.editor;
    const quote = updateDailySupplement(context, state);
    if (!editor || !quote) {
      return;
    }

    const extensionReservations = await fetchDailyExtensionReservations(context, quote);
    const availability = checkDailyExtensionAvailability({
      reservations: extensionReservations,
      group: quote.group,
      reservation: editor.reservation,
      checkOut: quote.checkOut,
    });
    if (!availability.available) {
      throw new Error('Camerele nu sunt disponibile pentru zilele extra selectate.');
    }

    const cards = quote.adults + quote.kidsAges.length;
    const split = root.EcoVilaCrmSidebar?.splitTotalPrice
      ? root.EcoVilaCrmSidebar.splitTotalPrice(quote.total, quote.group.length)
      : [quote.total];
    await Promise.all(quote.group.map((reservation, index) => root.EcoVilaSupabase.updateReservation(context.client, reservation.id, {
      adults: quote.adults,
      check_out: quote.checkOut,
      kids_ages: quote.kidsAges,
      total_price: split[index] || 0,
      towel_cards_issued: cards,
    })));
    await loadDaily(context, state);
  }

  function openDailyGuestEditor(context, state, reservation) {
    const dialog = qs('[data-daily-guest-dialog]');
    const form = qs('[data-daily-guest-form]');
    const room = qs('[data-daily-edit-room]');
    const adults = qs('[data-daily-edit-adults]');
    const kids = qs('[data-daily-edit-kids]');
    const extraDays = qs('[data-daily-edit-extra-days]');
    const newCheckOut = qs('[data-daily-edit-new-check-out]');
    if (!dialog || !form || !adults || !kids) {
      return;
    }

    state.editor = {
      reservation,
      childBuckets: kidsAgesToBuckets(reservation.kids_ages),
      quote: null,
    };
    adults.value = String(Number(reservation.adults || 0));
    kids.value = String(state.editor.childBuckets.length);
    if (extraDays) {
      extraDays.value = '0';
    }
    if (newCheckOut) {
      newCheckOut.value = reservation.check_out;
    }
    if (room) {
      room.textContent = root.EcoVilaCrmCalendar.roomLabel(reservation);
    }

    form.oninput = (event) => {
      if (event.target === kids) {
        renderDailyChildBuckets(context, state);
        return;
      }
      updateDailySupplement(context, state);
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (event.submitter?.value !== 'save') {
        dialog.close?.('cancel');
        return;
      }
      try {
        await saveDailyGuestEdit(context, state);
        dialog.close?.('save');
      } catch (error) {
        context.setAlert(error?.message || 'Oaspeții nu au putut fi actualizați.');
      }
    };

    renderDailyChildBuckets(context, state);
    dialog.showModal?.();
  }

  function openCheckoutNote(context, state, reservation) {
    const dialog = qs('[data-checkout-note-dialog]');
    const form = qs('[data-checkout-note-form]');
    const note = qs('[data-checkout-note]');
    if (!dialog || !form || !note) {
      saveDailyStatus(context, state, reservation, { checked_out_at: new Date().toISOString() });
      return;
    }

    note.value = '';
    form.onsubmit = (event) => {
      event.preventDefault();
      dialog.close();
      saveDailyStatus(context, state, reservation, {
        checked_out_at: new Date().toISOString(),
        checkout_note: note.value.trim() || null,
      });
    };
    dialog.showModal?.();
  }

  function renderSection(context, state, container, reservations, statuses, type) {
    const visibleReservations = filterDailyReservations(reservations, state.dailySearchQuery);
    const cards = visibleReservations.map((reservation) => {
      const status = statusFor(statuses, reservation.id);
      return {
        reservation,
        status,
        completed: type === 'in' ? Boolean(status.checked_in_at) : Boolean(status.checked_out_at),
      };
    });

    const sorted = sortByRoomWithCompletedLast(cards);
    container.innerHTML = '';
    container.className = `crm-daily-list ${sorted.length ? '' : 'is-empty'}`.trim();

    if (!sorted.length) {
      container.innerHTML = emptyState(context, state, type);
      return;
    }

    sorted.forEach((item) => {
      container.appendChild(buildDailyCard(context, state, item.reservation, type, item.status));
    });
  }

  function renderDailySections(context, state) {
    renderSection(context, state, qs('[data-check-ins]'), state.checkIns, state.statuses, 'in');
    renderSection(context, state, qs('[data-check-outs]'), state.checkOuts, state.statuses, 'out');
  }

  async function loadDaily(context, state) {
    syncDateControl(context, state);
    const nextDay = root.EcoVilaCrmCalendar.addDays(state.selectedDate, 1);
    const previousDay = root.EcoVilaCrmCalendar.addDays(state.selectedDate, -1);
    const [reservations, pricingTiers, holidays] = await Promise.all([
      root.EcoVilaSupabase.fetchAdminReservations(context.client, {
        startDate: previousDay,
        endDate: nextDay,
      }),
      root.EcoVilaSupabase.fetchPricingTiers(context.client),
      root.EcoVilaSupabase.fetchHolidays(context.client),
    ]);
    state.reservations = reservations;
    state.pricingTiers = pricingTiers;
    state.holidays = holidays;
    const confirmedReservations = reservations.filter(isConfirmedDailyReservation);
    const checkIns = confirmedReservations.filter((reservation) => reservation.check_in === state.selectedDate);
    const checkOuts = confirmedReservations.filter((reservation) => reservation.check_out === state.selectedDate);
    const ids = [...checkIns, ...checkOuts].map((reservation) => reservation.id);
    const statuses = await root.EcoVilaSupabase.fetchDailyStatuses(context.client, state.selectedDate, ids);

    state.checkIns = checkIns;
    state.checkOuts = checkOuts;
    state.statuses = statuses;
    renderDailySections(context, state);
  }

  function setSelectedDate(context, state, date) {
    state.selectedDate = root.EcoVilaCrmCalendar.toISODate(date);
    syncDateControl(context, state);
  }

  function showToday() {
    if (!activeDaily) {
      return null;
    }

    const { context, state } = activeDaily;
    setSelectedDate(context, state, root.EcoVilaCrmCalendar.todayISO());
    return loadDaily(context, state).catch((error) => {
      context.setAlert(error?.message || 'Situația zilnică nu s-a putut încărca.');
    });
  }

  function init(context) {
    const state = {
      selectedDate: root.EcoVilaCrmCalendar.todayISO(),
      reservations: [],
      checkIns: [],
      checkOuts: [],
      statuses: [],
      pricingTiers: [],
      holidays: [],
      editor: null,
      dailySearchQuery: '',
    };
    activeDaily = { context, state };

    const dateInput = qs('[data-daily-date]');
    const searchForm = qs('[data-daily-search-form]');
    const searchInput = qs('[data-daily-search]');
    const searchToggle = qs('[data-daily-search-toggle]');
    const syncSearchState = () => {
      state.dailySearchQuery = searchInput?.value || '';
      searchForm?.classList.toggle('has-value', Boolean(state.dailySearchQuery.trim()));
    };

    searchForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      searchInput?.focus();
    });
    searchToggle?.addEventListener('click', () => {
      searchInput?.focus();
    });
    searchInput?.addEventListener('input', () => {
      syncSearchState();
      renderDailySections(context, state);
    });
    searchInput?.addEventListener('blur', syncSearchState);

    dateInput?.addEventListener('change', () => {
      setSelectedDate(context, state, dateInput.value || state.selectedDate);
      loadDaily(context, state);
    });
    qs('[data-daily-prev]')?.addEventListener('click', () => {
      setSelectedDate(context, state, root.EcoVilaCrmCalendar.addDays(state.selectedDate, -1));
      loadDaily(context, state);
    });
    qs('[data-daily-next]')?.addEventListener('click', () => {
      setSelectedDate(context, state, root.EcoVilaCrmCalendar.addDays(state.selectedDate, 1));
      loadDaily(context, state);
    });

    loadDaily(context, state).catch((error) => context.setAlert(error?.message || 'Situația zilnică nu s-a putut încărca.'));
  }

  return {
    bucketValuesToAges,
    calculateDailySupplement,
    checkDailyExtensionAvailability,
    DAILY_STATUS_TABLE,
    dailyReservationMatchesSearch,
    filterDailyReservations,
    init,
    kidsAgesToBuckets,
    loadDaily,
    saveDailyStatus,
    showToday,
    sortByRoomWithCompletedLast,
  };
});
