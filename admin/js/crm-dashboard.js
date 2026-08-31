(function (root, factory) {
  const api = factory(root);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

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

  function bookingGroupRows(reservation) {
    const rows = activeState?.reservations || [];
    const groupId = reservation?.booking_group_id;
    const grouped = groupId
      ? rows.filter((row) => row.booking_group_id === groupId)
      : rows.filter((row) => row.id === reservation?.id);
    return grouped.length ? grouped : (reservation ? [reservation] : []);
  }

  function liveBookingRows(reservation) {
    const grouped = bookingGroupRows(reservation);
    const live = grouped.filter((row) => !root.EcoVilaCrmCalendar.isCancelled(row));
    return live.length ? live : (reservation ? [reservation] : []);
  }

  function differenceLinksForRows(rows, links, includeWholeGroup = true) {
    const reservations = Array.isArray(rows) ? rows : [];
    const ids = new Set(reservations.map((row) => row.id).filter(Boolean));
    const groupIds = includeWholeGroup
      ? new Set(reservations.map((row) => row.booking_group_id).filter(Boolean))
      : new Set();
    return (links || []).filter((link) =>
      link?.purpose === 'accommodation_difference' &&
      (ids.has(link.reservation_id) || (link.booking_group_id && groupIds.has(link.booking_group_id))));
  }

  function bookingMoney(reservation) {
    const allRows = bookingGroupRows(reservation);
    const rows = liveBookingRows(reservation);
    const links = differenceLinksForRows(allRows, activeState?.differenceLinks || []);
    const base = rows.reduce((sum, row) => sum + Number(row.total_price || 0), 0);
    const effective = root.EcoVilaCrmCalendar.effectiveTotal(allRows, links);
    const pending = root.EcoVilaCrmCalendar.pendingDifference(links);
    return {
      base,
      effective,
      links,
      paidDifference: Math.max(0, effective - base),
      pending,
      reliable: !activeState?.differenceLinksError,
      rows,
    };
  }

  function moveRoomLabel(room) {
    return root.EcoVilaCrmCalendar.roomLabel({
      room_number: room?.number,
      room_type: room?.type,
    });
  }

  function reservationCard(context, block, groupColorClass) {
    const reservation = block.primary;
    const guestFlag = root.EcoVilaCrmCalendar.guestFlagFor(
      reservation,
      activeState?.guestFlagIndex,
    );
    const blockLinks = differenceLinksForRows(
      block.reservations,
      activeState?.differenceLinks || [],
      false,
    );
    const baseTotal = block.reservations.reduce((sum, item) => sum + Number(item.total_price || 0), 0);
    const total = root.EcoVilaCrmCalendar.effectiveTotal(block.reservations, blockLinks);
    const paidDifference = Math.max(0, total - baseTotal);
    const pendingDifference = root.EcoVilaCrmCalendar.pendingDifference(blockLinks);
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
      guestFlag?.hasAttention ? 'crm-reservation-card--flagged-attention' : '',
      guestFlag?.hasVip ? 'crm-reservation-card--flagged-vip' : '',
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
    const paidDifferenceTitle = paidDifference > 0
      ? `Include ${context.formatMDL(paidDifference)} diferență de cazare achitată.`
      : '';
    card.innerHTML = `
      <strong>${escapeHtml(totalLabel)}</strong>
      ${paidDifference > 0 ? `<span class="crm-difference-marker" title="${escapeHtml(paidDifferenceTitle)}">+${escapeHtml(context.formatMDL(paidDifference))} diferență</span>` : ''}
      ${pendingDifference > 0 ? `<span class="crm-difference-marker crm-difference-marker--pending" title="Diferență de cazare neachitată">Neachitat: ${escapeHtml(context.formatMDL(pendingDifference))}</span>` : ''}
      <span>${guestSummary(reservation)}</span>
      <span class="crm-reservation-card__phone">${phone}</span>
      ${isHold ? `<span data-hold-countdown data-expires-at="${expiresAt}">${formatHoldCountdown(reservation.cash_expires_at)}</span>` : ''}
      ${!isHold && reservation.payment_type === 'cash' && reservation.payment_status === 'pending' ? `<span data-countdown data-expires-at="${expiresAt}">${formatCountdown(reservation.cash_expires_at)}</span>` : ''}
    `;
    if (guestFlag) {
      const severities = [
        ...(guestFlag.hasAttention ? ['attention'] : []),
        ...(guestFlag.hasVip ? ['vip'] : []),
      ];
      severities.forEach((severity) => {
        const label = root.EcoVilaCrmCalendar.GUEST_FLAG_LABELS[severity];
        const badge = root.document.createElement('button');
        badge.className = `crm-flag crm-flag--${severity}`;
        badge.type = 'button';
        badge.textContent = root.EcoVilaCrmCalendar.GUEST_FLAG_GLYPHS[severity];
        badge.setAttribute('aria-label', `Client cu notă: ${label}`);
        badge.title = `${label}: ${guestFlag.preview}`;
        badge.addEventListener('click', (event) => {
          event.stopPropagation();
          openReservation(reservation, { focusDossier: true });
        });
        card.appendChild(badge);
      });
    }
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
    state.reservationBlocks = blocks;
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

    const block = (state.reservationBlocks || []).find((item) => item.primary?.id === reservation.id);
    const cardHasOneAccommodation = block?.reservations.length === 1;
    // A contiguous card may span several accommodations while its drag payload
    // names only the primary reservation row. Moving that row would silently
    // split an ambiguous card, so choose the exact accommodation in the editor.
    if (!cardHasOneAccommodation) {
      context.setAlert('Cardul conține mai multe cazări. Mută una dintre ele din dialogul de editare.');
      return;
    }

    const sourceRoom = state.rooms.find((room) => room.id === reservation.room_id);
    const targetRoom = state.rooms.find((room) => room.id === cell.dataset.roomId);
    const targetReservation = state.reservations.find((item) => {
      return item.id !== reservation.id &&
        item.room_id === cell.dataset.roomId &&
        !root.EcoVilaCrmCalendar.isCancelled(item) &&
        item.check_in < reservation.check_out && reservation.check_in < item.check_out;
    });

    if (sourceRoom && targetRoom && sourceRoom.type !== targetRoom.type) {
      if (targetReservation) {
        context.setAlert('Cazarea de alt tip este ocupată în acest sejur. Alege o cazare liberă.');
        return;
      }
      openMoveDialog(reservation, targetRoom);
      return;
    }

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

  function showDossierError(dialog, message) {
    const error = qs('[data-dossier-error]', dialog);
    if (!error) {
      return;
    }
    error.textContent = message || '';
    error.hidden = !message;
  }

  function dossierDate(value) {
    const date = String(value || '').slice(0, 10);
    if (!date) {
      return '-';
    }
    if (activeState?.context?.formatDate) {
      return activeState.context.formatDate(date);
    }
    return date;
  }

  function updateDossierDirtyPhoneGuard(dialog, reservation) {
    const phoneInput = qs('[data-edit-phone]', dialog);
    const addButton = qs('[data-dossier-add]', dialog);
    const hint = qs('[data-dossier-hint]', dialog);
    const dirty = Boolean(phoneInput) &&
      String(phoneInput.value || '').trim() !== String(reservation.guest_phone || '').trim();
    if (addButton) {
      addButton.disabled = dirty;
    }
    if (hint) {
      hint.textContent = dirty
        ? 'Salvează întâi numărul de telefon — nota s-ar lega de numărul vechi.'
        : '';
      hint.hidden = !dirty;
    }
    return dirty;
  }

  function renderDossierNote(dialog, reservation, note) {
    const item = root.document.createElement('li');
    item.className = `crm-dossier__item crm-dossier__item--${note.severity}`;

    const body = root.document.createElement('p');
    body.className = 'crm-dossier__body';
    body.textContent = note.body || '';
    item.appendChild(body);

    const meta = root.document.createElement('div');
    meta.className = 'crm-dossier__meta';
    const detail = root.document.createElement('span');
    const label = root.EcoVilaCrmCalendar.GUEST_FLAG_LABELS[note.severity] || 'Notă';
    const source = (activeState?.reservations || []).find((row) => row.id === note.source_reservation_id);
    const sourceStay = source
      ? ` · sejur ${dossierDate(source.check_in)}–${dossierDate(source.check_out)}`
      : '';
    detail.textContent = `${label} · ${note.created_by_role || '-'} · ${dossierDate(note.created_at)}${sourceStay}`;
    meta.appendChild(detail);

    if (activeState?.context?.role === 'diana') {
      const archive = root.document.createElement('button');
      archive.className = 'crm-dossier__archive';
      archive.type = 'button';
      archive.textContent = 'Arhivează';
      archive.addEventListener('click', async () => {
        archive.disabled = true;
        showDossierError(dialog, '');
        try {
          await root.EcoVilaSupabase.archiveGuestNote(activeState.context.client, {
            id: note.id,
            archivedBy: activeState.context.session.user.id,
          });
          await renderGuestDossier(dialog, reservation);
          await activeState.reload?.();
        } catch (error) {
          showDossierError(dialog, error?.message || 'Nota nu a putut fi arhivată.');
        } finally {
          archive.disabled = false;
        }
      });
      meta.appendChild(archive);
    }

    item.appendChild(meta);
    return item;
  }

  async function renderGuestDossier(dialog, reservation, options = {}) {
    const panel = qs('[data-guest-dossier]', dialog);
    if (!panel) {
      return [];
    }
    const phone = String(reservation?.guest_phone || '').trim();
    const email = root.EcoVilaCrmCalendar.normalizeGuestEmail(reservation?.guest_email);
    const list = qs('[data-dossier-list]', panel);
    const count = qs('[data-dossier-count]', panel);
    const empty = qs('[data-dossier-empty]', panel);
    const body = qs('[data-dossier-body]', panel);
    const addButton = qs('[data-dossier-add]', panel);
    const phoneInput = qs('[data-edit-phone]', dialog);

    panel.hidden = !(phone || email);
    panel.dataset.reservationId = reservation?.id || '';
    if (!phone && !email) {
      if (list) list.innerHTML = '';
      if (count) count.textContent = '';
      return [];
    }

    showDossierError(dialog, '');
    if (list) list.innerHTML = '';
    if (empty) empty.hidden = true;
    if (body) body.disabled = false;
    qsa('[data-dossier-severity]', panel).forEach((field) => {
      field.disabled = false;
    });
    if (phoneInput) {
      phoneInput.oninput = () => updateDossierDirtyPhoneGuard(dialog, reservation);
    }
    updateDossierDirtyPhoneGuard(dialog, reservation);

    if (addButton) {
      addButton.onclick = async () => {
        const noteBody = String(body?.value || '').trim();
        const severity = qsa('[data-dossier-severity]', panel)
          .find((field) => field.checked)?.value || 'info';
        showDossierError(dialog, '');
        if (!noteBody) {
          showDossierError(dialog, 'Scrie nota înainte de a o adăuga.');
          return;
        }
        if (noteBody.length > 2000) {
          showDossierError(dialog, 'Nota poate avea cel mult 2000 de caractere.');
          return;
        }
        if (updateDossierDirtyPhoneGuard(dialog, reservation)) {
          return;
        }
        addButton.disabled = true;
        try {
          await root.EcoVilaSupabase.createGuestNote(activeState.context.client, {
            guestPhone: phone,
            guestEmail: email,
            severity,
            body: noteBody,
            sourceReservationId: reservation.id,
          });
          if (body) body.value = '';
          qsa('[data-dossier-severity]', panel).forEach((field) => {
            field.checked = field.value === 'info';
          });
          await renderGuestDossier(dialog, reservation);
          await activeState.reload?.();
        } catch (error) {
          showDossierError(dialog, error?.message || 'Nota nu a putut fi adăugată.');
        } finally {
          updateDossierDirtyPhoneGuard(dialog, reservation);
        }
      };
    }

    if (options.focusDossier) {
      panel.scrollIntoView?.({ block: 'nearest' });
      body?.focus?.();
    }

    try {
      const notes = await root.EcoVilaSupabase.fetchGuestNotes(activeState.context.client, {
        phone,
        email,
      });
      if (panel.dataset.reservationId !== reservation.id) {
        return [];
      }
      if (list) {
        list.innerHTML = '';
        notes.forEach((note) => list.appendChild(renderDossierNote(dialog, reservation, note)));
      }
      if (count) count.textContent = notes.length === 1 ? '1 notă' : `${notes.length} note`;
      if (empty) empty.hidden = notes.length > 0;
      return notes;
    } catch (error) {
      if (count) count.textContent = '0 note';
      if (empty) empty.hidden = false;
      showDossierError(dialog, error?.message || 'Istoricul clientului nu a putut fi încărcat.');
      return [];
    }
  }

  async function openReservation(reservation, options = {}) {
    if (!reservation) {
      return;
    }

    const stateRows = activeState?.reservations;
    if (Array.isArray(stateRows) && !stateRows.some((row) => row.id === reservation.id)) {
      try {
        const hydratedRows = await root.EcoVilaSupabase.fetchReservationGroupById(
          activeState.context.client,
          reservation.id,
        );
        const currentRows = Array.isArray(activeState?.reservations)
          ? activeState.reservations
          : stateRows;
        const byId = new Map(currentRows.map((row) => [row.id, row]));
        hydratedRows.forEach((row) => byId.set(row.id, row));
        activeState.reservations = root.EcoVilaCrmCalendar.sortReservations(Array.from(byId.values()));
        reservation = activeState.reservations.find((row) => row.id === reservation.id);
        if (!reservation) {
          throw new Error('Rezervarea nu a fost găsită.');
        }
      } catch (error) {
        activeState?.context?.setAlert?.(
          error?.message || 'Rezervarea completă nu a putut fi încărcată.',
        );
        return;
      }
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
    updateReservationDifferenceViews(dialog, reservation, options);
    const sendConfirmation = qs('[data-send-payment-confirmation]', dialog);
    if (sendConfirmation) {
      const canSendConfirmation = !readOnly && reservation.payment_type === 'cash' && reservation.payment_status === 'paid';
      sendConfirmation.hidden = !canSendConfirmation;
      sendConfirmation.onclick = canSendConfirmation ? () => sendPaymentConfirmation(reservation, sendConfirmation) : null;
    }

    // Read-only roles (Angela) open the dialog to inspect a reservation, but the
    // fields are locked and the save/cancel actions are removed. The server
    // rejects these writes too, so this is purely to keep the UI honest.
    qsa([
      '[data-edit-name]',
      '[data-edit-phone]',
      '[data-edit-check-in]',
      '[data-edit-check-out]',
      '[data-edit-adults]',
      '[data-edit-kids-ages]',
      '[data-edit-notes]',
    ].join(', '), dialog).forEach((field) => {
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
    const refundOverride = qs('[data-refund-full-override]', dialog);
    if (refundOverride) {
      refundOverride.checked = false;
      // EcoVila-caused cancellations (overbooking, force majeure or our own error)
      // must not make the guest absorb a bank fee they did nothing to cause.
      const rateBps = root.EcoVilaSupabase?.getActiveRefundCommissionBps?.();
      refundOverride.disabled = readOnly || !(Number.isInteger(rateBps) && rateBps > 0);
    }
    if (deleteButton) {
      deleteButton.onclick = readOnly ? null : () => deleteReservation(reservation, dialog);
    }

    setupPartialCancel(dialog, reservation, readOnly, isHold);
    setupMoveSection(dialog, reservation, readOnly, isHold);
    refreshRefundCommissionRate(activeState?.context, dialog, readOnly);
    const differenceLinksPromise = loadBookingDifferenceLinks(activeState?.context, reservation, dialog, options);

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
    const dossierPromise = renderGuestDossier(dialog, reservation, options);
    return Promise.all([differenceLinksPromise, dossierPromise]);
  }

  function updateDeleteDifferenceWarning(dialog, reservation) {
    const warning = qs('[data-delete-difference-warning]', dialog);
    if (!warning) return;
    const money = bookingMoney(reservation);
    if (!money.reliable) {
      warning.hidden = false;
      warning.textContent =
        'Atenție: diferențele de cazare nu au putut fi verificate — pot exista sume achitate prin link de plată care se restituie separat, din portalul MAIB.';
      return;
    }
    if (money.paidDifference > 0) {
      const formatMDL = activeState?.context?.formatMDL || root.EcoVilaCrmApp?.formatMDL || root.EcoVilaPricing?.formatMDL || ((amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL`);
      warning.hidden = false;
      warning.textContent =
        `Atenție: ${formatMDL(money.paidDifference)} achitați prin link de plată se restituie separat, din portalul MAIB.`;
      return;
    }
    warning.hidden = true;
    warning.textContent = '';
  }

  function updateReservationDifferenceViews(dialog, reservation, options = {}) {
    const money = bookingMoney(reservation);
    const formatMDL = activeState?.context?.formatMDL || root.EcoVilaCrmApp?.formatMDL || root.EcoVilaPricing?.formatMDL || ((amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL`);
    // Tests and out-of-calendar callers can still supply a group total without
    // dashboard state. In the live dashboard the loaded group rows and bound
    // links are always authoritative; a card block's subtotal is never reused
    // as the whole booking's total.
    const hasLoadedRows = Array.isArray(activeState?.reservations) && activeState.reservations.length > 0;
    const fallbackTotal = Number.isFinite(options.groupTotal)
      ? options.groupTotal
      : Number(reservation.total_price || 0);
    const totalEl = qs('[data-edit-total]', dialog);
    if (totalEl) {
      // When the difference read failed we show the booking price plainly rather
      // than labelling the total itself "unverified" — the destructive actions in
      // this dialog (delete, partial cancel) carry their own explicit warning, and
      // stamping every total was noise on the calendar.
      totalEl.textContent = hasLoadedRows
        ? money.reliable && money.paidDifference > 0
          ? `Preț efectiv: ${formatMDL(money.effective)}`
          : `Preț total: ${formatMDL(money.reliable ? money.effective : money.base)}`
        : `Preț total: ${formatMDL(fallbackTotal)}`;
    }
    const totalBreakdown = qs('[data-edit-total-breakdown]', dialog);
    if (totalBreakdown) {
      totalBreakdown.textContent = money.paidDifference > 0
        ? `Preț rezervare: ${formatMDL(money.base)} + diferență achitată: ${formatMDL(money.paidDifference)}`
        : `Preț rezervare: ${formatMDL(money.base)}`;
    }
    const pendingDifference = qs('[data-edit-pending-difference]', dialog);
    if (pendingDifference) {
      pendingDifference.hidden = money.reliable && money.pending <= 0;
      pendingDifference.textContent = !money.reliable
        ? 'Diferențele de cazare nu au putut fi verificate.'
        : money.pending > 0
        ? `Diferență neachitată: ${formatMDL(money.pending)}`
        : '';
    }

    updateDeleteDifferenceWarning(dialog, reservation);

    const partialSection = qs('[data-partial-cancel]', dialog);
    if (partialSection && !partialSection.hidden) {
      const candidates = partialCancelCandidates(reservation);
      const paidOnline = candidates.some((row) =>
        row.payment_type === 'card' && row.payment_status === 'paid');
      const paidTotal = partialCancelGroup(reservation).reduce((sum, row) => {
        return row.payment_status === 'paid' || row.cancelled_at
          ? sum + Number(row.total_price || 0)
          : sum;
      }, 0);
      const refundOverride = qs('[data-refund-full-override]', dialog);
      refreshPartialCancel(partialSection, {
        candidates,
        paidOnline,
        paidTotal,
        refundOverride,
      });
    }
  }

  function loadBookingDifferenceLinks(context, reservation, dialog, options) {
    if (
      !context?.client ||
      typeof root.EcoVilaSupabase?.fetchReservationDifferenceLinks !== 'function'
    ) {
      return Promise.resolve(null);
    }

    const groupRows = bookingGroupRows(reservation);
    const reservationIds = groupRows.map((r) => r.id).filter(Boolean);
    if (!reservationIds.length) {
      return Promise.resolve(null);
    }

    return root.EcoVilaSupabase.fetchReservationDifferenceLinks(context.client, { reservationIds })
      .then((fetchedLinks) => {
        const fetchedSet = new Set(reservationIds);
        const otherLinks = (activeState?.differenceLinks || []).filter(
          (link) => !fetchedSet.has(link.reservation_id)
        );
        if (activeState) {
          activeState.differenceLinks = [...otherLinks, ...(fetchedLinks || [])];
          activeState.differenceLinksError = null;
        }
        updateReservationDifferenceViews(dialog, reservation, options);
        return fetchedLinks;
      })
      .catch((error) => {
        if (activeState) {
          activeState.differenceLinksError = error || new Error('Citirea diferențelor de cazare a eșuat.');
        }
        updateReservationDifferenceViews(dialog, reservation, options);
      });
  }

  function refreshRefundCommissionRate(context, dialog, readOnly) {
    if (
      readOnly || root.EcoVilaSupabase?.getActiveRefundCommissionBps?.() !== null ||
      typeof root.EcoVilaSupabase?.fetchScheduledRefunds !== 'function'
    ) {
      return;
    }

    // Finance normally primes this staff-only configuration during app startup.
    // A very fast dialog open can win that race, so ask the same existing
    // endpoint and repaint when it answers; until then the UI shows no guessed
    // fee and keeps the meaningless override disabled.
    root.EcoVilaSupabase.fetchScheduledRefunds(context?.client).then(() => {
      const rateBps = root.EcoVilaSupabase?.getActiveRefundCommissionBps?.();
      const override = qs('[data-refund-full-override]', dialog);
      if (override) override.disabled = !(Number.isInteger(rateBps) && rateBps > 0);
      qs('[data-partial-amount]', dialog)?.oninput?.();
    }).catch(() => {
      // Unavailable configuration intentionally stays null: no invented line.
    });
  }

  // ── Anulare parțială (ADR-104) ──────────────────────────────────────────────
  // The guest gives up SOME villas of a booking and gets back a sum staff type by
  // hand. Everything below only prepares that call: one Edge Function performs
  // the cancellation, the refund and the guest notice together, because doing it
  // in three browser calls (the shape of "Șterge rezervarea" above) can strand a
  // booking half-cancelled if the tab closes in between.
  const PARTIAL_CONFIRM_WORD = 'anulez';

  // Every row of the opened booking, cancelled ones included. All rows of a group
  // share the stay dates, so they are either all inside the loaded calendar
  // window or all outside it — the list is never a partial view of the booking.
  function partialCancelGroup(reservation) {
    const rows = activeState?.reservations || [];
    const groupId = reservation.booking_group_id;
    return groupId
      ? rows.filter((row) => row.booking_group_id === groupId)
      : rows.filter((row) => row.id === reservation.id);
  }

  // Live villas of the opened booking, newest calendar state, lowest villa
  // number first so the list reads in room order.
  function partialCancelCandidates(reservation) {
    return partialCancelGroup(reservation)
      .filter((row) => !root.EcoVilaCrmCalendar.isCancelled(row))
      .sort((left, right) => {
        return Number(left.rooms?.number || 0) - Number(right.rooms?.number || 0) ||
          String(left.id).localeCompare(String(right.id));
      });
  }

  function setupPartialCancel(dialog, reservation, readOnly, isHold) {
    const section = qs('[data-partial-cancel]', dialog);
    if (!section) {
      return;
    }

    const candidates = partialCancelCandidates(reservation);
    // A hold is not a booking (it takes the release path), and a fully cancelled
    // reservation has nothing left to give up.
    const available = !readOnly && !isHold && candidates.length > 0;
    section.hidden = !available;
    if (!available) {
      // Drop the previous booking's submit handler with the section: it closes
      // over that booking's villas and would move money against it if the button
      // were ever reachable again.
      const staleSubmit = qs('[data-partial-submit]', section);
      if (staleSubmit) staleSubmit.onclick = null;
      return;
    }

    const body = qs('[data-partial-body]', section);
    const toggle = qs('[data-partial-toggle]', section);
    const list = qs('[data-partial-villas]', section);
    const amountField = qs('[data-partial-amount]', section);
    const confirmField = qs('[data-partial-confirm]', section);
    const errorField = qs('[data-partial-error]', section);
    const warning = qs('[data-partial-warning]', section);
    const submit = qs('[data-partial-submit]', section);
    const refundOverride = qs('[data-refund-full-override]', dialog);

    // Reopening the dialog must never inherit a previous booking's selection,
    // typed amount or confirmation word.
    if (body) body.hidden = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    if (amountField) amountField.value = '';
    if (confirmField) confirmField.value = '';
    if (errorField) {
      errorField.textContent = '';
      errorField.hidden = true;
    }
    if (submit) submit.disabled = false;

    const paidOnline = candidates.some((row) =>
      row.payment_type === 'card' && row.payment_status === 'paid');
    // Summed over the WHOLE booking group, cancelled villas included: the single
    // MAIB payment covered them all, so a villa dropped earlier without a refund
    // is still money sitting on that payment. Counting only the live villas
    // understated it and made the "what stays unrefundable" line too small.
    const paidTotal = partialCancelGroup(reservation).reduce((sum, row) => {
      return row.payment_status === 'paid' || row.cancelled_at
        ? sum + Number(row.total_price || 0)
        : sum;
    }, 0);

    if (amountField) {
      // Cash and office bookings have no online payment to reverse — the money
      // goes back over the counter, so the field would only invite a 409.
      amountField.disabled = !paidOnline;
      amountField.value = '';
    }
    if (warning) {
      warning.hidden = !paidOnline;
      warning.textContent =
        'MAIB permite o singură restituire per plată. După această operațiune, orice altă sumă din această rezervare se transferă manual.';
    }

    if (list) {
      list.innerHTML = '';
      candidates.forEach((row) => list.appendChild(partialVillaItem(row)));
    }

    const refresh = () => refreshPartialCancel(section, {
      candidates,
      paidOnline,
      paidTotal,
      refundOverride,
    });
    refresh();

    if (toggle) {
      toggle.onclick = () => {
        const open = body?.hidden;
        if (body) body.hidden = !open;
        toggle.setAttribute('aria-expanded', String(Boolean(open)));
      };
    }
    if (list) {
      list.onchange = refresh;
    }
    if (amountField) {
      amountField.oninput = refresh;
    }
    if (confirmField) {
      confirmField.oninput = refresh;
    }
    if (refundOverride) {
      refundOverride.onchange = refresh;
    }
    // The section lives inside the dialog's <form method="dialog">, so a stray
    // Enter would close the dialog mid-edit instead of doing nothing.
    qsa('input', section).forEach((field) => {
      field.onkeydown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
        }
      };
    });
    if (submit) {
      submit.onclick = () =>
        submitPartialCancel(dialog, section, { candidates, paidOnline, paidTotal, refundOverride });
    }
  }

  function partialVillaItem(reservation) {
    const item = root.document.createElement('li');
    const label = root.document.createElement('label');
    label.className = 'crm-partial__villa';

    const checkbox = root.document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = reservation.id;
    checkbox.dataset.partialVilla = reservation.id;
    checkbox.dataset.price = String(Number(reservation.total_price || 0));

    const main = root.document.createElement('span');
    main.className = 'crm-partial__villa-main';
    const name = root.document.createElement('span');
    name.className = 'crm-partial__villa-name';
    name.textContent = root.EcoVilaCrmCalendar.roomLabel(reservation);
    const dates = root.document.createElement('span');
    dates.className = 'crm-partial__villa-dates';
    dates.textContent = `${reservation.check_in} → ${reservation.check_out}`;
    main.append(name, dates);

    const price = root.document.createElement('span');
    price.className = 'crm-partial__villa-price';
    price.textContent = root.EcoVilaCrmApp.formatMDL(Number(reservation.total_price || 0));

    label.append(checkbox, main, price);
    item.appendChild(label);
    item.addEventListener('change', () => {
      label.classList.toggle('is-selected', checkbox.checked);
    });
    return item;
  }

  function partialSelection(section) {
    return qsa('[data-partial-villa]', section)
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => ({ id: checkbox.value, price: Number(checkbox.dataset.price || 0) }));
  }

  // null = no refund (an empty field, or a typed 0). NaN = the field holds
  // something that is not a number, which must block the action rather than
  // quietly read as "no refund": a number input reports garbage like "12e-" as
  // an EMPTY value, so a mistyped amount would otherwise cancel villas and
  // return nothing while the staff member believes they typed a sum.
  function partialRefundAmount(section) {
    const field = qs('[data-partial-amount]', section);
    if (!field || field.disabled) {
      return null;
    }
    if (field.validity?.badInput) {
      return NaN;
    }
    const raw = String(field.value || '').trim();
    if (!raw) {
      return null;
    }
    const amount = Number(raw);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
      return NaN;
    }
    return amount > 0 ? amount : null;
  }

  // Everything staff need to decide, restated as they type: how much of the stay
  // they picked, what the refund does to the money actually collected, and — the
  // part that cannot be undone — how much of it MAIB will never return again.
  function refreshPartialCancel(section, context) {
    const selected = partialSelection(section);
    const selectedTotal = selected.reduce((sum, row) => sum + row.price, 0);
    const amount = partialRefundAmount(section);
    const summary = qs('[data-partial-selected]', section);
    const hint = qs('[data-partial-hint]', section);
    const submit = qs('[data-partial-submit]', section);
    const confirmField = qs('[data-partial-confirm]', section);
    const formatMDL = root.EcoVilaCrmApp.formatMDL;
    const activeRateBps = root.EcoVilaSupabase?.getActiveRefundCommissionBps?.();
    const activeRate = Number.isInteger(activeRateBps) && activeRateBps > 0
      ? activeRateBps / 10000
      : null;
    const withholdCommission = activeRate !== null && !context.refundOverride?.checked;

    if (summary) {
      summary.textContent = selected.length
        ? `Selectate: ${selected.length} din ${context.candidates.length} · ${formatMDL(selectedTotal)}`
        : `Selectate: 0 din ${context.candidates.length}`;
    }

    if (hint) {
      if (Number.isNaN(amount)) {
        hint.textContent = 'Suma trebuie să fie un număr întreg de MDL — corecteaz-o sau golește câmpul.';
      } else if (!context.paidOnline) {
        hint.textContent =
          'Rezervarea nu are plată online — restituirea se face la birou, în numerar.';
      } else if (amount) {
        const rest = Math.max(0, Math.round(context.paidTotal) - amount);
        const net = withholdCommission
          ? Math.ceil(amount * (1 - activeRate))
          : amount;
        const withheld = amount - net;
        hint.textContent = amount > Math.round(context.paidTotal)
          // Not blocked here: total_price never includes a paid "add guests"
          // difference, so the real payment can legitimately be larger than the
          // stay total. The server checks it against the actual MAIB payment.
          ? `Atenție: ${formatMDL(amount)} depășește cei ${formatMDL(context.paidTotal)} din prețul rezervării. ` +
            'Verifică suma încasată în Finance înainte de a continua.'
          : `Restitui ${formatMDL(amount)} din ${formatMDL(context.paidTotal)} încasați · ` +
            (withholdCommission
              ? `comision reținut ${formatMDL(withheld)} · `
              : activeRate === null
              ? ''
              : 'restituire integrală, fără reținerea comisionului · ') +
            `clientul primește ${formatMDL(net)}. ` +
            `Restul de ${formatMDL(rest)} nu va mai putea fi restituit prin MAIB.`;
      } else {
        hint.textContent = `Încasat online: ${formatMDL(context.paidTotal)}. Lasă gol dacă nu restitui nimic.`;
      }
    }

    const diffWarning = qs('[data-partial-difference-warning]', section);
    if (diffWarning) {
      const reliable = !activeState?.differenceLinksError;
      if (!reliable) {
        diffWarning.hidden = false;
        diffWarning.textContent =
          'Atenție: diferențele de cazare nu au putut fi verificate — pot exista sume achitate prin link de plată care se restituie separat, din portalul MAIB.';
      } else {
        const selectedIds = new Set(selected.map((row) => row.id));
        const selectedLinks = (activeState?.differenceLinks || []).filter((link) =>
          link?.purpose === 'accommodation_difference' && selectedIds.has(link.reservation_id)
        );
        const selectedPaidDiff = selectedLinks.reduce((sum, link) => {
          return sum + (root.EcoVilaCrmCalendar?.boundLinkNet ? root.EcoVilaCrmCalendar.boundLinkNet(link) : 0);
        }, 0);
        if (selectedPaidDiff > 0) {
          diffWarning.hidden = false;
          diffWarning.textContent =
            `Atenție: ${formatMDL(selectedPaidDiff)} achitați prin link de plată se restituie separat, din portalul MAIB.`;
        } else {
          diffWarning.hidden = true;
          diffWarning.textContent = '';
        }
      }
    }

    if (submit) {
      const confirmed = String(confirmField?.value || '').trim().toLowerCase() === PARTIAL_CONFIRM_WORD;
      submit.disabled = !selected.length || !confirmed || Number.isNaN(amount);
      const net = amount && withholdCommission
        ? Math.ceil(amount * (1 - activeRate))
        : amount;
      submit.textContent = amount
        ? `Anulează și restituie ${formatMDL(net)}`
        : 'Anulează cazările selectate';
    }
  }

  async function submitPartialCancel(dialog, section, context) {
    const state = activeState;
    if (!state?.context?.client) {
      return;
    }

    const selected = partialSelection(section);
    const amount = partialRefundAmount(section);
    const errorField = qs('[data-partial-error]', section);
    const submit = qs('[data-partial-submit]', section);
    const showError = (message) => {
      if (!errorField) return;
      errorField.textContent = message || '';
      errorField.hidden = !message;
    };
    showError('');

    if (!selected.length) {
      showError('Bifează cel puțin o cazare.');
      return;
    }
    if (Number.isNaN(amount)) {
      showError('Suma de reversat trebuie să fie un număr întreg pozitiv (sau lasă câmpul gol).');
      return;
    }
    // Re-read the confirmation here, not just when the button was last enabled:
    // a failed attempt re-enables the button, and the word could have been
    // cleared (or the dialog reopened on another booking) in the meantime.
    const confirmWord = String(qs('[data-partial-confirm]', section)?.value || '')
      .trim()
      .toLowerCase();
    if (confirmWord !== PARTIAL_CONFIRM_WORD) {
      showError(`Scrie ${PARTIAL_CONFIRM_WORD} pentru a confirma.`);
      return;
    }

    if (submit) submit.disabled = true;
    try {
      const result = await root.EcoVilaSupabase.partialCancelReservation(state.context.client, {
        bookingGroupId: context.candidates[0]?.booking_group_id || '',
        reservationIds: selected.map((row) => row.id),
        refundAmount: amount,
        withholdCommission: !context.refundOverride?.checked,
      });
      dialog.close?.('cancel');
      state.context.setAlert?.(describePartialCancelResult(result, selected.length));
      await state.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Anularea parțială a eșuat.';
      showError(message.slice(0, 220));
      // Re-derive the button state rather than blindly enabling it: the
      // selection or the confirmation word may have changed while the request
      // was in flight.
      refreshPartialCancel(section, context);
    }
  }

  function describePartialCancelResult(result, cancelledCount) {
    const parts = [`${cancelledCount === 1 ? 'O cazare a fost anulată' : `${cancelledCount} cazări au fost anulate`}.`];

    if (result?.refund?.ok) {
      parts.push(`S-au restituit ${root.EcoVilaCrmApp.formatMDL(result.refund.amount)}.`);
    } else if (result?.refund) {
      parts.push('Restituirea nu s-a confirmat încă — sistemul o reîncearcă automat; verifică Finance.');
    }

    const notified = (result?.notificationResults || []).some((item) => item?.sent);
    if (!notified) {
      parts.push('Clientul NU a putut fi anunțat automat — sună-l.');
    }

    return parts.join(' ');
  }

  function moveTargetsFor(reservation) {
    return (activeState?.rooms || []).filter((room) => {
      if (!room?.id || room.id === reservation.room_id || room.is_active === false) {
        return false;
      }
      return !(activeState?.reservations || []).some((row) =>
        row.id !== reservation.id &&
        row.room_id === room.id &&
        !root.EcoVilaCrmCalendar.isCancelled(row) &&
        row.check_in < reservation.check_out && reservation.check_in < row.check_out);
    });
  }

  function setupMoveSection(dialog, reservation, readOnly, isHold) {
    const section = qs('[data-move-accommodation]', dialog);
    if (!section) return;

    const candidates = partialCancelCandidates(reservation);
    const available = !readOnly && !isHold && candidates.length > 0 &&
      typeof root.EcoVilaSupabase?.moveReservationAccommodation === 'function';
    section.hidden = !available;
    const openButton = qs('[data-move-open]', section);
    if (!available) {
      if (openButton) openButton.onclick = null;
      return;
    }

    const body = qs('[data-move-body]', section);
    const toggle = qs('[data-move-toggle]', section);
    const sourceSelect = qs('[data-move-source]', section);
    const targetSelect = qs('[data-move-target]', section);
    const status = qs('[data-move-picker-status]', section);
    if (body) body.hidden = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');

    if (sourceSelect) {
      sourceSelect.innerHTML = '';
      candidates.forEach((row) => {
        const option = root.document.createElement('option');
        option.value = row.id;
        option.textContent = root.EcoVilaCrmCalendar.roomLabel(row);
        sourceSelect.appendChild(option);
      });
      sourceSelect.value = candidates.some((row) => row.id === reservation.id)
        ? reservation.id
        : candidates[0].id;
    }

    const refreshTargets = () => {
      const selected = candidates.find((row) => row.id === sourceSelect?.value) || candidates[0];
      const targets = selected ? moveTargetsFor(selected) : [];
      if (targetSelect) {
        targetSelect.innerHTML = '';
        targets.forEach((room) => {
          const option = root.document.createElement('option');
          option.value = room.id;
          option.textContent = moveRoomLabel(room);
          targetSelect.appendChild(option);
        });
        targetSelect.disabled = targets.length === 0;
      }
      if (status) {
        status.textContent = targets.length
          ? `${targets.length} ${targets.length === 1 ? 'cazare liberă' : 'cazări libere'} pentru întregul sejur.`
          : 'Nu există nicio altă cazare liberă pentru întregul sejur.';
      }
      if (openButton) openButton.disabled = targets.length === 0;
    };
    refreshTargets();

    if (toggle) {
      toggle.onclick = () => {
        const open = Boolean(body?.hidden);
        if (body) body.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
      };
    }
    if (sourceSelect) sourceSelect.onchange = refreshTargets;
    if (openButton) {
      openButton.onclick = () => {
        const selected = candidates.find((row) => row.id === sourceSelect?.value);
        const target = (activeState?.rooms || []).find((room) => room.id === targetSelect?.value);
        if (!selected || !target) return;
        dialog.close?.('move');
        openMoveDialog(selected, target);
      };
    }
  }

  function moveTypeLabel(type) {
    return ({
      small: 'căsuță mică',
      large: 'căsuță mare',
      hotel: 'cameră în hotel',
    })[type] || 'cazare';
  }

  function isMoveDowngrade(sourceRoom, targetRoom) {
    const roomTypes = root.EcoVilaPricing?.ROOM_TYPES || {};
    const sourceCapacity = Number(roomTypes[sourceRoom?.type]?.maxAdults || 0);
    const targetCapacity = Number(roomTypes[targetRoom?.type]?.maxAdults || 0);
    return sourceCapacity > 0 && targetCapacity > 0 && targetCapacity < sourceCapacity;
  }

  function moveAmount(field) {
    if (!field || field.disabled) return null;
    if (field.validity?.badInput) return NaN;
    const raw = String(field.value || '').trim();
    if (!raw) return null;
    const amount = Number(raw);
    return Number.isInteger(amount) && amount >= 1 && amount <= 1000000 ? amount : NaN;
  }

  function showMoveError(dialog, message) {
    const field = qs('[data-move-error]', dialog);
    if (!field) return;
    field.textContent = message || '';
    field.hidden = !message;
  }

  function refreshMoveBilling(dialog) {
    const moveContext = dialog?._ecoVilaMove;
    if (!moveContext) return;
    const amountField = qs('[data-move-amount]', dialog);
    const withoutButton = qs('[data-move-without-difference]', dialog);
    const withButton = qs('[data-move-with-link]', dialog);
    const amount = moveAmount(amountField);
    const hasAmount = Number.isInteger(amount) && amount > 0;
    const invalid = Number.isNaN(amount);

    withoutButton?.classList.toggle('crm-button--primary', amount === null);
    withButton?.classList.toggle('crm-button--primary', hasAmount);
    if (withButton) {
      withButton.disabled = moveContext.billingDisabled || !hasAmount || invalid || moveContext.submitting;
      withButton.textContent = hasAmount
        ? `Mută și emite link (${root.EcoVilaCrmApp.formatMDL(amount)})`
        : 'Mută și emite link';
    }
    if (withoutButton) withoutButton.disabled = Boolean(moveContext.submitting);
    showMoveError(dialog, invalid
      ? 'Diferența trebuie să fie un număr întreg între 1 și 1.000.000 MDL.'
      : '');
  }

  function renderMoveSummary(dialog, reservation, sourceRoom, targetRoom) {
    const summary = qs('[data-move-summary]', dialog);
    if (!summary) return;
    const money = bookingMoney(reservation);
    const formatMDL = activeState?.context?.formatMDL || root.EcoVilaCrmApp?.formatMDL || root.EcoVilaPricing?.formatMDL || ((amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL`);
    const staying = money.rows
      .filter((row) => row.id !== reservation.id)
      .map((row) => root.EcoVilaCrmCalendar.roomLabel(row));
    const guest = root.EcoVilaCrmCalendar.guestName(reservation) || 'Client fără nume';
    const lines = [
      `Se mută: ${moveRoomLabel(sourceRoom)} → ${moveRoomLabel(targetRoom)}`,
      `Tip: ${moveTypeLabel(sourceRoom?.type)} → ${moveTypeLabel(targetRoom?.type)}`,
      `Rămân: ${staying.length ? staying.join(', ') : 'nicio altă cazare'}`,
      `Sejur: ${reservation.check_in} → ${reservation.check_out}`,
      `Client: ${guest}`,
      money.reliable
        ? `Preț efectiv rezervare: ${formatMDL(money.effective)}`
        : `Preț rezervare: ${formatMDL(money.base)}`,
      money.reliable
        ? (money.paidDifference > 0
            ? `Calcul: ${formatMDL(money.base)} + ${formatMDL(money.paidDifference)} diferență achitată`
            : `Preț rezervare: ${formatMDL(money.base)}`)
        : 'Diferențele de cazare nu au putut fi verificate.',
    ];
    if (money.reliable && money.pending > 0) {
      lines.push(`Diferență neachitată: ${formatMDL(money.pending)}`);
    }
    summary.innerHTML = '';
    lines.forEach((line) => {
      const paragraph = root.document.createElement('p');
      paragraph.textContent = line;
      summary.appendChild(paragraph);
    });
  }

  function renderMoveWarnings(dialog, reservation, targetRoom) {
    const capacityWarning = qs('[data-move-capacity-warning]', dialog);
    const roomType = root.EcoVilaPricing?.ROOM_TYPES?.[targetRoom?.type];
    const adults = Number(reservation.adults || 0);
    const kids = Array.isArray(reservation.kids_ages) ? reservation.kids_ages.length : 0;
    const overCapacity = Boolean(roomType) &&
      (adults > Number(roomType.maxAdults || 0) || kids > Number(roomType.maxKids || 0));
    if (capacityWarning) {
      capacityWarning.hidden = !overCapacity;
      capacityWarning.textContent = overCapacity
        ? `Atenție: rezervarea are ${adults} adulți și ${kids} copii, iar ${moveRoomLabel(targetRoom)} are capacitate de ${roomType.maxAdults} adulți și ${roomType.maxKids} copii. Mutarea rămâne permisă; verifică repartizarea oaspeților.`
        : '';
    }

    const reservationLinks = differenceLinksForRows(
      [reservation],
      activeState?.differenceLinks || [],
      false,
    );
    const pending = root.EcoVilaCrmCalendar.pendingDifference(reservationLinks);
    const linkWarning = qs('[data-move-existing-link]', dialog);
    if (linkWarning) {
      linkWarning.hidden = !activeState?.differenceLinksError && pending <= 0;
      linkWarning.textContent = activeState?.differenceLinksError
        ? 'Diferențele existente nu au putut fi verificate. Operația de mutare va aplica regulile serverului.'
        : pending > 0
        ? `Există deja o diferență neachitată de ${root.EcoVilaCrmApp.formatMDL(pending)} pentru această cazare. Mutarea o va revoca.`
        : '';
    }
  }

  function openMoveDialog(reservation, targetRoom) {
    const state = activeState;
    if (!reservation || !targetRoom || state?.context?.permissions?.dashboardReadOnly) return;
    const dialog = qs('[data-move-dialog]');
    const sourceRoom = (state?.rooms || []).find((room) => room.id === reservation.room_id) || reservation.rooms;
    if (!dialog || !sourceRoom || sourceRoom.id === targetRoom.id) return;

    const sameType = sourceRoom.type === targetRoom.type;
    const downgrade = isMoveDowngrade(sourceRoom, targetRoom);
    const unpaid = reservation.payment_status !== 'paid';
    const billingDisabled = sameType || downgrade || unpaid;
    dialog._ecoVilaMove = {
      reservation,
      sourceRoom,
      targetRoom,
      billingDisabled,
      submitting: false,
    };

    renderMoveSummary(dialog, reservation, sourceRoom, targetRoom);
    renderMoveWarnings(dialog, reservation, targetRoom);
    showMoveError(dialog, '');
    const amount = qs('[data-move-amount]', dialog);
    const rail = qs('[data-move-rail]', dialog);
    const expiry = qs('[data-move-expiry]', dialog);
    const label = qs('[data-move-label]', dialog);
    const notify = qs('[data-move-notify]', dialog);
    const billingNote = qs('[data-move-billing-note]', dialog);
    const resultBlock = qs('[data-move-link-result]', dialog);
    const actions = qs('[data-move-actions]', dialog);
    if (amount) amount.value = '';
    if (rail) rail.value = 'mia';
    if (expiry) expiry.value = '';
    if (label) label.value = moveRoomLabel(targetRoom);
    if (notify) notify.checked = false;
    [amount, rail, expiry, label].forEach((field) => {
      if (field) field.disabled = billingDisabled;
    });
    if (billingNote) {
      billingNote.textContent = downgrade
        ? 'Mutare către o cazare mai mică — diferența nu se poate factura; pentru restituire folosește Anulare parțială.'
        : sameType
        ? 'Tipul cazării nu se schimbă — mutarea se face fără diferență de plată.'
        : unpaid
        ? 'Diferența poate fi facturată numai pentru o rezervare achitată.'
        : 'Lasă suma goală pentru a muta fără emiterea unui link de plată.';
    }
    if (resultBlock) resultBlock.hidden = true;
    if (actions) actions.hidden = false;
    refreshMoveBilling(dialog);

    if (amount) amount.oninput = () => refreshMoveBilling(dialog);
    const cancel = qs('[data-move-cancel]', dialog);
    if (cancel) cancel.onclick = () => dialog.close?.('cancel');
    const withoutButton = qs('[data-move-without-difference]', dialog);
    const withButton = qs('[data-move-with-link]', dialog);
    if (withoutButton) withoutButton.onclick = () => submitMove(dialog, null);
    if (withButton) withButton.onclick = () => submitMove(dialog, moveAmount(amount));
    const form = qs('[data-move-form]', dialog);
    if (form) form.onsubmit = (event) => event.preventDefault();
    const copy = qs('[data-move-copy]', dialog);
    const url = qs('[data-move-link-url]', dialog);
    if (copy) copy.onclick = () => copyMoveLink(url?.value || '', copy, url);
    const resultClose = qs('[data-move-result-close]', dialog);
    if (resultClose) resultClose.onclick = () => dialog.close?.('done');
    dialog.showModal?.();
  }

  function movePaymentUrl(result) {
    // The server builds the canonical URL from ECOVILA_SITE_URL; prefer it always.
    // The origin-relative fallback below is only for an older deployed function
    // and would hand staff a localhost/staging link if the CRM is not on the
    // production host.
    if (result?.payUrl) return result.payUrl;
    if (result?.link?.payUrl) return result.link.payUrl;
    const linkId = result?.linkId || result?.link?.id;
    if (!linkId) return '';
    const relative = `/plata.html?p=${encodeURIComponent(linkId)}`;
    try {
      return new URL(relative, root.location?.origin || root.location?.href).toString();
    } catch (_error) {
      return relative;
    }
  }

  async function copyMoveLink(text, button, input) {
    let copied = false;
    if (root.navigator?.clipboard?.writeText) {
      try {
        await root.navigator.clipboard.writeText(text);
        copied = true;
      } catch (_error) {
        copied = false;
      }
    }
    if (!copied && input) {
      try {
        input.focus?.();
        input.select?.();
        copied = Boolean(root.document?.execCommand?.('copy'));
      } catch (_error) {
        copied = false;
      }
    }
    if (button && copied) {
      const originalText = button.textContent;
      button.textContent = 'Copiat!';
      root.setTimeout?.(() => {
        button.textContent = originalText;
      }, 2000);
    } else if (!copied) {
      input?.select?.();
    }
  }

  async function submitMove(dialog, requestedAmount) {
    const state = activeState;
    const moveContext = dialog?._ecoVilaMove;
    if (!state?.context?.client || !moveContext || moveContext.submitting) return;
    if (Number.isNaN(requestedAmount)) {
      showMoveError(dialog, 'Diferența trebuie să fie un număr întreg între 1 și 1.000.000 MDL.');
      return;
    }
    if (requestedAmount && moveContext.billingDisabled) {
      showMoveError(dialog, 'Diferența nu poate fi emisă pentru această mutare.');
      return;
    }

    moveContext.submitting = true;
    refreshMoveBilling(dialog);
    showMoveError(dialog, '');
    try {
      const input = {
        reservationId: moveContext.reservation.id,
        expectedSourceRoomId: moveContext.sourceRoom.id,
        targetRoomId: moveContext.targetRoom.id,
        notify: qs('[data-move-notify]', dialog)?.checked === true,
      };
      if (requestedAmount) {
        input.amount = requestedAmount;
        input.paymentRail = qs('[data-move-rail]', dialog)?.value || 'mia';
        const expiry = String(qs('[data-move-expiry]', dialog)?.value || '');
        input.expiresInHours = expiry ? Number(expiry) : null;
        input.label = String(qs('[data-move-label]', dialog)?.value || '').trim() || null;
      }
      const result = await root.EcoVilaSupabase.moveReservationAccommodation(
        state.context.client,
        input,
      );
      let reloadNotice = '';
      try {
        await state.reload();
      } catch (_reloadError) {
        reloadNotice = ' Calendarul nu s-a putut reîncărca — apasă Reîmprospătează.';
      }

      const payUrl = movePaymentUrl(result);
      const notice = result?.smsSent
        ? ' Clientul a fost anunțat prin SMS.'
        : input.notify
        ? ' SMS-ul nu a putut fi trimis — anunță clientul manual.'
        : '';
      if (payUrl) {
        const resultBlock = qs('[data-move-link-result]', dialog);
        const url = qs('[data-move-link-url]', dialog);
        const actions = qs('[data-move-actions]', dialog);
        if (url) url.value = payUrl;
        if (resultBlock) resultBlock.hidden = false;
        if (actions) actions.hidden = true;
        state.context.setAlert?.(`Cazarea a fost mutată și linkul de plată a fost emis.${notice}${reloadNotice}`);
      } else {
        dialog.close?.('moved');
        state.context.setAlert?.(`Cazarea a fost mutată fără diferență de plată.${notice}${reloadNotice}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mutarea cazării a eșuat.';
      showMoveError(dialog, message.slice(0, 220));
      moveContext.submitting = false;
      refreshMoveBilling(dialog);
    }
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

  async function deleteReservation(reservation, dialog) {
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
        const refundResult = await root.EcoVilaSupabase.refundMaibPaymentRequest(context.client, {
          bookingGroupId: reservation.booking_group_id,
          reason: 'crm_cancellation',
          withholdCommission: !qs('[data-refund-full-override]', dialog)?.checked,
        });
        if (refundResult?.ok === false && refundResult?.pending) {
          alert = String(refundResult.message ||
            'Restituirea nu s-a confirmat încă — va fi reîncercată automat; verifică tab-ul plăți.');
          if (refundResult?.partial) {
            alert = `Restituire parțial confirmată: ${alert}`;
          }
        }
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

  // A reload fires on every realtime event, and most finish in well under a
  // frame's worth of perceptible time. Painting a spinner for each one would
  // strobe the calendar, so the overlay is armed on a delay and only appears when
  // a load actually drags. The very first paint is the exception: there is
  // nothing on screen yet, so waiting would just show an empty grid.
  const CALENDAR_LOADER_DELAY_MS = 250;
  let calendarLoaderTimer = null;

  function setCalendarLoading(state, loading) {
    const calendar = qs('[data-reservation-calendar]');
    if (calendar) {
      calendar.setAttribute('aria-busy', loading ? 'true' : 'false');
    }

    const loader = qs('[data-calendar-loader]');
    if (!loader) {
      return;
    }

    root.clearTimeout(calendarLoaderTimer);
    calendarLoaderTimer = null;

    if (!loading) {
      loader.hidden = true;
      return;
    }

    if (!state?.rooms?.length) {
      loader.hidden = false;
      return;
    }

    calendarLoaderTimer = root.setTimeout(() => {
      loader.hidden = false;
    }, CALENDAR_LOADER_DELAY_MS);
  }

  async function loadDashboard(context, state) {
    const helpers = root.EcoVilaSupabase;
    captureCalendarScroll(state);
    state.isLoading = true;
    setCalendarLoading(state, true);
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
        guestFlagMarkers,
      ] = await Promise.all([
        helpers.fetchRooms(context.client),
        helpers.fetchAdminReservations(context.client, { startDate: state.dates[0], endDate }),
        helpers.fetchPendingCashReservations(context.client),
        helpers.fetchAdminReservations(context.client, { startDate: todayWindowStart, endDate: todayWindowEnd }),
        helpers.fetchPricingTiers(context.client),
        helpers.fetchHolidays(context.client),
        helpers.fetchAdminReservations(context.client, { startDate: addAvailabilityStart, endDate: addAvailabilityEnd }),
        helpers.fetchTemporaryHolds(context.client),
        typeof helpers.fetchGuestFlagMarkers === 'function'
          ? helpers.fetchGuestFlagMarkers(context.client).catch(() => [])
          : Promise.resolve([]),
      ]);

      const reservationIds = reservations.map((reservation) => reservation.id).filter(Boolean);
      let differenceLinks = [];
      let differenceLinksError = null;
      if (reservationIds.length && typeof helpers.fetchReservationDifferenceLinks === 'function') {
        try {
          differenceLinks = await helpers.fetchReservationDifferenceLinks(context.client, {
            reservationIds,
          });
        } catch (error) {
          differenceLinksError = error || new Error('Citirea diferențelor de cazare a eșuat.');
        }
      }

      // A newer reload started while these queries were in flight — its results
      // are the current truth, so drop these ones rather than rendering them.
      if (state.loadGeneration !== generation) {
        return;
      }

      state.rooms = rooms;
      state.reservations = root.EcoVilaCrmCalendar.sortReservations(reservations);
      state.differenceLinks = differenceLinks || [];
      state.differenceLinksError = differenceLinksError;
      state.todayReservations = root.EcoVilaCrmCalendar.sortReservations(todayReservations);
      state.pricingTiers = pricingTiers;
      state.holidays = holidays;
      state.addReservations = root.EcoVilaCrmCalendar.sortReservations(addReservations);
      state.guestFlagIndex = root.EcoVilaCrmCalendar.buildGuestFlagIndex(guestFlagMarkers);
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
      // Only the newest load owns the overlay. An older, slower reload finishing
      // second must not clear the spinner a newer one is still waiting on.
      if (state.loadGeneration === generation) {
        setCalendarLoading(state, false);
      }
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
      reservationBlocks: [],
      differenceLinks: [],
      differenceLinksError: null,
      todayReservations: [],
      pricingTiers: [],
      holidays: [],
      addReservations: [],
      guestFlagIndex: root.EcoVilaCrmCalendar.buildGuestFlagIndex([]),
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
    const scheduleRealtimeReload = () => {
      if (state.realtimeTimer) {
        root.clearTimeout(state.realtimeTimer);
      }
      state.realtimeTimer = root.setTimeout(() => {
        state.realtimeTimer = null;
        state.reload().catch((error) => {
          context.setAlert(error?.message || 'Dashboardul nu s-a putut actualiza.');
        });
      }, REALTIME_RELOAD_DEBOUNCE_MS);
    };
    context.client
      .channel('crm-dashboard-reservations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, scheduleRealtimeReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payment_links' }, scheduleRealtimeReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'guest_notes' }, scheduleRealtimeReload)
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
    moveAmount,
    openMoveDialog,
    openReservation,
    renderGuestDossier,
    renderCalendar,
    renderMoveSummary,
    renderTodayStats,
    renderPendingCash,
    renderTemporaryHolds,
    restoreCalendarScroll,
    scrollCalendarToDate,
  };
});
