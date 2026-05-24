(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmFinance = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const MODE_NIGHTS = 'nights';
  const MODE_PAID = 'paid';
  const COMMERCIAL_PAYMENT_TYPES = new Set(['cash', 'card', 'mia']);
  const ROOM_TYPE_LABELS = Object.freeze({
    small: 'Căsuță mică',
    large: 'Căsuță mare',
    hotel: 'Hotel',
  });

  let activeFinance = null;

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function qsa(selector, scope) {
    return Array.from((scope || root.document).querySelectorAll(selector));
  }

  function parseISODate(date) {
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function toISODate(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(date, amount) {
    const parsed = parseISODate(date);
    if (!parsed) {
      return '';
    }

    parsed.setUTCDate(parsed.getUTCDate() + Number(amount || 0));
    return toISODate(parsed);
  }

  function addMonths(date, amount) {
    const parsed = parseISODate(date);
    if (!parsed) {
      return '';
    }

    return toISODate(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + Number(amount || 0), 1)));
  }

  function firstOfMonth(date) {
    const parsed = parseISODate(date);
    if (!parsed) {
      return '';
    }

    return toISODate(new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1)));
  }

  function daysBetween(startDate, endDate) {
    const start = parseISODate(startDate);
    const end = parseISODate(endDate);
    if (!start || !end) {
      return 0;
    }

    return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
  }

  function todayISO() {
    return root.EcoVilaCrmCalendar?.todayISO?.() || new Date().toISOString().slice(0, 10);
  }

  function isCancelled(reservation) {
    return Boolean(reservation?.cancelled_at || reservation?.payment_status === 'cancelled');
  }

  function isPaid(reservation) {
    return reservation?.payment_status === 'paid';
  }

  function bookedNights(reservation) {
    return daysBetween(reservation?.check_in, reservation?.check_out);
  }

  function overlappingNights(reservation, rangeStart, rangeEnd) {
    const checkIn = reservation?.check_in;
    const checkOut = reservation?.check_out;
    if (!checkIn || !checkOut || checkOut <= rangeStart || checkIn >= rangeEnd) {
      return 0;
    }

    const overlapStart = checkIn > rangeStart ? checkIn : rangeStart;
    const overlapEnd = checkOut < rangeEnd ? checkOut : rangeEnd;
    return daysBetween(overlapStart, overlapEnd);
  }

  function isPaidAtInRange(reservation, rangeStart, rangeEnd) {
    if (!reservation?.paid_at) {
      return false;
    }

    const paidAt = new Date(reservation.paid_at).getTime();
    const start = new Date(`${rangeStart}T00:00:00.000Z`).getTime();
    const end = new Date(`${rangeEnd}T00:00:00.000Z`).getTime();
    return Number.isFinite(paidAt) && paidAt >= start && paidAt < end;
  }

  function reservationKey(reservation) {
    return reservation?.booking_group_id || reservation?.id || '';
  }

  function emptySummary() {
    return {
      commercialTotal: 0,
      cashTotal: 0,
      onlineTotal: 0,
      officeTotal: 0,
      occupiedNights: 0,
      paidBookings: 0,
      averageBookingValue: 0,
      roomTypeTotals: {
        small: 0,
        large: 0,
        hotel: 0,
      },
    };
  }

  function roundMoney(value) {
    return Math.round(Number(value || 0));
  }

  function contributionForMode(reservation, mode, rangeStart, rangeEnd) {
    const nights = bookedNights(reservation);
    const total = Number(reservation?.total_price || 0);

    if (!nights || total < 0) {
      return { amount: 0, nights: 0 };
    }

    if (mode === MODE_PAID) {
      if (!isPaidAtInRange(reservation, rangeStart, rangeEnd)) {
        return { amount: 0, nights: 0 };
      }

      return { amount: total, nights };
    }

    const overlap = overlappingNights(reservation, rangeStart, rangeEnd);
    if (!overlap) {
      return { amount: 0, nights: 0 };
    }

    return { amount: (total / nights) * overlap, nights: overlap };
  }

  function summarizeFinanceRows(input) {
    const rows = input?.rows || [];
    const mode = input?.mode === MODE_PAID ? MODE_PAID : MODE_NIGHTS;
    const rangeStart = input?.rangeStart || firstOfMonth(todayISO());
    const rangeEnd = input?.rangeEnd || addMonths(rangeStart, 1);
    const summary = emptySummary();
    const commercialKeys = new Set();

    rows.forEach((reservation) => {
      if (!isPaid(reservation) || isCancelled(reservation)) {
        return;
      }

      const paymentType = reservation.payment_type || '';
      if (!COMMERCIAL_PAYMENT_TYPES.has(paymentType) && paymentType !== 'office') {
        return;
      }

      const contribution = contributionForMode(reservation, mode, rangeStart, rangeEnd);
      if (!contribution.nights || !contribution.amount) {
        return;
      }

      summary.occupiedNights += contribution.nights;

      if (paymentType === 'office') {
        summary.officeTotal += contribution.amount;
        return;
      }

      const key = reservationKey(reservation);
      if (key) {
        commercialKeys.add(key);
      }

      summary.commercialTotal += contribution.amount;
      if (paymentType === 'cash') {
        summary.cashTotal += contribution.amount;
      } else {
        summary.onlineTotal += contribution.amount;
      }

      const roomType = reservation.rooms?.type || reservation.room_type || '';
      if (roomType in summary.roomTypeTotals) {
        summary.roomTypeTotals[roomType] += contribution.amount;
      }
    });

    summary.commercialTotal = roundMoney(summary.commercialTotal);
    summary.cashTotal = roundMoney(summary.cashTotal);
    summary.onlineTotal = roundMoney(summary.onlineTotal);
    summary.officeTotal = roundMoney(summary.officeTotal);
    Object.keys(summary.roomTypeTotals).forEach((type) => {
      summary.roomTypeTotals[type] = roundMoney(summary.roomTypeTotals[type]);
    });
    summary.paidBookings = commercialKeys.size;
    summary.averageBookingValue = summary.paidBookings
      ? roundMoney(summary.commercialTotal / summary.paidBookings)
      : 0;

    return summary;
  }

  function formatCalendarMonth(date) {
    const parsed = parseISODate(firstOfMonth(date));
    const formatted = new Intl.DateTimeFormat('ro-MD', {
      month: 'long',
      year: 'numeric',
    }).format(parsed);
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }

  function isFullMonth(rangeStart, rangeEnd) {
    return rangeStart === firstOfMonth(rangeStart) && rangeEnd === addMonths(rangeStart, 1);
  }

  function formatRangeLabel(context, state) {
    if (isFullMonth(state.rangeStart, state.rangeEnd)) {
      return formatCalendarMonth(state.rangeStart);
    }

    const endLabel = addDays(state.rangeEnd, -1);
    return `${context.formatDate(state.rangeStart)} - ${context.formatDate(endLabel)}`;
  }

  function setText(selector, value) {
    const node = qs(selector);
    if (node) {
      node.textContent = String(value);
    }
  }

  function formatMDL(context, amount) {
    return context.formatMDL ? context.formatMDL(amount) : `${Number(amount || 0).toLocaleString('ro-MD')} MDL`;
  }

  function syncControls(context, state) {
    setText('[data-finance-range-label]', formatRangeLabel(context, state));

    qsa('[data-finance-mode]').forEach((button) => {
      const active = button.dataset.financeMode === state.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function renderSummary(context, summary) {
    setText('[data-finance-commercial-total]', formatMDL(context, summary.commercialTotal));
    setText('[data-finance-cash-total]', formatMDL(context, summary.cashTotal));
    setText('[data-finance-online-total]', formatMDL(context, summary.onlineTotal));
    setText('[data-finance-office-total]', formatMDL(context, summary.officeTotal));
    setText('[data-finance-occupied-nights]', summary.occupiedNights);
    setText('[data-finance-paid-bookings]', summary.paidBookings);
    setText('[data-finance-average-booking]', formatMDL(context, summary.averageBookingValue));

    Object.entries(ROOM_TYPE_LABELS).forEach(([type]) => {
      const container = qs(`[data-finance-room-type="${type}"]`);
      const value = container?.querySelector?.('[data-finance-room-total]');
      if (value) {
        value.textContent = formatMDL(context, summary.roomTypeTotals[type] || 0);
      }
    });
  }

  async function loadFinance(context, state) {
    syncControls(context, state);
    const rows = await root.EcoVilaSupabase.fetchFinanceReservations(context.client, {
      mode: state.mode,
      rangeStart: state.rangeStart,
      rangeEnd: state.rangeEnd,
    });
    state.rows = rows || [];
    renderSummary(context, summarizeFinanceRows({
      rows: state.rows,
      mode: state.mode,
      rangeStart: state.rangeStart,
      rangeEnd: state.rangeEnd,
    }));
  }

  function setRange(context, state, rangeStart, rangeEnd) {
    if (!rangeStart || !rangeEnd || rangeEnd <= rangeStart) {
      return;
    }

    state.rangeStart = rangeStart;
    state.rangeEnd = rangeEnd;
    state.currentMonth = firstOfMonth(rangeStart);
    state.draftStart = rangeStart;
    state.draftEnd = addDays(rangeEnd, -1);
    syncControls(context, state);
  }

  function showCurrentMonth() {
    if (!activeFinance) {
      return null;
    }

    const { context, state } = activeFinance;
    const monthStart = firstOfMonth(todayISO());
    setRange(context, state, monthStart, addMonths(monthStart, 1));
    return loadFinance(context, state).catch((error) => {
      context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.');
    });
  }

  function shiftRange(context, state, amount) {
    if (isFullMonth(state.rangeStart, state.rangeEnd)) {
      setRange(context, state, addMonths(state.rangeStart, amount), addMonths(state.rangeEnd, amount));
      return;
    }

    const length = daysBetween(state.rangeStart, state.rangeEnd);
    setRange(context, state, addDays(state.rangeStart, length * amount), addDays(state.rangeEnd, length * amount));
  }

  function isClickInsideFinanceRangePicker(event) {
    return Boolean(
      event.composedPath?.().some((node) => {
        return node?.dataset && 'financeRangePicker' in node.dataset;
      }) || event.target.closest?.('[data-finance-range-picker]'),
    );
  }

  function renderFinanceCalendar(context, state) {
    const calendar = qs('[data-finance-range-calendar]');
    const title = qs('[data-finance-calendar-title]');
    const grid = qs('[data-finance-calendar-grid]');
    if (!calendar || !grid) {
      return;
    }

    calendar.hidden = !state.calendarOpen;
    if (title) {
      title.textContent = formatCalendarMonth(state.currentMonth);
    }

    grid.innerHTML = '';
    const monthStart = parseISODate(state.currentMonth);
    const mondayOffset = (monthStart.getUTCDay() + 6) % 7;
    const startDate = addDays(state.currentMonth, -mondayOffset);

    for (let index = 0; index < 42; index += 1) {
      const date = addDays(startDate, index);
      const parsed = parseISODate(date);
      const button = root.document.createElement('button');
      button.type = 'button';
      button.textContent = String(parsed.getUTCDate());
      button.dataset.date = date;
      button.classList.toggle('is-muted', parsed.getUTCMonth() !== monthStart.getUTCMonth());
      button.classList.toggle('is-selected', date === state.draftStart || date === state.draftEnd);
      button.classList.toggle('is-in-range', Boolean(state.draftStart && state.draftEnd && date > state.draftStart && date < state.draftEnd));
      button.addEventListener('click', () => selectFinanceDate(context, state, date));
      grid.appendChild(button);
    }
  }

  function selectFinanceDate(context, state, date) {
    if (!state.draftStart || state.draftEnd || date < state.draftStart) {
      state.draftStart = date;
      state.draftEnd = '';
    } else {
      state.draftEnd = date;
    }

    renderFinanceCalendar(context, state);
  }

  function init(context) {
    const today = todayISO();
    const monthStart = firstOfMonth(today);
    const state = {
      mode: MODE_NIGHTS,
      rangeStart: monthStart,
      rangeEnd: addMonths(monthStart, 1),
      draftStart: monthStart,
      draftEnd: addDays(addMonths(monthStart, 1), -1),
      currentMonth: monthStart,
      calendarOpen: false,
      rows: [],
    };
    activeFinance = { context, state };

    qs('[data-finance-prev]')?.addEventListener('click', () => {
      shiftRange(context, state, -1);
      loadFinance(context, state).catch((error) => context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.'));
    });
    qs('[data-finance-next]')?.addEventListener('click', () => {
      shiftRange(context, state, 1);
      loadFinance(context, state).catch((error) => context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.'));
    });
    qs('[data-finance-range-label]')?.addEventListener('click', () => {
      state.calendarOpen = true;
      state.draftStart = state.rangeStart;
      state.draftEnd = addDays(state.rangeEnd, -1);
      state.currentMonth = firstOfMonth(state.rangeStart);
      renderFinanceCalendar(context, state);
    });
    qsa('[data-finance-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        state.mode = button.dataset.financeMode === MODE_PAID ? MODE_PAID : MODE_NIGHTS;
        loadFinance(context, state).catch((error) => context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.'));
      });
    });
    qs('[data-finance-calendar-prev]')?.addEventListener('click', () => {
      state.currentMonth = addMonths(state.currentMonth, -1);
      renderFinanceCalendar(context, state);
    });
    qs('[data-finance-calendar-next]')?.addEventListener('click', () => {
      state.currentMonth = addMonths(state.currentMonth, 1);
      renderFinanceCalendar(context, state);
    });
    qs('[data-finance-calendar-clear]')?.addEventListener('click', () => {
      state.draftStart = '';
      state.draftEnd = '';
      renderFinanceCalendar(context, state);
    });
    qs('[data-finance-calendar-apply]')?.addEventListener('click', () => {
      if (state.draftStart && state.draftEnd && state.draftEnd >= state.draftStart) {
        setRange(context, state, state.draftStart, addDays(state.draftEnd, 1));
        state.calendarOpen = false;
        renderFinanceCalendar(context, state);
        loadFinance(context, state).catch((error) => context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.'));
      }
    });
    root.document.addEventListener('click', (event) => {
      if (!state.calendarOpen || isClickInsideFinanceRangePicker(event)) {
        return;
      }
      state.calendarOpen = false;
      renderFinanceCalendar(context, state);
    });

    syncControls(context, state);
    renderFinanceCalendar(context, state);
    loadFinance(context, state).catch((error) => context.setAlert(error?.message || 'Finanțele nu s-au putut încărca.'));

    context.client
      .channel('crm-finance-reservations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, () => loadFinance(context, state))
      .subscribe();
  }

  return {
    MODE_NIGHTS,
    MODE_PAID,
    ROOM_TYPE_LABELS,
    addDays,
    addMonths,
    firstOfMonth,
    init,
    isClickInsideFinanceRangePicker,
    loadFinance,
    showCurrentMonth,
    summarizeFinanceRows,
  };
});
