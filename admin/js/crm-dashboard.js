(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmDashboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

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

  function formatMonthLabel(date) {
    const formatted = new Intl.DateTimeFormat('ro-MD', {
      month: 'long',
      year: 'numeric',
    }).format(new Date(`${root.EcoVilaCrmCalendar.startOfMonth(date)}T00:00:00Z`));
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
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
      return `
        <article class="crm-pending-card" data-pending-group="${group.bookingGroupId}">
          <strong>${root.EcoVilaCrmCalendar.guestName(reservation) || 'Fără nume'}</strong>
          <span>${group.roomLabel}</span>
          <span>Cash · ${context.formatMDL(group.totalPrice)}</span>
          <span data-countdown data-expires-at="${group.cash_expires_at}">${formatCountdown(group.cash_expires_at)}</span>
          <button class="crm-button crm-button--primary crm-button--small" type="button" data-mark-paid="${reservation.id}" data-mark-paid-group="${group.bookingGroupId}">
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

  function reservationCard(block) {
    const reservation = block.primary;
    const name = root.EcoVilaCrmCalendar.guestName(reservation) || 'Fără nume';
    const card = root.document.createElement('article');
    card.className = [
      'crm-reservation-card',
      'crm-reservation-card--block',
      block.rowSpan > 1 ? 'crm-reservation-card--multi-row' : '',
      groupCardClass(block),
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
      <strong>${name}</strong>
      <span>${guestSummary(reservation)}</span>
      <span class="crm-reservation-card__phone">${root.EcoVilaCrmCalendar.formatCalendarPhone(reservation.guest_phone)}</span>
      ${reservation.payment_type === 'cash' && reservation.payment_status === 'pending' ? `<span data-countdown data-expires-at="${reservation.cash_expires_at}">${formatCountdown(reservation.cash_expires_at)}</span>` : ''}
    `;
    card.addEventListener('click', () => openReservation(reservation));
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

    root.EcoVilaCrmCalendar
      .buildReservationBlocks(state.reservations, state.rooms, dates, {
        showCancelled: qs('[data-show-cancelled]')?.checked,
      })
      .forEach((block) => {
        grid.appendChild(reservationCard(block));
      });

    setText('[data-calendar-range]', formatMonthLabel(state.startDate));
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

  function openReservation(reservation) {
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
    qs('[data-edit-payment]', dialog).textContent = `Tip plată: ${reservation.payment_type} · ${reservation.payment_status}`;
    qs('[data-edit-total]', dialog).textContent = `Preț total: ${root.EcoVilaCrmApp.formatMDL(reservation.total_price)}`;
    qs('[data-delete-reservation]', dialog).onclick = () => deleteReservation(reservation);
    dialog.showModal?.();
  }

  async function deleteReservation(reservation) {
    const confirm = qs('[data-delete-confirm]')?.value?.trim();
    if (confirm !== 'sterge') {
      activeState?.context?.setAlert('Tastează sterge pentru ștergere.');
      return;
    }

    await root.EcoVilaSupabase.updateReservation(activeState.context.client, reservation.id, {
      payment_status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancellation_reason: 'Anulat din CRM',
    });
    await activeState.reload();
  }

  async function markPaid(context, reservationId, bookingGroupId) {
    const values = {
      payment_status: 'paid',
      cash_expires_at: null,
    };
    if (bookingGroupId) {
      await root.EcoVilaSupabase.updateReservationGroup(context.client, bookingGroupId, values);
    } else {
      await root.EcoVilaSupabase.updateReservation(context.client, reservationId, values);
    }
    await activeState?.reload?.();
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

    const rootStyles = root.getComputedStyle?.(root.document.documentElement);
    const columnWidth = Number.parseFloat(rootStyles?.getPropertyValue('--crm-day-column-width')) || 240;
    calendar.scrollLeft = Math.max(0, index * columnWidth);
  }

  async function loadDashboard(context, state) {
    const helpers = root.EcoVilaSupabase;
    state.today = root.EcoVilaCrmCalendar.todayISO();
    state.startDate = root.EcoVilaCrmCalendar.startOfMonth(state.startDate);
    state.dates = root.EcoVilaCrmCalendar.enumerateMonthDates(state.startDate);
    const endDate = root.EcoVilaCrmCalendar.addDays(state.dates[state.dates.length - 1], 1);
    const todayWindowStart = root.EcoVilaCrmCalendar.addDays(state.today, -1);
    const todayWindowEnd = root.EcoVilaCrmCalendar.addDays(state.today, 1);
    const [rooms, reservations, pending, todayReservations] = await Promise.all([
      helpers.fetchRooms(context.client),
      helpers.fetchAdminReservations(context.client, { startDate: state.startDate, endDate }),
      helpers.fetchPendingCashReservations(context.client),
      helpers.fetchAdminReservations(context.client, { startDate: todayWindowStart, endDate: todayWindowEnd }),
    ]);
    state.rooms = rooms;
    state.reservations = root.EcoVilaCrmCalendar.sortReservations(reservations);
    state.todayReservations = root.EcoVilaCrmCalendar.sortReservations(todayReservations);
    renderCalendar(context, state);
    renderPendingCash(context, pending);
    renderTodayStats(state);
    scrollCalendarToDate(state, state.focusDate || state.today);
  }

  function init(context) {
    const today = root.EcoVilaCrmCalendar.todayISO();
    const state = {
      context,
      today,
      startDate: root.EcoVilaCrmCalendar.startOfMonth(today),
      focusDate: today,
      dates: root.EcoVilaCrmCalendar.enumerateMonthDates(today),
      rooms: [],
      reservations: [],
      todayReservations: [],
      reload: () => loadDashboard(context, state),
      openReservation,
    };
    activeState = state;

    qs('[data-refresh-pending]')?.addEventListener('click', state.reload);
    qs('[data-calendar-prev]')?.addEventListener('click', () => {
      state.startDate = root.EcoVilaCrmCalendar.addMonths(state.startDate, -1);
      state.focusDate = state.startDate;
      state.reload();
    });
    qs('[data-calendar-next]')?.addEventListener('click', () => {
      state.startDate = root.EcoVilaCrmCalendar.addMonths(state.startDate, 1);
      state.focusDate = state.startDate;
      state.reload();
    });
    qs('[data-calendar-today]')?.addEventListener('click', () => {
      state.today = root.EcoVilaCrmCalendar.todayISO();
      state.startDate = root.EcoVilaCrmCalendar.startOfMonth(state.today);
      state.focusDate = state.today;
      state.reload();
    });
    qs('[data-calendar-jump-date]')?.addEventListener('change', (event) => {
      const targetDate = event.target.value;
      if (!targetDate) {
        return;
      }
      state.startDate = root.EcoVilaCrmCalendar.startOfMonth(targetDate);
      state.focusDate = targetDate;
      state.reload();
    });
    qs('[data-show-cancelled]')?.addEventListener('change', () => renderCalendar(context, state));
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
    init,
    markPaid,
    openReservation,
    renderCalendar,
    renderTodayStats,
    renderPendingCash,
    scrollCalendarToDate,
  };
});
