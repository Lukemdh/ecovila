(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmSidebar = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function readNumberList(value) {
    return String(value || '')
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((number) => Number.isInteger(number));
  }

  function wireToggles() {
    root.document.querySelectorAll('[data-sidebar-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.sidebarToggle;
        const form = qs(target === 'add' ? '[data-add-reservation-form]' : '[data-search-reservation-form]');
        if (form) {
          form.hidden = !form.hidden;
        }
      });
    });
  }

  function buildStaffReservationRows(form, rooms, context) {
    const roomNumbers = readNumberList(qs('[data-add-room-numbers]', form)?.value);
    const selectedRooms = roomNumbers
      .map((number) => rooms.find((room) => Number(room.number) === number))
      .filter(Boolean);
    const now = new Date();
    const paymentType = qs('[data-add-payment-type]', form)?.value || 'cash';

    return selectedRooms.map((room) => ({
      room_id: room.id,
      guest_first_name: qs('[data-add-first-name]', form)?.value?.trim() || 'Client',
      guest_last_name: qs('[data-add-last-name]', form)?.value?.trim() || 'CRM',
      guest_phone: qs('[data-add-phone]', form)?.value?.trim() || '+37300000000',
      guest_email: qs('[data-add-email]', form)?.value?.trim() || 'rezervari@ecovila.md',
      check_in: qs('[data-add-check-in]', form)?.value,
      check_out: qs('[data-add-check-out]', form)?.value,
      adults: Number(qs('[data-add-adults]', form)?.value || 0),
      kids_ages: readNumberList(qs('[data-add-kids-ages]', form)?.value),
      total_price: Number(qs('[data-add-total]', form)?.dataset.total || 0),
      payment_type: paymentType,
      payment_status: paymentType === 'cash' ? 'pending' : 'paid',
      room_explicitly_selected: true,
      conference_room: Boolean(qs('[data-add-conference]', form)?.checked),
      notes: qs('[data-add-notes]', form)?.value?.trim() || null,
      cash_expires_at: paymentType === 'cash' ? new Date(now.getTime() + 30 * 60 * 1000).toISOString() : null,
      created_by: context.role,
    }));
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
      const room = root.EcoVilaCrmCalendar.roomLabel(reservation);
      const name = root.EcoVilaCrmCalendar.guestName(reservation);
      return `
        <button class="crm-search-card" type="button" data-result-id="${reservation.id}">
          <strong>${name}</strong>
          <span>${room}</span>
          <span>${reservation.check_in} - ${reservation.check_out}</span>
          <span>${reservation.guest_phone}</span>
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
    addForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const rows = buildStaffReservationRows(addForm, state.rooms || [], context);
        if (!rows.length) {
          context.setAlert('Alege cel puțin o cameră.');
          return;
        }
        await helpers.insertStaffReservations(context.client, rows);
        addForm.reset();
        await state.reload?.();
      } catch (error) {
        context.setAlert(error?.message || 'Rezervarea nu a putut fi adăugată.');
      }
    });

    const searchForm = qs('[data-search-reservation-form]');
    searchForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const results = await helpers.searchReservations(context.client, {
          date: qs('[data-search-date]', searchForm)?.value,
          name: qs('[data-search-name]', searchForm)?.value?.trim(),
          phone: qs('[data-search-phone]', searchForm)?.value?.trim(),
        });
        renderSearchResults(qs('[data-search-results]'), results, state.openReservation);
      } catch (error) {
        context.setAlert(error?.message || 'Căutarea nu a reușit.');
      }
    });
  }

  return {
    buildStaffReservationRows,
    init,
    readNumberList,
    renderSearchResults,
  };
});
