(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmDaily = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const DAILY_STATUS_TABLE = 'crm_daily_statuses';

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

  function buildDailyCard(context, state, reservation, type, status) {
    const card = root.document.createElement('article');
    const completed = type === 'in' ? Boolean(status.checked_in_at) : Boolean(status.checked_out_at);
    card.className = `crm-daily-card ${completed ? 'is-complete' : ''}`;
    card.innerHTML = `
      <span>${root.EcoVilaCrmCalendar.roomLabel(reservation)}</span>
      <strong>${root.EcoVilaCrmCalendar.guestName(reservation)}</strong>
      <span>${reservation.guest_phone || ''}</span>
    `;

    if (!completed) {
      const button = root.document.createElement('button');
      button.type = 'button';
      button.className = 'crm-button crm-button--primary crm-button--small';
      button.textContent = type === 'in' ? 'S-a cazat' : 'A plecat';
      button.addEventListener('click', () => {
        if (type === 'out') {
          openCheckoutNote(context, state, reservation);
        } else {
          saveDailyStatus(context, state, reservation, { checked_in_at: new Date().toISOString() });
        }
      });
      card.appendChild(button);
    }

    return card;
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
    const cards = reservations.map((reservation) => {
      const status = statusFor(statuses, reservation.id);
      return {
        reservation,
        status,
        completed: type === 'in' ? Boolean(status.checked_in_at) : Boolean(status.checked_out_at),
      };
    });

    const sorted = sortByRoomWithCompletedLast(cards);
    container.innerHTML = '';

    if (!sorted.length) {
      container.innerHTML = '<p class="crm-empty">Nu sunt rezervări pentru această secțiune.</p>';
      return;
    }

    sorted.forEach((item) => {
      container.appendChild(buildDailyCard(context, state, item.reservation, type, item.status));
    });
  }

  async function loadDaily(context, state) {
    const nextDay = root.EcoVilaCrmCalendar.addDays(state.selectedDate, 1);
    const previousDay = root.EcoVilaCrmCalendar.addDays(state.selectedDate, -1);
    const reservations = await root.EcoVilaSupabase.fetchAdminReservations(context.client, {
      startDate: previousDay,
      endDate: nextDay,
    });
    const checkIns = reservations.filter((reservation) => reservation.check_in === state.selectedDate);
    const checkOuts = reservations.filter((reservation) => reservation.check_out === state.selectedDate);
    const ids = [...checkIns, ...checkOuts].map((reservation) => reservation.id);
    const statuses = await root.EcoVilaSupabase.fetchDailyStatuses(context.client, state.selectedDate, ids);

    qs('[data-daily-date-button]').textContent = context.formatDate(state.selectedDate);
    renderSection(context, state, qs('[data-check-ins]'), checkIns, statuses, 'in');
    renderSection(context, state, qs('[data-check-outs]'), checkOuts, statuses, 'out');
  }

  function init(context) {
    const state = {
      selectedDate: new Date().toISOString().slice(0, 10),
    };

    const dateInput = qs('[data-daily-date]');
    qs('[data-daily-date-button]')?.addEventListener('click', () => {
      dateInput.hidden = false;
      dateInput.showPicker?.();
    });
    dateInput?.addEventListener('change', () => {
      state.selectedDate = dateInput.value || state.selectedDate;
      loadDaily(context, state);
    });
    qs('[data-daily-prev]')?.addEventListener('click', () => {
      state.selectedDate = root.EcoVilaCrmCalendar.addDays(state.selectedDate, -1);
      loadDaily(context, state);
    });
    qs('[data-daily-next]')?.addEventListener('click', () => {
      state.selectedDate = root.EcoVilaCrmCalendar.addDays(state.selectedDate, 1);
      loadDaily(context, state);
    });

    loadDaily(context, state).catch((error) => context.setAlert(error?.message || 'Situația zilnică nu s-a putut încărca.'));
  }

  return {
    DAILY_STATUS_TABLE,
    init,
    loadDaily,
    saveDailyStatus,
    sortByRoomWithCompletedLast,
  };
});
