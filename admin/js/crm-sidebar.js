(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmSidebar = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const CHILD_BUCKET_AGES = Object.freeze({
    '0-2': 2,
    '3-11': 3,
    '12+': 12,
  });
  // Temporary holds (ADR-100): staff block a villa while a cheque or transfer
  // clears. The DB snaps the deadline to one of these three from server now()
  // (enforce_temporary_hold_expiry), so a wrong laptop clock cannot stretch or
  // pre-expire a hold.
  const HOLD_DURATIONS = Object.freeze([1, 3, 8]);
  const DEFAULT_HOLD_HOURS = 3;
  const ROOM_GROUP_LABELS = Object.freeze({
    small: 'Mici',
    large: 'Mari',
    hotel: 'Hotel',
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
      // Drop blank segments before Number(): an empty field would otherwise read
      // as Number('') === 0 and pass the integer check as villa "0".
      .map((item) => item.trim())
      .filter(Boolean)
      .map(Number)
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

  // The picker always shows the full inventory (1-25) so a villa never silently
  // vanishes from the grid: fetchRooms() only returns ACTIVE rooms, so a number
  // missing from the DB payload renders as "inactive" rather than shifting every
  // square after it. Numbers and grouping come from the shared pricing model.
  function roomGroupDefinitions() {
    const pricing = root.EcoVilaPricing;
    return Object.keys(ROOM_GROUP_LABELS).map((type) => ({
      type,
      label: ROOM_GROUP_LABELS[type],
      numbers: Array.from(pricing.ROOM_TYPES[type].roomNumbers).map(Number),
    }));
  }

  // One pass over the availability window builds a room -> stays index, so the
  // 42 calendar cells and the 25 room squares each cost a handful of string
  // comparisons instead of re-scanning ~2 years of reservations every render.
  function buildRoomOccupancyIndex(reservations) {
    const isActive = root.EcoVilaCalendar?.isActiveReservation;
    const index = new Map();

    (reservations || []).forEach((reservation) => {
      if (!reservation?.room_id || (isActive && !isActive(reservation))) {
        return;
      }

      const stays = index.get(reservation.room_id) || [];
      stays.push([reservation.check_in, reservation.check_out]);
      index.set(reservation.room_id, stays);
    });

    return index;
  }

  // ISO dates sort lexicographically, so the half-open [check-in, check-out)
  // overlap test is two string comparisons — no Date parsing per cell.
  function isRoomFreeInIndex(index, roomId, checkIn, checkOut) {
    const stays = index?.get?.(roomId);
    if (!stays) {
      return true;
    }

    return !stays.some(([start, end]) => start < checkOut && checkIn < end);
  }

  function hasCompleteRange(checkIn, checkOut) {
    return Boolean(checkIn && checkOut && checkOut > checkIn);
  }

  // Availability is only loaded for ADD_RESERVATION_LOOKAHEAD_DAYS. Staff may
  // still book past that horizon (ADR-086 removed the advance-booking wall), but
  // the grid must not claim a villa is free when nothing was fetched for those
  // dates — it says "unverified" instead and lets the DB exclusion constraint
  // arbitrate on insert.
  function isBeyondAvailabilityHorizon(checkOut, horizonEnd) {
    return Boolean(horizonEnd && checkOut && checkOut > horizonEnd);
  }

  function buildRoomPickerModel(input) {
    const rooms = input.rooms || [];
    const byNumber = new Map(rooms.map((room) => [Number(room.number), room]));
    // Before the first dashboard load there is no inventory yet. "Not known
    // yet" is not "deactivated", so the grid waits rather than flashing 25
    // struck-out villas.
    const inventoryLoaded = rooms.length > 0;
    const index = input.index || buildRoomOccupancyIndex(input.reservations || []);
    const selected = new Set(uniqueRoomNumbers(input.selectedNumbers));
    const ranged = hasCompleteRange(input.checkIn, input.checkOut);
    const unverified = ranged && isBeyondAvailabilityHorizon(input.checkOut, input.horizonEnd);

    let freeCount = 0;
    const groups = roomGroupDefinitions().map((group) => {
      let groupFree = 0;
      const squares = group.numbers.map((number) => {
        const room = byNumber.get(number);
        const free = Boolean(room) && ranged &&
          (unverified || isRoomFreeInIndex(index, room.id, input.checkIn, input.checkOut));

        if (free) {
          groupFree += 1;
        }

        let state = 'available';
        if (!room) {
          state = inventoryLoaded ? 'inactive' : 'standby';
        } else if (!ranged) {
          state = 'standby';
        } else if (!free) {
          state = 'occupied';
        } else if (selected.has(number)) {
          state = 'selected';
        }

        return { number, roomId: room?.id || '', state };
      });

      freeCount += groupFree;

      return {
        type: group.type,
        label: group.label,
        squares,
        freeCount: groupFree,
        totalCount: group.numbers.length,
      };
    });

    return {
      groups,
      ranged,
      unverified,
      freeCount,
      totalCount: groups.reduce((sum, group) => sum + group.totalCount, 0),
      selectedNumbers: uniqueRoomNumbers(input.selectedNumbers),
    };
  }

  // A room selected earlier can be taken by someone else (or deactivated) before
  // the form is submitted — a realtime reload then reconciles the selection
  // instead of silently keeping a number that can no longer be booked.
  function reconcileSelectedRooms(model) {
    // Without a stay, availability is unknown rather than false — dropping the
    // selection here would announce "villa 3 is taken" the moment staff clear
    // the dates to pick a different period.
    if (!model.ranged) {
      return { kept: model.selectedNumbers, dropped: [] };
    }

    const selectable = new Set();
    model.groups.forEach((group) => {
      group.squares.forEach((square) => {
        if (square.state === 'available' || square.state === 'selected') {
          selectable.add(square.number);
        }
      });
    });

    const kept = [];
    const dropped = [];
    model.selectedNumbers.forEach((number) => {
      (selectable.has(number) ? kept : dropped).push(number);
    });

    return { kept, dropped };
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
      freeKids: childFeeAges.filter((age) => age >= 1 && age <= 2).length,
      chargeableKids: normalized.chargeableKids,
      teensAsAdults: normalized.teensAsAdults,
      billableAdults: normalized.adults + kidsChargedAsAdults + emptyAdultSlots,
      billableKids: childFeeAges.filter((age) => age >= 3 && age <= 11).length,
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

  function readHoldState(form) {
    const enabled = Boolean(qs('[data-add-hold-toggle]', form)?.checked);
    const selected = qsa('[data-add-hold-hours]', form).find((input) => input.checked);
    const hours = Number(selected?.value || 0);

    return {
      enabled,
      hours: HOLD_DURATIONS.includes(hours) ? hours : DEFAULT_HOLD_HOURS,
    };
  }

  function holdExpiresAt(hours, now) {
    return new Date((now || new Date()).getTime() + hours * 60 * 60 * 1000);
  }

  function chisinauParts(date) {
    return {
      day: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Chisinau' }).format(date),
      time: new Intl.DateTimeFormat('ro-MD', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Europe/Chisinau',
      }).format(date),
    };
  }

  // "Expiră azi la 17:40" / "Expiră mâine la 02:10" — always the resort's clock,
  // so a staff laptop set to another timezone still reads the right hour.
  function formatHoldExpiry(expiresAt, now) {
    const pricing = root.EcoVilaPricing;
    const expiry = chisinauParts(expiresAt);
    const today = chisinauParts(now || new Date()).day;

    if (expiry.day === today) {
      return `Expiră azi la ${expiry.time}`;
    }

    if (pricing?.addDays && expiry.day === pricing.addDays(today, 1)) {
      return `Expiră mâine la ${expiry.time}`;
    }

    return `Expiră la ${expiry.time}`;
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
    const now = options?.now || new Date();
    // A temporary hold is this same row, unpaid and with a deadline: pending keeps
    // the villa inside the no-overlap exclusion constraint, and paid_at MUST stay
    // null so an expired hold never reaches the finance cancellation report. The
    // deadline sent below is only a duration hint — the DB restamps it from server
    // time on insert (enforce_temporary_hold_expiry).
    const hold = readHoldState(form);

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
      payment_status: hold.enabled ? 'pending' : 'paid',
      paid_at: hold.enabled ? null : now.toISOString(),
      room_explicitly_selected: true,
      conference_room: Boolean(qs('[data-add-conference]', form)?.checked),
      notes: qs('[data-add-notes]', form)?.value?.trim() || null,
      cash_expires_at: hold.enabled ? holdExpiresAt(hold.hours, now).toISOString() : null,
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

  // A room square clicked before the dates exist opens the range picker. That
  // click then bubbles to the close-on-outside-click listener, which would
  // count it as "outside" and shut the picker in the same tick — so the
  // listener has to recognise it, exactly like a click inside the picker.
  function isClickOnRoomSquare(event) {
    return Boolean(
      event.composedPath?.().some((node) => {
        return node?.dataset && 'addRoom' in node.dataset;
      }) || event.target.closest?.('[data-add-room]'),
    );
  }

  function getRoomNumbers(form) {
    return readNumberList(qs('[data-add-room-numbers]', form)?.value);
  }

  // The grid writes through this hidden field, so every existing reader
  // (validation, pricing, row building, the tests) keeps its single source of
  // truth. Setting .value programmatically fires no 'input' event, so callers
  // re-render and re-total explicitly.
  function setRoomNumbers(form, numbers) {
    const input = qs('[data-add-room-numbers]', form);
    if (input) {
      input.value = uniqueRoomNumbers(numbers).sort((left, right) => left - right).join(', ');
    }
  }

  // form.reset() does NOT clear <input type="hidden">: hidden inputs use the
  // "default" value mode, where setting .value writes the content attribute, so
  // the value IS its own default. The stay and the villa selection therefore
  // have to be cleared by hand after a booking is saved.
  function clearAddFormSelection(form) {
    const checkIn = qs('[data-add-check-in]', form);
    const checkOut = qs('[data-add-check-out]', form);
    if (checkIn) {
      checkIn.value = '';
    }
    if (checkOut) {
      checkOut.value = '';
    }
    setRoomNumbers(form, []);
  }

  function getAddAvailabilityReservations(state) {
    return state.addReservations || state.reservations || [];
  }

  function activeRooms(state) {
    return (state.rooms || []).filter((room) => room.is_active !== false);
  }

  // Rebuilt only when the dashboard swaps in a fresh reservations array, so
  // month paging and typing reuse the same index.
  function ensureOccupancyIndex(state, formState) {
    const reservations = getAddAvailabilityReservations(state);

    if (!formState.occupancyIndex || formState.occupancySource !== reservations) {
      formState.occupancySource = reservations;
      formState.occupancyIndex = buildRoomOccupancyIndex(reservations);
    }

    return formState.occupancyIndex;
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

  function renderRoomPicker(context, state, form, formState) {
    const grid = qs('[data-add-room-grid]', form);
    if (!grid) {
      return null;
    }

    const input = {
      rooms: activeRooms(state),
      index: ensureOccupancyIndex(state, formState),
      checkIn: qs('[data-add-check-in]', form)?.value,
      checkOut: qs('[data-add-check-out]', form)?.value,
      horizonEnd: state.addAvailabilityEnd,
      selectedNumbers: getRoomNumbers(form),
    };

    let model = buildRoomPickerModel(input);
    const reconciled = reconcileSelectedRooms(model);
    if (reconciled.dropped.length) {
      setRoomNumbers(form, reconciled.kept);
      model = buildRoomPickerModel({ ...input, selectedNumbers: reconciled.kept });
      context.setAlert?.(
        `${reconciled.dropped.length === 1 ? 'Căsuța' : 'Căsuțele'} ${reconciled.dropped.join(', ')} nu mai ${reconciled.dropped.length === 1 ? 'este liberă' : 'sunt libere'} pentru perioada aleasă — ${reconciled.dropped.length === 1 ? 'a fost deselectată' : 'au fost deselectate'}.`,
      );
    }

    grid.innerHTML = '';
    model.groups.forEach((group) => {
      const block = root.document.createElement('div');
      block.className = 'crm-room-group';

      const heading = root.document.createElement('span');
      heading.className = 'crm-room-group__label';
      const name = root.document.createElement('span');
      name.textContent = group.label;
      const count = root.document.createElement('span');
      count.textContent = model.ranged && !model.unverified ? `${group.freeCount}/${group.totalCount}` : '';
      heading.append(name, count);

      const squares = root.document.createElement('div');
      squares.className = 'crm-room-group__grid';
      group.squares.forEach((square) => {
        const button = root.document.createElement('button');
        button.type = 'button';
        button.className = `crm-room-square is-${square.state}`;
        button.textContent = String(square.number);
        button.dataset.addRoom = String(square.number);
        button.disabled = square.state === 'inactive' || square.state === 'occupied';
        button.setAttribute('aria-pressed', String(square.state === 'selected'));
        button.setAttribute('aria-label', `Căsuța ${square.number}`);
        button.addEventListener('click', () => toggleRoomSquare(context, state, form, formState, square.number));
        squares.appendChild(button);
      });

      block.append(heading, squares);
      grid.appendChild(block);
    });

    renderRoomStatus(form, model);
    return model;
  }

  function renderRoomStatus(form, model) {
    const status = qs('[data-add-room-status]', form);
    if (!status) {
      return;
    }

    status.classList.remove('is-free', 'is-empty', 'is-warning');

    if (!model.ranged) {
      status.textContent = 'Alege întâi perioada';
      return;
    }

    if (model.unverified) {
      status.textContent = 'Disponibilitate neverificată';
      status.classList.add('is-warning');
      return;
    }

    if (!model.freeCount) {
      status.textContent = 'Nicio cameră liberă';
      status.classList.add('is-empty');
      return;
    }

    status.textContent = model.selectedNumbers.length
      ? `${model.selectedNumbers.length} selectate din ${model.freeCount} libere`
      : `${model.freeCount} din ${model.totalCount} libere`;
    status.classList.add('is-free');
  }

  function toggleRoomSquare(context, state, form, formState, number) {
    // Clicking a room before the dates are known opens the calendar instead of
    // dying silently — the grid cannot know availability yet.
    if (!hasCompleteRange(qs('[data-add-check-in]', form)?.value, qs('[data-add-check-out]', form)?.value)) {
      formState.calendarOpen = true;
      renderAddCalendar(context, state, form, formState);
      return;
    }

    const selected = new Set(getRoomNumbers(form));
    if (selected.has(number)) {
      selected.delete(number);
    } else {
      selected.add(number);
    }

    setRoomNumbers(form, Array.from(selected));
    renderRoomPicker(context, state, form, formState);
    updateAddTotal(context, state, form, formState);
  }

  function updateHoldUi(form) {
    const hold = readHoldState(form);
    const body = qs('[data-add-hold-body]', form);
    const note = qs('[data-add-hold-expiry]', form);
    const submit = qs('[data-add-submit]', form);

    if (body) {
      body.hidden = !hold.enabled;
    }
    if (note) {
      note.textContent = hold.enabled ? formatHoldExpiry(holdExpiresAt(hold.hours, new Date())) : '';
    }
    if (submit) {
      submit.textContent = hold.enabled ? `Blochează temporar (${hold.hours}h)` : 'Adaugă rezervare';
      submit.classList.toggle('crm-button--hold', hold.enabled);
    }

    return hold;
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

  // Dates first, rooms second (ADR-100). A date is offered when SOME villa can
  // take the stay, not when the villas typed in a box can — the room grid below
  // then shows which ones. Checking the whole [check-in, date) range rather than
  // each night separately is what stops the classic false positive where villa A
  // is free on night one and villa B on night two, but no single villa covers
  // the stay.
  //
  // No upper bound on how far ahead staff can book (ADR-086). Occupancy is loaded
  // for the next ~2 years (ADD_RESERVATION_LOOKAHEAD_DAYS); past that the index
  // is empty so dates read as free, and the grid says "disponibilitate
  // neverificată" instead of claiming villas are available.
  function isAddDateSelectable(state, form, formState, date) {
    const pricing = root.EcoVilaPricing;
    const checkIn = qs('[data-add-check-in]', form)?.value;
    const checkOut = qs('[data-add-check-out]', form)?.value;
    const index = ensureOccupancyIndex(state, formState);
    const rooms = activeRooms(state);

    if (date < todayISO()) {
      return false;
    }

    const rangeStart = checkIn && !checkOut && date > checkIn ? checkIn : date;
    const rangeEnd = checkIn && !checkOut && date > checkIn ? date : pricing.addDays(date, 1);

    return rooms.some((room) => isRoomFreeInIndex(index, room.id, rangeStart, rangeEnd));
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
    const startingOver = !checkInInput.value || checkOutInput.value || date <= checkInInput.value;

    if (startingOver) {
      checkInInput.value = date;
      checkOutInput.value = '';
    } else {
      checkOutInput.value = date;
    }

    // Picking a new check-in restarts the stay, so the villas chosen for the old
    // range are meaningless; completing the range closes the popover so the grid
    // it uncovers is the next thing staff see.
    if (startingOver) {
      setRoomNumbers(form, []);
    }
    formState.calendarOpen = startingOver;

    renderAddDateSummary(context, form);
    renderRoomPicker(context, state, form, formState);
    updateAddTotal(context, state, form, formState);
    renderAddCalendar(context, state, form, formState);
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
    renderRoomPicker(context, state, form, formState);
    updateHoldUi(form);
    renderAddTotal(form, 0);

    qs('[data-add-kids]', form)?.addEventListener('input', () => {
      renderChildBuckets(context, state, form, formState);
    });
    qs('[data-add-adults]', form)?.addEventListener('input', () => {
      updateAddTotal(context, state, form, formState);
    });
    qs('[data-add-hold-toggle]', form)?.addEventListener('change', () => {
      updateHoldUi(form);
    });
    qsa('[data-add-hold-hours]', form).forEach((input) => {
      input.addEventListener('change', () => {
        // Picking a duration is the same intent as ticking the box.
        const toggle = qs('[data-add-hold-toggle]', form);
        if (toggle) {
          toggle.checked = true;
        }
        updateHoldUi(form);
      });
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
      // Without a stay there is nothing to hold a villa for.
      setRoomNumbers(form, []);
      renderAddDateSummary(context, form);
      renderRoomPicker(context, state, form, formState);
      updateAddTotal(context, state, form, formState);
      renderAddCalendar(context, state, form, formState);
    });
    qs('[data-add-calendar-apply]', form)?.addEventListener('click', () => {
      formState.calendarOpen = false;
      renderAddCalendar(context, state, form, formState);
    });
    root.document.addEventListener('click', (event) => {
      if (!formState.calendarOpen || isClickInsideAddDatePicker(event) || isClickOnRoomSquare(event)) {
        return;
      }
      formState.calendarOpen = false;
      renderAddCalendar(context, state, form, formState);
    });

    return {
      formState,
      // A realtime reload must never throw away the stay staff are typing up.
      // renderRoomPicker reconciles instead: villas taken in the meantime lose
      // their selection (and say so), the dates stay put.
      refresh() {
        renderChildBuckets(context, state, form, formState);
        renderAddDateSummary(context, form);
        renderRoomPicker(context, state, form, formState);
        renderAddCalendar(context, state, form, formState);
        updateHoldUi(form);
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
        // A double-click used to race two inserts — the loser hit the room
        // no-overlap constraint and showed the misleading "tocmai au fost
        // rezervate" alert about its own twin.
        const submitButton = addForm.querySelector('button[type="submit"]');
        if (submitButton?.disabled) {
          return;
        }
        if (submitButton) submitButton.disabled = true;
        try {
          const validationError = validateAddForm(state, addForm, addController.formState);
          if (validationError) {
            context.setAlert(validationError);
            return;
          }

          const rows = buildStaffReservationRows(addForm, state.rooms || [], context);
          await helpers.insertStaffReservations(context.client, rows);
          // Clear any stale warning (e.g. "căsuța 4 a fost deselectată") now that
          // the booking actually landed.
          context.setAlert('');
          addForm.reset();
          clearAddFormSelection(addForm);
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
        } finally {
          if (submitButton) submitButton.disabled = false;
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
    buildRoomOccupancyIndex,
    buildRoomPickerModel,
    clearAddFormSelection,
    buildStaffReservationRows,
    calculateStaffBillableGuests,
    calculateStaffTotal,
    formatHoldExpiry,
    holdExpiresAt,
    init,
    isClickInsideAddDatePicker,
    isClickOnRoomSquare,
    isRoomFreeInIndex,
    readHoldState,
    readNumberList,
    reconcileSelectedRooms,
    renderSearchResults,
    selectedRoomsFromNumbers,
    splitTotalPrice,
    validateAddForm,
  };
});
