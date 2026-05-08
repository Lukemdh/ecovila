(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmDashboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const VISIBLE_DAYS = 14;

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function createCell(className, text) {
    const cell = root.document.createElement('div');
    cell.className = `crm-calendar-cell ${className || ''}`.trim();
    if (text) {
      cell.textContent = text;
    }
    return cell;
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

    if (!reservations?.length) {
      list.innerHTML = '<p class="crm-empty">Nu sunt plăți cash în așteptare.</p>';
      return;
    }

    list.innerHTML = reservations.map((reservation) => {
      const room = root.EcoVilaCrmCalendar.roomLabel(reservation);
      return `
        <article class="crm-pending-card" data-pending-id="${reservation.id}">
          <strong>${room}</strong>
          <span>Cash · ${context.formatMDL(reservation.total_price)}</span>
          <span data-countdown>${formatCountdown(reservation.cash_expires_at)}</span>
          <button class="crm-button crm-button--primary crm-button--small" type="button" data-mark-paid="${reservation.id}">
            Marchează ca plătit
          </button>
        </article>
      `;
    }).join('');

    list.querySelectorAll('[data-mark-paid]').forEach((button) => {
      button.addEventListener('click', () => markPaid(context, button.dataset.markPaid));
    });
  }

  function reservationCard(reservation) {
    const name = root.EcoVilaCrmCalendar.guestName(reservation) || 'Fără nume';
    const card = root.document.createElement('article');
    card.className = `crm-reservation-card ${root.EcoVilaCrmCalendar.getCardClass(reservation)}`;
    card.draggable = true;
    card.dataset.reservationId = reservation.id;
    card.dataset.roomId = reservation.room_id || '';
    card.dataset.roomExplicitlySelected = String(Boolean(reservation.room_explicitly_selected));
    card.innerHTML = `
      <strong>${name}</strong>
      <span>${reservation.guest_phone || ''}</span>
      ${reservation.payment_type === 'cash' && reservation.payment_status === 'pending' ? `<span>${formatCountdown(reservation.cash_expires_at)}</span>` : ''}
    `;
    card.addEventListener('click', () => openReservation(reservation));
    return card;
  }

  let activeState = null;

  function renderCalendar(context, state) {
    const grid = qs('[data-calendar-grid]');
    if (!grid) {
      return;
    }

    const dates = root.EcoVilaCrmCalendar.enumerateDates(state.startDate, VISIBLE_DAYS);
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `var(--crm-room-column-width) repeat(${dates.length}, var(--crm-day-column-width))`;
    grid.appendChild(createCell('crm-calendar-cell--head'));

    dates.forEach((date) => {
      grid.appendChild(createCell('crm-calendar-cell--head', context.formatDate(date)));
    });

    state.rooms.forEach((room) => {
      grid.appendChild(createCell('crm-calendar-cell--room', String(room.number)));
      dates.forEach((date) => {
        const cell = createCell();
        cell.dataset.roomId = room.id;
        cell.dataset.date = date;
        const reservations = state.reservations.filter((reservation) => {
          return reservation.room_id === room.id && root.EcoVilaCrmCalendar.overlapsDate(reservation, date);
        });

        reservations.forEach((reservation) => {
          if (reservation.payment_status !== 'cancelled' || qs('[data-show-cancelled]')?.checked) {
            cell.appendChild(reservationCard(reservation));
          }
        });

        cell.addEventListener('dragover', (event) => event.preventDefault());
        cell.addEventListener('drop', (event) => handleDrop(context, state, event, cell));
        grid.appendChild(cell);
      });
    });
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

  async function markPaid(context, reservationId) {
    await root.EcoVilaSupabase.updateReservation(context.client, reservationId, {
      payment_status: 'paid',
      cash_expires_at: null,
    });
    await activeState?.reload?.();
  }

  async function loadDashboard(context, state) {
    const helpers = root.EcoVilaSupabase;
    const endDate = root.EcoVilaCrmCalendar.addDays(state.startDate, VISIBLE_DAYS);
    const [rooms, reservations, pending] = await Promise.all([
      helpers.fetchRooms(context.client),
      helpers.fetchAdminReservations(context.client, { startDate: state.startDate, endDate }),
      helpers.fetchPendingCashReservations(context.client),
    ]);
    state.rooms = rooms;
    state.reservations = root.EcoVilaCrmCalendar.sortReservations(reservations);
    renderCalendar(context, state);
    renderPendingCash(context, pending);
  }

  function init(context) {
    const today = new Date().toISOString().slice(0, 10);
    const state = {
      context,
      startDate: today,
      rooms: [],
      reservations: [],
      reload: () => loadDashboard(context, state),
      openReservation,
    };
    activeState = state;

    qs('[data-refresh-pending]')?.addEventListener('click', state.reload);
    qs('[data-calendar-prev]')?.addEventListener('click', () => {
      state.startDate = root.EcoVilaCrmCalendar.addDays(state.startDate, -VISIBLE_DAYS);
      state.reload();
    });
    qs('[data-calendar-next]')?.addEventListener('click', () => {
      state.startDate = root.EcoVilaCrmCalendar.addDays(state.startDate, VISIBLE_DAYS);
      state.reload();
    });
    qs('[data-show-cancelled]')?.addEventListener('change', () => renderCalendar(context, state));

    root.document.addEventListener('dragstart', (event) => {
      const card = event.target.closest?.('[data-reservation-id]');
      if (card) {
        event.dataTransfer.setData('text/plain', card.dataset.reservationId);
      }
    });

    root.EcoVilaCrmSidebar?.init?.(context, state);
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
    renderPendingCash,
  };
});
