(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmDashboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const ADD_RESERVATION_LOOKAHEAD_DAYS = 365;
  const CALENDAR_BUFFER_MONTHS = 1;
  const CALENDAR_EDGE_DAYS = 7;
  const DELETE_CONFIRMATIONS = [
    'Sigur vrei să ștergi această rezervare?',
    'Ești absolut sigur că vrei să ștergi această rezervare?',
  ];
  const PAYMENT_LABELS = {
    office: 'din oficiu',
    cash: 'cash',
    card: 'card',
  };

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function qsa(selector, scope) {
    return Array.from((scope || root.document).querySelectorAll(selector));
  }

  function createCell(className, text) {
    const cell = root.document.createElement('div');
    cell.className = `crm-calendar-cell ${className || ''}`.trim();
    if (text) {
      cell.textContent = text;
    }
    return cell;
  }

  function createRoomCell(room) {
    const cell = createCell('crm-calendar-cell--room');
    cell.innerHTML = `
      <strong>${room.number}</strong>
    `;
    return cell;
  }

  function setText(selector, value) {
    const node = qs(selector);
    if (node) {
      node.textContent = String(value);
    }
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

  function formatMonthLabel(date) {
    const formatted = new Intl.DateTimeFormat('ro-MD', {
      month: 'long',
      year: 'numeric',
    }).format(new Date(`${root.EcoVilaCrmCalendar.startOfMonth(date)}T00:00:00Z`));
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }

  function calendarColumnWidth() {
    const rootStyles = root.getComputedStyle?.(root.document.documentElement);
    return Number.parseFloat(rootStyles?.getPropertyValue('--crm-day-column-width')) || 136;
  }

  function buildCalendarWindowDates(focusDate) {
    const focusMonth = root.EcoVilaCrmCalendar.startOfMonth(focusDate);
    const startMonth = root.EcoVilaCrmCalendar.addMonths(focusMonth, -CALENDAR_BUFFER_MONTHS);
    const endMonth = root.EcoVilaCrmCalendar.addMonths(focusMonth, CALENDAR_BUFFER_MONTHS + 1);
    const dates = [];
    let cursor = startMonth;
    while (cursor < endMonth) {
      dates.push(cursor);
      cursor = root.EcoVilaCrmCalendar.addDays(cursor, 1);
    }
    return dates;
  }

  function calendarMonthLabelForScroll(options) {
    const dates = options?.dates || [];
    if (!dates.length) {
      return '';
    }

    const columnWidth = Number(options?.columnWidth) || calendarColumnWidth();
    const scrollLeft = Math.max(0, Number(options?.scrollLeft) || 0);
    const index = Math.max(0, Math.min(dates.length - 1, Math.floor(scrollLeft / columnWidth)));
    return formatMonthLabel(dates[index]);
  }

  function visibleCalendarDate(state) {
    const dates = state?.dates || [];
    if (!dates.length) {
      return state?.focusDate || root.EcoVilaCrmCalendar.todayISO();
    }

    const calendar = qs('[data-reservation-calendar]');
    const index = Math.max(0, Math.min(dates.length - 1, Math.floor((calendar?.scrollLeft || 0) / calendarColumnWidth())));
    return dates[index] || state.focusDate || dates[0];
  }

  function updateCalendarMonthFromScroll(state) {
    const calendar = qs('[data-reservation-calendar]');
    const label = calendarMonthLabelForScroll({
      dates: state?.dates || [],
      scrollLeft: calendar?.scrollLeft || 0,
      columnWidth: calendarColumnWidth(),
    });
    if (label) {
      setText('[data-calendar-range]', label);
      state.currentVisibleDate = visibleCalendarDate(state);
    }
  }

  function captureCalendarScroll(state) {
    const calendar = qs('[data-reservation-calendar]');
    if (calendar && state) {
      state.calendarScrollLeft = calendar.scrollLeft || 0;
    }
  }

  function restoreCalendarScroll(state) {
    const calendar = qs('[data-reservation-calendar]');
    if (!calendar || !state || !Number.isFinite(state.calendarScrollLeft)) {
      updateCalendarMonthFromScroll(state);
      return;
    }

    const restore = () => {
      calendar.scrollLeft = Math.max(0, state.calendarScrollLeft);
      updateCalendarMonthFromScroll(state);
    };

    if (typeof root.requestAnimationFrame === 'function') {
      root.requestAnimationFrame(restore);
    } else {
      restore();
    }
  }

  function formatCountdown(expiresAt) {
    if (!expiresAt) {
      return 'Fără termen';
    }

    const threshold = new Date(expiresAt).getTime() + 10 * 60 * 1000;
    const diff = Math.max(0, threshold - Date.now());
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} rămase`;
  }

  function renderPendingCash(context, reservations) {
    const list = qs('[data-pending-cash-list]');
    if (!list) {
      return;
    }

    const groups = root.EcoVilaCrmCalendar.groupPendingCashReservations(reservations);
    setText('[data-pending-cash-count]', groups.length);
    setText('[data-stat-pending-cash]', groups.length);

    if (!groups.length) {
      list.innerHTML = '<p class="crm-empty">Nu sunt plăți cash în așteptare.</p>';
      return;
    }

    list.innerHTML = groups.map((group) => {
      const reservation = group.primary;
      const name = escapeHtml(root.EcoVilaCrmCalendar.guestName(reservation) || 'Fără nume');
      const roomLabel = escapeHtml(group.roomLabel);
      const expiresAt = escapeHtml(group.cash_expires_at || '');
      const bookingGroupId = escapeHtml(group.bookingGroupId);
      const reservationId = escapeHtml(reservation.id || '');
      return `
        <article class="crm-pending-card" data-pending-group="${bookingGroupId}">
          <strong>${name}</strong>
          <span>${roomLabel}</span>
          <span>Cash · ${context.formatMDL(group.totalPrice)}</span>
          <span data-countdown data-expires-at="${expiresAt}">${formatCountdown(group.cash_expires_at)}</span>
          <button class="crm-button crm-button--primary crm-button--small" type="button" data-mark-paid="${reservationId}" data-mark-paid-group="${bookingGroupId}">
            Marchează ca plătit
          </button>
        </article>
      `;
    }).join('');

    list.querySelectorAll('[data-mark-paid]').forEach((button) => {
      button.addEventListener('click', () => markPaid(context, button.dataset.markPaid, button.dataset.markPaidGroup));
    });
  }

  function guestSummary(reservation) {
    const adults = Number(reservation.adults || 0);
    const kids = Array.isArray(reservation.kids_ages) ? reservation.kids_ages.length : 0;
    return `${adults} adulți · ${kids} copii`;
  }

  function groupCardClass(block) {
    const pendingCash = block.reservations.some((reservation) => {
      return reservation.payment_type === 'cash' && reservation.payment_status === 'pending';
    });
    if (pendingCash) {
      return 'crm-reservation-card--pending';
    }

    if (block.reservations.every((reservation) => root.EcoVilaCrmCalendar.isCancelled(reservation))) {
      return 'crm-reservation-card--cancelled';
    }

    return root.EcoVilaCrmCalendar.getCardClass(block.primary);
  }

  const GROUP_COLOR_COUNT = 5;

  function blockStayStart(block) {
    return block.primary?.check_in || block.startDate || '';
  }

  function blockStayEnd(block) {
    return block.primary?.check_out || block.endDate || '';
  }

  function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    // Half-open [start, end): two stays share a day only if they truly overlap.
    return aStart < bEnd && bStart < aEnd;
  }

  // A booking that occupies non-adjacent villas (or split date ranges) renders as
  // several separate blocks instead of one spanning box. Give every such multi-block
  // group a shared accent colour so the scattered cards read as one reservation.
  // Colours may repeat across days, but greedy interval colouring keeps overlapping
  // groups distinct (5 colours cover any realistic same-day overlap; beyond that it
  // degrades gracefully to the least-used colour).
  function assignGroupColors(blocks) {
    const groups = new Map();

    (blocks || []).forEach((block) => {
      const key = block.bookingGroupId;
      if (!key) {
        return;
      }
      if (!groups.has(key)) {
        groups.set(key, { key, count: 0, start: '', end: '' });
      }
      const entry = groups.get(key);
      entry.count += 1;
      const start = blockStayStart(block);
      const end = blockStayEnd(block);
      if (start && (!entry.start || start < entry.start)) {
        entry.start = start;
      }
      if (end && (!entry.end || end > entry.end)) {
        entry.end = end;
      }
    });

    const multiBlockGroups = Array.from(groups.values())
      .filter((entry) => entry.count >= 2)
      .sort((left, right) => {
        return String(left.start).localeCompare(String(right.start))
          || String(left.key).localeCompare(String(right.key));
      });

    const colorByGroup = new Map();
    const assigned = [];

    multiBlockGroups.forEach((entry) => {
      const counts = new Array(GROUP_COLOR_COUNT).fill(0);
      assigned.forEach((prev) => {
        if (rangesOverlap(entry.start, entry.end, prev.start, prev.end)) {
          counts[prev.color] += 1;
        }
      });

      let color = 0;
      for (let index = 1; index < GROUP_COLOR_COUNT; index += 1) {
        if (counts[index] < counts[color]) {
          color = index;
        }
      }

      colorByGroup.set(entry.key, color);
      assigned.push({ start: entry.start, end: entry.end, color });
    });

    return colorByGroup;
  }

  function reservationCard(context, block, groupColorClass) {
    const reservation = block.primary;
    const total = block.reservations.reduce((sum, item) => sum + Number(item.total_price || 0), 0);
    const totalLabel = context.formatMDL(total);
    const phone = escapeHtml(root.EcoVilaCrmCalendar.formatCalendarPhone(reservation.guest_phone));
    const expiresAt = escapeHtml(reservation.cash_expires_at || '');
    const statusClass = groupCardClass(block);
    const card = root.document.createElement('article');
    card.className = [
      'crm-reservation-card',
      'crm-reservation-card--block',
      block.rowSpan > 1 ? 'crm-reservation-card--multi-row' : '',
      statusClass,
      // Cancelled stays grey; otherwise the booking-group accent wins over the status fill.
      statusClass === 'crm-reservation-card--cancelled' ? '' : (groupColorClass || ''),
    ].filter(Boolean).join(' ');
    card.style.gridColumn = `${block.columnStart} / span ${block.columnSpan}`;
    card.style.gridRow = `${block.rowStart} / span ${block.rowSpan}`;
    card.draggable = true;
    card.dataset.reservationId = reservation.id;
    card.dataset.bookingGroupId = block.bookingGroupId;
    card.dataset.roomId = reservation.room_id || '';
    card.dataset.roomIds = block.roomIds.join(',');
    card.dataset.roomExplicitlySelected = String(Boolean(reservation.room_explicitly_selected));
    card.innerHTML = `
      <strong>${escapeHtml(totalLabel)}</strong>
      <span>${guestSummary(reservation)}</span>
      <span class="crm-reservation-card__phone">${phone}</span>
      ${reservation.payment_type === 'cash' && reservation.payment_status === 'pending' ? `<span data-countdown data-expires-at="${expiresAt}">${formatCountdown(reservation.cash_expires_at)}</span>` : ''}
    `;
    card.addEventListener('click', () => openReservation(reservation, { groupTotal: total }));
    return card;
  }

  let _countdownInterval = null;

  function startCountdownTicker() {
    if (_countdownInterval) return;
    _countdownInterval = setInterval(() => {
      qsa('[data-countdown][data-expires-at]').forEach((node) => {
        node.textContent = formatCountdown(node.dataset.expiresAt);
      });
    }, 1000);
  }

  let activeState = null;

  function renderCalendar(context, state) {
    const grid = qs('[data-calendar-grid]');
    if (!grid) {
      return;
    }

    const dates = state.dates || root.EcoVilaCrmCalendar.enumerateMonthDates(state.startDate);
    const today = state.today || root.EcoVilaCrmCalendar.todayISO();
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `var(--crm-room-column-width) repeat(${dates.length}, var(--crm-day-column-width))`;
    grid.style.gridTemplateRows = `48px repeat(${state.rooms.length}, var(--crm-calendar-room-row-height))`;
    grid.style.minWidth = `calc(var(--crm-room-column-width) + ${dates.length} * var(--crm-day-column-width))`;
    const corner = createCell('crm-calendar-cell--head crm-calendar-cell--corner');
    corner.style.gridColumn = '1';
    corner.style.gridRow = '1';
    grid.appendChild(corner);

    dates.forEach((date, dateIndex) => {
      const cell = createCell(`crm-calendar-cell--head ${date === today ? 'is-today' : ''}`, context.formatDate(date));
      cell.style.gridColumn = String(dateIndex + 2);
      cell.style.gridRow = '1';
      grid.appendChild(cell);
    });

    state.rooms.forEach((room, roomIndex) => {
      const roomCell = createRoomCell(room);
      roomCell.style.gridColumn = '1';
      roomCell.style.gridRow = String(roomIndex + 2);
      grid.appendChild(roomCell);
      dates.forEach((date, dateIndex) => {
        const cell = createCell(date === today ? 'is-today' : '');
        cell.style.gridColumn = String(dateIndex + 2);
        cell.style.gridRow = String(roomIndex + 2);
        cell.dataset.roomId = room.id;
        cell.dataset.date = date;
        cell.addEventListener('dragover', (event) => event.preventDefault());
        cell.addEventListener('drop', (event) => handleDrop(context, state, event, cell));
        grid.appendChild(cell);
      });
    });

    const blocks = root.EcoVilaCrmCalendar.buildReservationBlocks(state.reservations, state.rooms, dates, {
      showCancelled: qs('[data-show-cancelled]')?.checked,
    });
    const groupColors = assignGroupColors(blocks);
    blocks.forEach((block) => {
      const colorIndex = groupColors.get(block.bookingGroupId);
      const groupColorClass = Number.isInteger(colorIndex)
        ? `crm-reservation-card--group-${colorIndex + 1}`
        : '';
      grid.appendChild(reservationCard(context, block, groupColorClass));
    });

    updateCalendarMonthFromScroll(state);
    const jump = qs('[data-calendar-jump-date]');
    if (jump) {
      jump.value = state.focusDate || today;
    }
  }

  async function handleDrop(context, state, event, cell) {
    const reservationId = event.dataTransfer?.getData('text/plain');
    const reservation = state.reservations.find((item) => item.id === reservationId);
    if (!reservation) {
      return;
    }

    const targetReservation = state.reservations.find((item) => {
      return item.id !== reservation.id && item.room_id === cell.dataset.roomId && root.EcoVilaCrmCalendar.overlapsDate(item, cell.dataset.date);
    });

    if (targetReservation && root.EcoVilaCrmCalendar.requiresSwapConfirmation(reservation, targetReservation)) {
      const dialog = qs('[data-swap-dialog]');
      dialog?.showModal?.();
      const input = qs('[data-swap-confirm]', dialog);
      const confirm = qs('[data-confirm-swap]', dialog);
      confirm.onclick = async () => {
        if (input.value.trim() !== 'schimba') {
          context.setAlert('Tastează schimba pentru confirmare.');
          return;
        }
        await swapRooms(context, reservation, targetReservation);
      };
      return;
    }

    await context.client
      .from('reservations')
      .update({ room_id: cell.dataset.roomId })
      .eq('id', reservation.id);
    await state.reload();
  }

  async function swapRooms(context, left, right) {
    await context.client.from('reservations').update({ room_id: right.room_id }).eq('id', left.id);
    await context.client.from('reservations').update({ room_id: left.room_id }).eq('id', right.id);
    await activeState?.reload?.();
  }

  function openReservation(reservation, options = {}) {
    if (!reservation) {
      return;
    }

    const dialog = qs('[data-reservation-dialog]');
    if (!dialog) {
      return;
    }

    qs('[data-edit-check-in]', dialog).value = reservation.check_in || '';
    qs('[data-edit-check-out]', dialog).value = reservation.check_out || '';
    qs('[data-edit-adults]', dialog).value = reservation.adults || 0;
    qs('[data-edit-kids-ages]', dialog).value = (reservation.kids_ages || []).join(', ');
    qs('[data-edit-name]', dialog).value = root.EcoVilaCrmCalendar.guestName(reservation);
    qs('[data-edit-phone]', dialog).value = reservation.guest_phone || '';
    qs('[data-edit-notes]', dialog).value = reservation.notes || '';
    const paymentLabel = PAYMENT_LABELS[reservation.payment_type] || reservation.payment_type || '-';
    qs('[data-edit-payment]', dialog).textContent = `Tip plată: ${paymentLabel} · ${reservation.payment_status}`;
    // Grouped (multi-villa) bookings: show the booking-group total to match the
    // calendar card. Falls back to the single reservation price when no group
    // total is supplied (e.g. the dialog opened outside the calendar grid).
    const totalPrice = Number.isFinite(options.groupTotal)
      ? options.groupTotal
      : Number(reservation.total_price || 0);
    qs('[data-edit-total]', dialog).textContent = `Preț total: ${root.EcoVilaCrmApp.formatMDL(totalPrice)}`;
    const sendConfirmation = qs('[data-send-payment-confirmation]', dialog);
    if (sendConfirmation) {
      const canSendConfirmation = reservation.payment_type === 'cash' && reservation.payment_status === 'paid';
      sendConfirmation.hidden = !canSendConfirmation;
      sendConfirmation.onclick = canSendConfirmation ? () => sendPaymentConfirmation(reservation) : null;
    }
    qs('[data-delete-reservation]', dialog).onclick = () => deleteReservation(reservation);
    dialog.showModal?.();
  }

  async function deleteReservation(reservation) {
    const confirmed = DELETE_CONFIRMATIONS.every((message) => root.confirm?.(message));
    if (!confirmed) {
      activeState?.context?.setAlert('');
      return;
    }

    const context = activeState?.context;
    if (!context?.client) {
      return;
    }

    try {
      if (reservation.payment_type === 'card' && reservation.payment_status === 'paid') {
        await root.EcoVilaSupabase.refundMaibPaymentRequest(context.client, {
          bookingGroupId: reservation.booking_group_id,
          reason: 'crm_cancellation',
        });
      }

      const cancellation = {
        payment_status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: 'Anulat din CRM',
      };

      if (reservation.booking_group_id) {
        await root.EcoVilaSupabase.updateReservationGroup(
          context.client,
          reservation.booking_group_id,
          cancellation,
        );
      } else {
        await root.EcoVilaSupabase.updateReservation(context.client, reservation.id, cancellation);
      }

      // Best-effort: tell the guest their reservation was cancelled. The
      // cancellation already succeeded, so a failed notification must not undo it.
      let alert = '';
      try {
        await root.EcoVilaSupabase.notifyReservationCancellation(context.client, {
          bookingGroupId: reservation.booking_group_id,
          reservationId: reservation.id,
        });
      } catch (notifyError) {
        alert = 'Rezervarea a fost anulată, dar notificarea către client nu a putut fi trimisă.';
      }

      context.setAlert?.(alert);
      await activeState.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Anularea a eșuat.';
      context.setAlert?.(`Rezervarea nu a fost anulată: ${message.slice(0, 180)}`);
    }
  }

  async function markPaid(context, reservationId, bookingGroupId) {
    const result = await root.EcoVilaSupabase.confirmReservationPayment(context.client, {
      reservationId,
      bookingGroupId,
    });
    await activeState?.reload?.();
    showPaymentConfirmationResult(activeState?.context || context, result);
  }

  async function sendPaymentConfirmation(reservation) {
    const context = activeState?.context;
    if (!context) {
      return;
    }

    const result = await root.EcoVilaSupabase.confirmReservationPayment(context.client, {
      reservationId: reservation.id,
      bookingGroupId: reservation.booking_group_id,
    });
    await activeState?.reload?.();
    showPaymentConfirmationResult(context, result);
  }

  function showPaymentConfirmationResult(context, result) {
    const failures = (result?.notificationResults || []).filter((item) => {
      return item && item.sent === false && !item.skipped_duplicate;
    });

    if (!failures.length) {
      context?.setAlert?.('');
      return;
    }

    const message = failures
      .map((item) => item.error || item.reason || 'SMS-ul nu a fost trimis.')
      .filter(Boolean)
      .join(' ');
    context?.setAlert?.(`Plata a fost confirmată, dar SMS-ul nu a fost trimis: ${message.slice(0, 180)}`);
  }

  function renderTodayStats(state) {
    const today = state.today || root.EcoVilaCrmCalendar.todayISO();
    const activeReservations = (state.todayReservations || []).filter((reservation) => {
      return !root.EcoVilaCrmCalendar.isCancelled(reservation);
    });
    const occupiedRoomIds = new Set(
      activeReservations
        .filter((reservation) => root.EcoVilaCrmCalendar.overlapsDate(reservation, today))
        .map((reservation) => reservation.room_id)
        .filter(Boolean),
    );
    const arrivals = root.EcoVilaCrmCalendar.groupReservationRows(
      activeReservations.filter((reservation) => reservation.check_in === today),
    );
    const departures = root.EcoVilaCrmCalendar.groupReservationRows(
      activeReservations.filter((reservation) => reservation.check_out === today),
    );

    setText('[data-stat-free-rooms]', Math.max(0, (state.rooms || []).length - occupiedRoomIds.size));
    setText('[data-stat-occupied-rooms]', occupiedRoomIds.size);
    setText('[data-stat-arrivals-today]', arrivals.length);
    setText('[data-stat-departures-today]', departures.length);
  }

  function scrollCalendarToDate(state, date) {
    const calendar = qs('[data-reservation-calendar]');
    const dates = state.dates || [];
    const index = dates.indexOf(date);
    if (!calendar || index < 0) {
      return;
    }

    calendar.scrollLeft = Math.max(0, index * calendarColumnWidth());
    updateCalendarMonthFromScroll(state);
  }

  function maybeExtendCalendarWindow(context, state) {
    const calendar = qs('[data-reservation-calendar]');
    if (!calendar || state.isLoading) {
      return;
    }

    const threshold = calendarColumnWidth() * CALENDAR_EDGE_DAYS;
    const nearLeft = calendar.scrollLeft <= threshold;
    const nearRight = calendar.scrollLeft + calendar.clientWidth >= calendar.scrollWidth - threshold;
    if (!nearLeft && !nearRight) {
      return;
    }

    const anchorDate = visibleCalendarDate(state);
    state.focusDate = root.EcoVilaCrmCalendar.addMonths(anchorDate, nearLeft ? -1 : 1);
    state.scrollToDateAfterReload = anchorDate;
    state.reload().catch((error) => context.setAlert(error?.message || 'Dashboardul nu s-a putut încărca.'));
  }

  async function loadDashboard(context, state) {
    const helpers = root.EcoVilaSupabase;
    captureCalendarScroll(state);
    state.isLoading = true;
    try {
      state.today = root.EcoVilaCrmCalendar.todayISO();
      state.focusDate = state.focusDate || state.today;
      state.startDate = root.EcoVilaCrmCalendar.startOfMonth(state.focusDate);
      state.dates = buildCalendarWindowDates(state.focusDate);
      const endDate = root.EcoVilaCrmCalendar.addDays(state.dates[state.dates.length - 1], 1);
      const todayWindowStart = root.EcoVilaCrmCalendar.addDays(state.today, -1);
      const todayWindowEnd = root.EcoVilaCrmCalendar.addDays(state.today, 1);
      const addAvailabilityStart = state.today;
      const addAvailabilityEnd = root.EcoVilaCrmCalendar.addDays(addAvailabilityStart, ADD_RESERVATION_LOOKAHEAD_DAYS);
      const [rooms, reservations, pending, todayReservations, pricingTiers, holidays, addReservations] = await Promise.all([
        helpers.fetchRooms(context.client),
        helpers.fetchAdminReservations(context.client, { startDate: state.dates[0], endDate }),
        helpers.fetchPendingCashReservations(context.client),
        helpers.fetchAdminReservations(context.client, { startDate: todayWindowStart, endDate: todayWindowEnd }),
        helpers.fetchPricingTiers(context.client),
        helpers.fetchHolidays(context.client),
        helpers.fetchAdminReservations(context.client, { startDate: addAvailabilityStart, endDate: addAvailabilityEnd }),
      ]);
      state.rooms = rooms;
      state.reservations = root.EcoVilaCrmCalendar.sortReservations(reservations);
      state.todayReservations = root.EcoVilaCrmCalendar.sortReservations(todayReservations);
      state.pricingTiers = pricingTiers;
      state.holidays = holidays;
      state.addReservations = root.EcoVilaCrmCalendar.sortReservations(addReservations);
      state.addAvailabilityEnd = addAvailabilityEnd;
      renderCalendar(context, state);
      renderPendingCash(context, pending);
      renderTodayStats(state);
      state.refreshAddReservationForm?.();
      const scrollTarget = state.scrollToDateAfterReload || (state.shouldScrollToFocus ? state.focusDate : '');
      if (scrollTarget) {
        scrollCalendarToDate(state, scrollTarget);
      } else {
        restoreCalendarScroll(state);
      }
    } finally {
      state.scrollToDateAfterReload = '';
      state.shouldScrollToFocus = false;
      state.isLoading = false;
    }
  }

  function init(context) {
    const today = root.EcoVilaCrmCalendar.todayISO();
    const state = {
      context,
      today,
      startDate: root.EcoVilaCrmCalendar.startOfMonth(today),
      focusDate: today,
      dates: buildCalendarWindowDates(today),
      shouldScrollToFocus: true,
      scrollToDateAfterReload: '',
      calendarScrollLeft: 0,
      currentVisibleDate: today,
      isLoading: false,
      rooms: [],
      reservations: [],
      todayReservations: [],
      pricingTiers: [],
      holidays: [],
      addReservations: [],
      addAvailabilityEnd: '',
      reload: () => loadDashboard(context, state),
      openReservation,
    };
    activeState = state;

    qs('[data-refresh-pending]')?.addEventListener('click', state.reload);
    qs('[data-calendar-prev]')?.addEventListener('click', () => {
      state.focusDate = root.EcoVilaCrmCalendar.addMonths(visibleCalendarDate(state), -1);
      state.shouldScrollToFocus = true;
      state.reload();
    });
    qs('[data-calendar-next]')?.addEventListener('click', () => {
      state.focusDate = root.EcoVilaCrmCalendar.addMonths(visibleCalendarDate(state), 1);
      state.shouldScrollToFocus = true;
      state.reload();
    });
    qs('[data-calendar-today]')?.addEventListener('click', () => {
      state.today = root.EcoVilaCrmCalendar.todayISO();
      state.startDate = root.EcoVilaCrmCalendar.startOfMonth(state.today);
      state.focusDate = state.today;
      state.shouldScrollToFocus = true;
      state.reload();
    });
    qs('[data-calendar-jump-date]')?.addEventListener('change', (event) => {
      const targetDate = event.target.value;
      if (!targetDate) {
        return;
      }
      state.startDate = root.EcoVilaCrmCalendar.startOfMonth(targetDate);
      state.focusDate = targetDate;
      state.shouldScrollToFocus = true;
      state.reload();
    });
    qs('[data-show-cancelled]')?.addEventListener('change', () => renderCalendar(context, state));
    qs('[data-reservation-calendar]')?.addEventListener('scroll', () => {
      updateCalendarMonthFromScroll(state);
      maybeExtendCalendarWindow(context, state);
    }, { passive: true });
    qsa('[data-collapse-sidebar]').forEach((button) => {
      button.addEventListener('click', () => {
        const panel = qs('[data-panel="dashboard"]');
        panel?.classList.toggle('is-sidebar-collapsed');
        const collapsed = panel?.classList.contains('is-sidebar-collapsed');
        qsa('[data-collapse-sidebar]').forEach((toggle) => {
          toggle.textContent = collapsed ? 'Arată panoul' : (toggle.classList.contains('crm-sidebar-restore') ? 'Arată panoul' : 'Ascunde');
          toggle.setAttribute('aria-expanded', String(!collapsed));
        });
      });
    });

    root.document.addEventListener('dragstart', (event) => {
      const card = event.target.closest?.('[data-reservation-id]');
      if (card) {
        event.dataTransfer.setData('text/plain', card.dataset.reservationId);
      }
    });

    root.EcoVilaCrmSidebar?.init?.(context, state);
    startCountdownTicker();
    state.reload().catch((error) => context.setAlert(error?.message || 'Dashboardul nu s-a putut încărca.'));

    context.client
      .channel('crm-dashboard-reservations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, state.reload)
      .subscribe();
  }

  return {
    assignGroupColors,
    buildCalendarWindowDates,
    calendarMonthLabelForScroll,
    captureCalendarScroll,
    init,
    initStateForTests(state) {
      activeState = state;
    },
    markPaid,
    openReservation,
    renderCalendar,
    renderTodayStats,
    renderPendingCash,
    restoreCalendarScroll,
    scrollCalendarToDate,
  };
});
