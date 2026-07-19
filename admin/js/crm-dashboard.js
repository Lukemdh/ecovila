(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmDashboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  // How far ahead the "add reservation" form loads occupancy so the mini date
  // picker can show real availability. This is a data-load horizon, NOT a booking
  // cap: staff may pick any future date (see isAddDateSelectable). Within this
  // window availability is authoritative; beyond it the picker is optimistic and
  // the DB exclusion constraint (reservations_no_room_overlap) is the backstop.
  const ADD_RESERVATION_LOOKAHEAD_DAYS = 365 * 2;
  const CALENDAR_BUFFER_MONTHS = 1;
  const CALENDAR_EDGE_DAYS = 7;
  // Wait for horizontal scrolling to settle before shifting the loaded month
  // window, so an in-flight reload never yanks the calendar mid-gesture.
  const CALENDAR_EXTEND_DEBOUNCE_MS = 160;
  // After we programmatically reposition the scroll (reload/jump), ignore the
  // synthetic scroll it triggers so it cannot immediately re-extend the window.
  const CALENDAR_EXTEND_SUPPRESS_MS = 500;
  // Coalesce the per-row realtime events a grouped write emits into one reload.
  const REALTIME_RELOAD_DEBOUNCE_MS = 400;
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
      timeZone: 'UTC',
    }).format(new Date(`${root.EcoVilaCrmCalendar.startOfMonth(date)}T00:00:00Z`));
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }

  // Memoized: --crm-day-column-width is a fixed 136px with no responsive override,
  // and this is read on every scroll event. Caching the first valid read avoids a
  // getComputedStyle (style recalc) per scroll frame. Falls back to 136 without
  // caching if the stylesheet has not applied yet, so a later call can retry.
  let _cachedColumnWidth = 0;
  function calendarColumnWidth() {
    if (_cachedColumnWidth) {
      return _cachedColumnWidth;
    }
    const rootStyles = root.getComputedStyle?.(root.document.documentElement);
    const parsed = Number.parseFloat(rootStyles?.getPropertyValue('--crm-day-column-width'));
    if (parsed > 0) {
      _cachedColumnWidth = parsed;
      return parsed;
    }
    return 136;
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
      state.suppressExtendUntil = Date.now() + CALENDAR_EXTEND_SUPPRESS_MS;
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

  // Holds run for hours, not minutes, and their deadline is enforced verbatim by
  // the expiry cron — so this counts down to the real moment, with no courtesy
  // grace and no MM:SS overflowing past 60.
  function formatHoldCountdown(expiresAt) {
    if (!expiresAt) {
      return 'Fără termen';
    }

    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) {
      return 'Expiră acum';
    }

    const totalMinutes = Math.floor(diff / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours) {
      return `${hours}h ${String(minutes).padStart(2, '0')}m rămase`;
    }

    if (totalMinutes) {
      return `${totalMinutes}m rămase`;
    }

    return 'sub 1m rămas';
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

    // Read-only roles (Angela) still see which payments are pending, but the
    // "mark as paid" action is omitted (and is Diana-only server-side anyway).
    const readOnly = Boolean(context.permissions?.dashboardReadOnly);

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
          ${readOnly ? '' : `<button class="crm-button crm-button--primary crm-button--small" type="button" data-mark-paid="${reservationId}" data-mark-paid-group="${bookingGroupId}">
            Marchează ca plătit
          </button>`}
        </article>
      `;
    }).join('');

    if (!readOnly) {
      list.querySelectorAll('[data-mark-paid]').forEach((button) => {
        button.addEventListener('click', () => markPaid(context, button.dataset.markPaid, button.dataset.markPaidGroup, button));
      });
    }
  }

  // Holds get their own panel rather than joining "Plăți cash în așteptare":
  // that list is a daily money tool (an online guest owes cash at reception),
  // while a hold is an internal block with different actions. The section stays
  // hidden until a hold exists, so the sidebar is unchanged on a normal day.
  function renderTemporaryHolds(context, holds) {
    const section = qs('[data-holds-section]');
    const list = qs('[data-holds-list]');
    if (!section || !list) {
      return;
    }

    const groups = root.EcoVilaCrmCalendar.groupPendingCashReservations(holds || []);
    section.hidden = !groups.length;
    setText('[data-holds-count]', groups.length);

    if (!groups.length) {
      list.innerHTML = '';
      return;
    }

    const readOnly = Boolean(context.permissions?.dashboardReadOnly);

    list.innerHTML = groups.map((group) => {
      const reservation = group.primary;
      const name = escapeHtml(root.EcoVilaCrmCalendar.guestName(reservation) || 'Fără nume');
      const roomLabel = escapeHtml(group.roomLabel);
      const expiresAt = escapeHtml(group.cash_expires_at || '');
      const bookingGroupId = escapeHtml(group.bookingGroupId);
      const phone = escapeHtml(root.EcoVilaCrmCalendar.formatCalendarPhone(reservation.guest_phone));
      return `
        <article class="crm-hold-card" data-hold-group="${bookingGroupId}">
          <strong>${name}</strong>
          <span>${roomLabel}</span>
          <span>${phone} · ${context.formatMDL(group.totalPrice)}</span>
          <span data-hold-countdown data-expires-at="${expiresAt}">${formatHoldCountdown(group.cash_expires_at)}</span>
          ${readOnly ? '' : `<div class="crm-hold-card__actions">
            <button class="crm-button crm-button--primary crm-button--small" type="button" data-confirm-hold="${bookingGroupId}">
              Confirmă
            </button>
            <button class="crm-button crm-button--small" type="button" data-release-hold="${bookingGroupId}">
              Eliberează
            </button>
          </div>`}
        </article>
      `;
    }).join('');

    if (readOnly) {
      return;
    }

    list.querySelectorAll('[data-confirm-hold]').forEach((button) => {
      button.addEventListener('click', () => confirmHold(context, button.dataset.confirmHold, button));
    });
    list.querySelectorAll('[data-release-hold]').forEach((button) => {
      button.addEventListener('click', () => releaseHold(context, button.dataset.releaseHold, button));
    });
  }

  // PostgREST rejections are plain `{ message, code, ... }` objects, not Error
  // instances, so an `instanceof Error` check would swallow the RPC's own
  // Romanian message ("Rezervarea temporară a expirat…") and show a useless
  // "Eroare necunoscută" instead.
  function errorMessage(error, fallback) {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    return message ? message.slice(0, 180) : fallback;
  }

  // The RPC call and the reload are separated on purpose: once the RPC has
  // committed, the hold IS confirmed/released, and a reload that then fails must
  // not be reported as "the hold was not confirmed".
  async function runHoldAction(input) {
    const { context, bookingGroupId, button, action, failureMessage } = input;
    if (!bookingGroupId || button?.disabled) {
      return false;
    }

    const liveContext = activeState?.context || context;
    if (button) button.disabled = true;
    let succeeded = false;
    try {
      await action();
      succeeded = true;
      liveContext?.setAlert?.('');
    } catch (error) {
      liveContext?.setAlert?.(`${failureMessage}: ${errorMessage(error, 'Eroare necunoscută.')}`);
    } finally {
      if (button) button.disabled = false;
    }

    // Reload either way: on success to show the new state, on failure because
    // the usual cause is that the cron expired the hold a moment ago.
    await activeState?.reload?.().catch(() => {});
    return succeeded;
  }

  function confirmHold(context, bookingGroupId, button) {
    return runHoldAction({
      context,
      bookingGroupId,
      button,
      action: () => root.EcoVilaSupabase.confirmTemporaryHold(context.client, bookingGroupId),
      failureMessage: 'Rezervarea temporară nu a fost confirmată',
    });
  }

  function releaseHold(context, bookingGroupId, button, options) {
    // The dialog's delete path has already asked twice before routing here.
    if (!options?.skipConfirm &&
      !root.confirm?.('Eliberezi rezervarea temporară? Camerele redevin libere imediat.')) {
      return Promise.resolve(false);
    }

    return runHoldAction({
      context,
      bookingGroupId,
      button,
      action: () => root.EcoVilaSupabase.releaseTemporaryHold(context.client, bookingGroupId),
      failureMessage: 'Rezervarea temporară nu a fost eliberată',
    });
  }

  function guestSummary(reservation) {
    const adults = Number(reservation.adults || 0);
    const kids = Array.isArray(reservation.kids_ages) ? reservation.kids_ages.length : 0;
    return `${adults} adulți · ${kids} copii`;
  }

  function groupCardClass(block) {
    if (block.reservations.some((reservation) => root.EcoVilaCrmCalendar.isTemporaryHold(reservation))) {
      return 'crm-reservation-card--hold';
    }

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
    // Read-only roles (Angela) can open a reservation to view it, but cannot
    // drag it between rooms.
    card.draggable = !context.permissions?.dashboardReadOnly;
    card.dataset.reservationId = reservation.id;
    card.dataset.bookingGroupId = block.bookingGroupId;
    card.dataset.roomId = reservation.room_id || '';
    card.dataset.roomIds = block.roomIds.join(',');
    card.dataset.roomExplicitlySelected = String(Boolean(reservation.room_explicitly_selected));
    const isHold = root.EcoVilaCrmCalendar.isTemporaryHold(reservation);
    card.innerHTML = `
      <strong>${escapeHtml(totalLabel)}</strong>
      <span>${guestSummary(reservation)}</span>
      <span class="crm-reservation-card__phone">${phone}</span>
      ${isHold ? `<span data-hold-countdown data-expires-at="${expiresAt}">${formatHoldCountdown(reservation.cash_expires_at)}</span>` : ''}
      ${!isHold && reservation.payment_type === 'cash' && reservation.payment_status === 'pending' ? `<span data-countdown data-expires-at="${expiresAt}">${formatCountdown(reservation.cash_expires_at)}</span>` : ''}
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
      qsa('[data-hold-countdown][data-expires-at]').forEach((node) => {
        node.textContent = formatHoldCountdown(node.dataset.expiresAt);
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
        if (!state.readOnly) {
          cell.addEventListener('dragover', (event) => event.preventDefault());
          cell.addEventListener('drop', (event) => handleDrop(context, state, event, cell));
        }
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

  // The exclusion constraint reservations_no_room_overlap rejects a move into an
  // occupied room with SQLSTATE 23P01 (supabase-js reports it via { error }, it
  // does not throw). P0001 carries the swap RPC's own raise messages.
  function isRoomConflictError(error) {
    return error?.code === '23P01' || String(error?.message || '').includes('reservations_no_room_overlap');
  }

  async function handleDrop(context, state, event, cell) {
    const reservationId = event.dataTransfer?.getData('text/plain');
    const reservation = state.reservations.find((item) => item.id === reservationId);
    if (!reservation) {
      return;
    }

    // A multi-villa booking renders one draggable card per villa but the drag
    // payload only carries that card's row, so a drop would silently split the
    // group across rooms. Those bookings are moved from the edit dialog instead.
    const groupSize = state.reservations.filter((item) => {
      return item.booking_group_id === reservation.booking_group_id && !root.EcoVilaCrmCalendar.isCancelled(item);
    }).length;
    if (groupSize > 1) {
      context.setAlert('Rezervările cu mai multe vile se mută din dialogul de editare.');
      return;
    }

    // Dropping on a row of another villa type would change what the guest booked
    // without any repricing — block it instead of applying it silently.
    const sourceRoom = state.rooms.find((room) => room.id === reservation.room_id);
    const targetRoom = state.rooms.find((room) => room.id === cell.dataset.roomId);
    if (sourceRoom && targetRoom && sourceRoom.type !== targetRoom.type) {
      context.setAlert('Nu poți muta rezervarea pe alt tip de cazare — prețul nu se recalculează automat.');
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
      if (input) {
        input.value = '';
      }
      confirm.onclick = async () => {
        // Wrong confirmation word: alert and keep the dialog open (the button is
        // type="button", so the method="dialog" form cannot auto-close it).
        if (input.value.trim() !== 'schimba') {
          context.setAlert('Tastează schimba pentru confirmare.');
          return;
        }
        confirm.disabled = true;
        try {
          await swapRooms(context, reservation, targetReservation);
        } finally {
          confirm.disabled = false;
          dialog?.close?.('confirm');
        }
      };
      return;
    }

    const { error } = await context.client
      .from('reservations')
      .update({ room_id: cell.dataset.roomId })
      .eq('id', reservation.id);
    if (error) {
      context.setAlert(isRoomConflictError(error)
        ? 'Mutarea nu a reușit: camera este ocupată în acel interval.'
        : `Mutarea nu a reușit: ${String(error.message || 'eroare necunoscută').slice(0, 180)}`);
    }
    await state.reload();
  }

  async function swapRooms(context, left, right) {
    // Atomic server-side swap (vacate-then-assign in one transaction). Two plain
    // UPDATEs can never swap date-overlapping stays — the first one always trips
    // the reservations_no_room_overlap exclusion constraint — and a third-party
    // conflict could half-apply the swap. The RPC rolls the whole swap back.
    const { error } = await context.client.rpc('swap_reservation_rooms', {
      left_id: left.id,
      right_id: right.id,
    });
    if (error) {
      context.setAlert(isRoomConflictError(error)
        ? 'Schimbarea nu a reușit: camera este ocupată în acel interval.'
        : `Schimbarea nu a reușit: ${String(error.message || 'eroare necunoscută').slice(0, 180)}`);
    } else {
      context.setAlert('');
    }
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

    const readOnly = Boolean(activeState?.context?.permissions?.dashboardReadOnly);

    qs('[data-edit-check-in]', dialog).value = reservation.check_in || '';
    qs('[data-edit-check-out]', dialog).value = reservation.check_out || '';
    qs('[data-edit-adults]', dialog).value = reservation.adults || 0;
    qs('[data-edit-kids-ages]', dialog).value = (reservation.kids_ages || []).join(', ');
    qs('[data-edit-name]', dialog).value = root.EcoVilaCrmCalendar.guestName(reservation);
    qs('[data-edit-phone]', dialog).value = reservation.guest_phone || '';
    qs('[data-edit-notes]', dialog).value = reservation.notes || '';
    const isHold = root.EcoVilaCrmCalendar.isTemporaryHold(reservation);
    const paymentLabel = PAYMENT_LABELS[reservation.payment_type] || reservation.payment_type || '-';
    qs('[data-edit-payment]', dialog).textContent = isHold
      ? `Rezervare temporară · ${formatHoldCountdown(reservation.cash_expires_at)}`
      : `Tip plată: ${paymentLabel} · ${reservation.payment_status}`;
    const confirmHoldButton = qs('[data-confirm-hold-dialog]', dialog);
    if (confirmHoldButton) {
      const canConfirmHold = !readOnly && isHold && Boolean(reservation.booking_group_id);
      confirmHoldButton.hidden = !canConfirmHold;
      confirmHoldButton.onclick = canConfirmHold
        ? async () => {
          // Stay open on failure so the reason (expired, already released) is
          // readable next to the reservation it refers to.
          if (await confirmHold(activeState?.context || {}, reservation.booking_group_id, confirmHoldButton)) {
            dialog.close?.('cancel');
          }
        }
        : null;
    }
    // Grouped (multi-villa) bookings: show the booking-group total to match the
    // calendar card. Falls back to the single reservation price when no group
    // total is supplied (e.g. the dialog opened outside the calendar grid).
    const totalPrice = Number.isFinite(options.groupTotal)
      ? options.groupTotal
      : Number(reservation.total_price || 0);
    qs('[data-edit-total]', dialog).textContent = `Preț total: ${root.EcoVilaCrmApp.formatMDL(totalPrice)}`;
    const sendConfirmation = qs('[data-send-payment-confirmation]', dialog);
    if (sendConfirmation) {
      const canSendConfirmation = !readOnly && reservation.payment_type === 'cash' && reservation.payment_status === 'paid';
      sendConfirmation.hidden = !canSendConfirmation;
      sendConfirmation.onclick = canSendConfirmation ? () => sendPaymentConfirmation(reservation, sendConfirmation) : null;
    }

    // Read-only roles (Angela) open the dialog to inspect a reservation, but the
    // fields are locked and the save/cancel actions are removed. The server
    // rejects these writes too, so this is purely to keep the UI honest.
    qsa('input, textarea', dialog).forEach((field) => {
      field.disabled = readOnly;
    });
    const saveButton = qs('[data-save-reservation]', dialog);
    if (saveButton) {
      saveButton.hidden = readOnly;
    }
    const dangerZone = qs('.crm-danger-zone', dialog);
    if (dangerZone) {
      dangerZone.hidden = readOnly;
    }
    const deleteButton = qs('[data-delete-reservation]', dialog);
    if (deleteButton) {
      deleteButton.onclick = readOnly ? null : () => deleteReservation(reservation);
    }

    const editError = qs('[data-edit-error]', dialog);
    if (editError) {
      editError.textContent = '';
      editError.hidden = true;
    }
    const editorForm = qs('[data-reservation-editor]', dialog);
    if (editorForm) {
      editorForm.onsubmit = (event) => handleReservationEditSubmit(event, reservation, dialog, readOnly);
    }
    dialog.showModal?.();
  }

  // "Salvează modificări": persists the dialog edits. A date change routes through
  // the reservation-reschedule function, which keeps the villa when it is still
  // free, relocates to a free same-type villa otherwise, or rejects the move when
  // none is free (shown inline). The guest is texted when the dates actually move.
  function handleReservationEditSubmit(event, reservation, dialog, readOnly) {
    event.preventDefault();
    // method="dialog": the "Închide" (cancel) button and Enter just close it.
    if (readOnly || event.submitter?.value !== 'save') {
      dialog.close?.('cancel');
      return;
    }
    saveReservationEdit(reservation, dialog);
  }

  async function saveReservationEdit(reservation, dialog) {
    const context = activeState?.context;
    if (!context?.client) {
      return;
    }

    const editError = qs('[data-edit-error]', dialog);
    const showEditError = (message) => {
      if (!editError) return;
      editError.textContent = message || '';
      editError.hidden = !message;
    };
    showEditError('');

    const checkIn = qs('[data-edit-check-in]', dialog).value;
    const checkOut = qs('[data-edit-check-out]', dialog).value;
    if (!checkIn || !checkOut) {
      showEditError('Completează datele de check-in și check-out.');
      return;
    }
    if (checkOut <= checkIn) {
      showEditError('Check-out trebuie să fie după check-in.');
      return;
    }

    const fullName = String(qs('[data-edit-name]', dialog).value || '').trim();
    const parts = fullName ? fullName.split(/\s+/) : [];

    const saveButton = qs('[data-save-reservation]', dialog);
    if (saveButton) saveButton.disabled = true;

    try {
      const result = await root.EcoVilaSupabase.rescheduleReservation(context.client, {
        reservationId: reservation.id,
        bookingGroupId: reservation.booking_group_id,
        checkIn,
        checkOut,
        adults: Number(qs('[data-edit-adults]', dialog).value || 0),
        kidsAges: parseKidsAges(qs('[data-edit-kids-ages]', dialog).value),
        guestFirstName: parts.length ? parts[0] : reservation.guest_first_name,
        guestLastName: parts.length > 1 ? parts.slice(1).join(' ') : reservation.guest_last_name,
        guestPhone: String(qs('[data-edit-phone]', dialog).value || '').trim(),
        notes: String(qs('[data-edit-notes]', dialog).value || ''),
      });
      dialog.close?.('save');
      context.setAlert?.(describeRescheduleResult(result));
      await activeState.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Modificările nu au putut fi salvate.';
      showEditError(message.slice(0, 200));
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  }

  function parseKidsAges(value) {
    return String(value || '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => Number(part));
  }

  function describeRescheduleResult(result) {
    if (!result || result.datesChanged === false) {
      return 'Modificările au fost salvate.';
    }
    const villa = result.roomChanged && result.roomNumber ? ` Vila nouă: ${result.roomNumber}.` : '';
    if (result.smsSent) {
      return `Rezervarea a fost mutată.${villa} Clientul a fost anunțat prin SMS.`;
    }
    return `Rezervarea a fost mutată.${villa} SMS-ul către client nu a putut fi trimis — anunță-l manual.`;
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

    // A temporary hold deleted from this dialog must take the release path, not
    // the booking-cancellation path below: that one texts and emails the guest
    // that "their reservation was cancelled" — for a villa they were only ever
    // told was being held, and for which they paid nothing.
    if (root.EcoVilaCrmCalendar.isTemporaryHold(reservation) && reservation.booking_group_id) {
      await releaseHold(context, reservation.booking_group_id, null, { skipConfirm: true });
      return;
    }

    // Cancel FIRST, refund SECOND. Refunding before a cancel that then fails
    // would leave the money returned while the booking stays active — the worse
    // failure mode. A refund that fails after the cancel is recorded server-side
    // and retried by the refund-reconciliation cron.
    try {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Anularea a eșuat.';
      context.setAlert?.(`Rezervarea nu a fost anulată: ${message.slice(0, 180)}`);
      return;
    }

    let alert = '';
    if (reservation.payment_type === 'card' && reservation.payment_status === 'paid') {
      try {
        await root.EcoVilaSupabase.refundMaibPaymentRequest(context.client, {
          bookingGroupId: reservation.booking_group_id,
          reason: 'crm_cancellation',
        });
      } catch (refundError) {
        alert = 'Rezervarea a fost anulată, dar restituirea NU s-a finalizat — va fi reîncercată automat; verifică tab-ul plăți.';
      }
    }

    // Best-effort: tell the guest their reservation was cancelled. The
    // cancellation already succeeded, so a failed notification must not undo it.
    try {
      await root.EcoVilaSupabase.notifyReservationCancellation(context.client, {
        bookingGroupId: reservation.booking_group_id,
        reservationId: reservation.id,
      });
    } catch (notifyError) {
      alert = alert
        ? `${alert} Notificarea către client nu a putut fi trimisă.`
        : 'Rezervarea a fost anulată, dar notificarea către client nu a putut fi trimisă.';
    }

    context.setAlert?.(alert);
    await activeState.reload();
  }

  // Money action: the button is disabled while the Edge Function runs (a double
  // click would double-invoke) and a failed invoke is surfaced instead of dying
  // as an unhandled rejection with zero staff feedback.
  async function markPaid(context, reservationId, bookingGroupId, button) {
    if (button) {
      button.disabled = true;
    }
    try {
      const result = await root.EcoVilaSupabase.confirmReservationPayment(context.client, {
        reservationId,
        bookingGroupId,
      });
      await activeState?.reload?.();
      showPaymentConfirmationResult(activeState?.context || context, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Eroare necunoscută.';
      (activeState?.context || context)?.setAlert?.(`Plata nu a fost confirmată: ${message.slice(0, 180)}`);
    } finally {
      if (button) {
        button.disabled = false;
      }
    }
  }

  async function sendPaymentConfirmation(reservation, button) {
    const context = activeState?.context;
    if (!context) {
      return;
    }

    if (button) {
      button.disabled = true;
    }
    try {
      const result = await root.EcoVilaSupabase.confirmReservationPayment(context.client, {
        reservationId: reservation.id,
        bookingGroupId: reservation.booking_group_id,
      });
      await activeState?.reload?.();
      showPaymentConfirmationResult(context, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Eroare necunoscută.';
      context.setAlert?.(`SMS-ul de confirmare nu a fost trimis: ${message.slice(0, 180)}`);
    } finally {
      if (button) {
        button.disabled = false;
      }
    }
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
    // A hold blocks its villa (so it counts as occupied above) but nobody is
    // arriving on it — it is a block, not a stay. The Situația zilnică tab shows
    // only paid reservations, and these two counters must agree with it.
    const confirmedReservations = activeReservations.filter((reservation) => {
      return !root.EcoVilaCrmCalendar.isTemporaryHold(reservation);
    });
    const arrivals = root.EcoVilaCrmCalendar.groupReservationRows(
      confirmedReservations.filter((reservation) => reservation.check_in === today),
    );
    const departures = root.EcoVilaCrmCalendar.groupReservationRows(
      confirmedReservations.filter((reservation) => reservation.check_out === today),
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

    state.suppressExtendUntil = Date.now() + CALENDAR_EXTEND_SUPPRESS_MS;
    calendar.scrollLeft = Math.max(0, index * calendarColumnWidth());
    updateCalendarMonthFromScroll(state);
  }

  function maybeExtendCalendarWindow(context, state) {
    const calendar = qs('[data-reservation-calendar]');
    if (!calendar || state.isLoading) {
      return;
    }

    // Ignore the synthetic scroll fired by our own repositioning (reload/jump),
    // otherwise landing near an edge would instantly re-extend the window.
    if (state.suppressExtendUntil && Date.now() < state.suppressExtendUntil) {
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
    // Reloads overlap (a staff action reloads while a realtime event schedules
    // its own), and they can finish out of order. Without this guard an older,
    // slower response could overwrite newer rooms/reservations and re-offer a
    // villa that has just been taken.
    const generation = (state.loadGeneration || 0) + 1;
    state.loadGeneration = generation;
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
      const [
        rooms,
        reservations,
        pending,
        todayReservations,
        pricingTiers,
        holidays,
        addReservations,
        holds,
      ] = await Promise.all([
        helpers.fetchRooms(context.client),
        helpers.fetchAdminReservations(context.client, { startDate: state.dates[0], endDate }),
        helpers.fetchPendingCashReservations(context.client),
        helpers.fetchAdminReservations(context.client, { startDate: todayWindowStart, endDate: todayWindowEnd }),
        helpers.fetchPricingTiers(context.client),
        helpers.fetchHolidays(context.client),
        helpers.fetchAdminReservations(context.client, { startDate: addAvailabilityStart, endDate: addAvailabilityEnd }),
        helpers.fetchTemporaryHolds(context.client),
      ]);

      // A newer reload started while these queries were in flight — its results
      // are the current truth, so drop these ones rather than rendering them.
      if (state.loadGeneration !== generation) {
        return;
      }

      state.rooms = rooms;
      state.reservations = root.EcoVilaCrmCalendar.sortReservations(reservations);
      state.todayReservations = root.EcoVilaCrmCalendar.sortReservations(todayReservations);
      state.pricingTiers = pricingTiers;
      state.holidays = holidays;
      state.addReservations = root.EcoVilaCrmCalendar.sortReservations(addReservations);
      state.addAvailabilityEnd = addAvailabilityEnd;
      renderCalendar(context, state);
      renderPendingCash(context, pending);
      renderTemporaryHolds(context, holds);
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
      // When true (Angela), the dashboard renders without drag-to-swap, mark-paid
      // or the reservation editor's write actions.
      readOnly: Boolean(context.permissions?.dashboardReadOnly),
      startDate: root.EcoVilaCrmCalendar.startOfMonth(today),
      focusDate: today,
      dates: buildCalendarWindowDates(today),
      shouldScrollToFocus: true,
      scrollToDateAfterReload: '',
      calendarScrollLeft: 0,
      currentVisibleDate: today,
      isLoading: false,
      // Debounce timer + cooldown for the scroll-driven month-window extension.
      extendTimer: null,
      suppressExtendUntil: 0,
      realtimeTimer: null,
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
      // The month label tracks the scroll live (cheap). Shifting the loaded window
      // is a network reload + full grid rebuild, so defer it until scrolling has
      // settled — this is what stops the calendar from stuttering or snapping back
      // mid-gesture (and mid-momentum on trackpads).
      updateCalendarMonthFromScroll(state);
      if (state.extendTimer) {
        root.clearTimeout(state.extendTimer);
      }
      state.extendTimer = root.setTimeout(() => {
        state.extendTimer = null;
        maybeExtendCalendarWindow(context, state);
      }, CALENDAR_EXTEND_DEBOUNCE_MS);
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

    // One realtime event per ROW: confirming or expiring a multi-villa booking
    // fires several within milliseconds, and each reload is seven queries wide
    // (including the two-year availability scan). Coalesce them into one.
    context.client
      .channel('crm-dashboard-reservations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, () => {
        if (state.realtimeTimer) {
          root.clearTimeout(state.realtimeTimer);
        }
        state.realtimeTimer = root.setTimeout(() => {
          state.realtimeTimer = null;
          state.reload().catch((error) => {
            context.setAlert(error?.message || 'Dashboardul nu s-a putut actualiza.');
          });
        }, REALTIME_RELOAD_DEBOUNCE_MS);
      })
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
    formatHoldCountdown,
    markPaid,
    openReservation,
    renderCalendar,
    renderTodayStats,
    renderPendingCash,
    renderTemporaryHolds,
    restoreCalendarScroll,
    scrollCalendarToDate,
  };
});
