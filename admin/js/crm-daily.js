(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmDaily = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const DAILY_STATUS_TABLE = 'crm_daily_statuses';
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
    card.className = [
      'crm-daily-card',
      `crm-daily-card--${type}`,
      completed ? 'is-complete' : '',
    ].filter(Boolean).join(' ');
    card.innerHTML = `
      <div class="crm-daily-card__details">
        <span class="crm-daily-card__room">${root.EcoVilaCrmCalendar.roomLabel(reservation)}</span>
        <strong>${root.EcoVilaCrmCalendar.guestName(reservation)}</strong>
        <span>${reservation.guest_phone || ''}</span>
      </div>
    `;

    if (!completed) {
      const button = root.document.createElement('button');
      button.type = 'button';
      button.className = 'crm-daily-check';
      button.setAttribute('aria-label', dailyActionLabel(type));
      button.title = dailyActionLabel(type);
      button.innerHTML = CHECK_ICON;
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

  function emptyState(context, state, type) {
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
    container.className = `crm-daily-list ${sorted.length ? '' : 'is-empty'}`.trim();

    if (!sorted.length) {
      container.innerHTML = emptyState(context, state, type);
      return;
    }

    sorted.forEach((item) => {
      container.appendChild(buildDailyCard(context, state, item.reservation, type, item.status));
    });
  }

  async function loadDaily(context, state) {
    syncDateControl(context, state);
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

    renderSection(context, state, qs('[data-check-ins]'), checkIns, statuses, 'in');
    renderSection(context, state, qs('[data-check-outs]'), checkOuts, statuses, 'out');
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
    };
    activeDaily = { context, state };

    const dateInput = qs('[data-daily-date]');
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
    DAILY_STATUS_TABLE,
    init,
    loadDaily,
    saveDailyStatus,
    showToday,
    sortByRoomWithCompletedLast,
  };
});
