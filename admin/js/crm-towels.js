(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmTowels = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const TOWEL_COUNTS_TABLE = 'crm_towel_counts';
  const TOWEL_SAVE_DELAY_MS = 5000;
  const SAVE_STATUS_VISIBLE_MS = 3000;
  let activeTowels = null;
  const pendingSaves = new Map();
  let saveStatusTimer = null;

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function syncDateControl(context, state) {
    const label = qs('[data-towels-date-label]');
    const input = qs('[data-towels-date]');
    if (label) {
      label.textContent = context.formatDate(state.selectedDate);
    }
    if (input) {
      input.value = state.selectedDate;
    }
  }

  function countMap(counts) {
    return new Map((counts || []).map((item) => [item.room_id, Number(item.towel_count || 0)]));
  }

  function setSaveStatus(message, visible) {
    const status = qs('[data-towels-save-status]');
    const statusText = status?.querySelector?.('span') || qs('[data-towels-save-status] span');
    if (statusText) {
      statusText.textContent = message;
    }
    if (!status) {
      return;
    }
    if (typeof status.classList.toggle === 'function') {
      status.classList.toggle('is-visible', Boolean(visible));
      return;
    }
    if (visible) {
      status.classList.add?.('is-visible');
    } else {
      status.classList.remove?.('is-visible');
    }
  }

  function showSavedStatus() {
    if (saveStatusTimer) {
      root.clearTimeout(saveStatusTimer);
      saveStatusTimer = null;
    }
    setSaveStatus('Salvat', true);
    saveStatusTimer = root.setTimeout(() => {
      setSaveStatus('Salvat', false);
      saveStatusTimer = null;
    }, SAVE_STATUS_VISIBLE_MS);
  }

  function updateRoomCount(state, room, towelCount) {
    const normalizedCount = Math.max(0, Number(towelCount || 0));
    const nextCounts = (state.counts || []).filter((item) => item.room_id !== room.id);
    nextCounts.push({
      room_id: room.id,
      service_date: state.selectedDate,
      towel_count: normalizedCount,
    });
    state.counts = nextCounts;
    return normalizedCount;
  }

  function renderTowels(context, state) {
    const grid = qs('[data-towels-grid]');
    if (!grid) {
      return;
    }

    const counts = countMap(state.counts);
    const total = (state.rooms || []).reduce((sum, room) => sum + Number(counts.get(room.id) || 0), 0);
    const completedCount = (state.rooms || []).filter((room) => Number(counts.get(room.id) || 0) > 0).length;
    const roomCount = qs('[data-towels-room-count]');
    const completed = qs('[data-towels-completed]');
    const totalCount = qs('[data-towels-total]');
    if (roomCount) {
      roomCount.textContent = String((state.rooms || []).length);
    }
    if (completed) {
      completed.textContent = String(completedCount);
    }
    if (totalCount) {
      totalCount.textContent = String(total);
    }

    grid.innerHTML = '';
    (state.rooms || []).forEach((room) => {
      const count = Number(counts.get(room.id) || 0);
      const tile = root.document.createElement('article');
      tile.className = 'crm-towel-room';
      tile.dataset.roomId = room.id;
      tile.innerHTML = `
        <strong data-towel-room-number>${room.number}</strong>
        <div class="crm-towel-room__controls">
          <button class="crm-towel-button" type="button" data-towel-action="decrease" aria-label="Scade stergare camera ${room.number}">-</button>
          <span class="crm-towel-count">${count}</span>
          <button class="crm-towel-button" type="button" data-towel-action="increase" aria-label="Adauga stergare camera ${room.number}">+</button>
        </div>
      `;

      tile.querySelectorAll('[data-towel-action]').forEach((button) => {
        button.addEventListener('click', () => {
          const delta = button.dataset.towelAction === 'increase' ? 1 : -1;
          const currentCount = Number(countMap(state.counts).get(room.id) || 0);
          scheduleTowelCountSave(context, state, room, currentCount + delta);
        });
      });
      grid.appendChild(tile);
    });
  }

  async function loadTowels(context, state) {
    syncDateControl(context, state);
    const [rooms, counts] = await Promise.all([
      root.EcoVilaSupabase.fetchRooms(context.client),
      root.EcoVilaSupabase.fetchTowelCounts(context.client, state.selectedDate),
    ]);
    state.rooms = rooms;
    state.counts = counts;
    renderTowels(context, state);
  }

  async function saveTowelCount(context, state, room, nextCount, serviceDate) {
    const towelCount = Math.max(0, Number(nextCount || 0));
    const saveDate = serviceDate || state.selectedDate;
    await root.EcoVilaSupabase.upsertTowelCount(context.client, {
      room_id: room.id,
      service_date: saveDate,
      towel_count: towelCount,
      updated_by: context.session.user.id,
      updated_at: new Date().toISOString(),
    });
    if (state.selectedDate === saveDate) {
      await loadTowels(context, state);
    }
    showSavedStatus();
  }

  function scheduleTowelCountSave(context, state, room, nextCount) {
    const towelCount = updateRoomCount(state, room, nextCount);
    const serviceDate = state.selectedDate;
    const key = `${serviceDate}:${room.id}`;
    const pending = pendingSaves.get(key);
    if (pending?.timer) {
      root.clearTimeout(pending.timer);
    }

    renderTowels(context, state);
    pendingSaves.set(key, {
      room,
      towelCount,
      timer: root.setTimeout(async () => {
        pendingSaves.delete(key);
        try {
          await saveTowelCount(context, state, room, towelCount, serviceDate);
        } catch (error) {
          context.setAlert(error?.message || 'Ștergarele nu au putut fi salvate.');
        }
      }, TOWEL_SAVE_DELAY_MS),
    });
  }

  function setSelectedDate(context, state, date) {
    state.selectedDate = root.EcoVilaCrmCalendar.toISODate(date);
    syncDateControl(context, state);
  }

  function showToday() {
    if (!activeTowels) {
      return null;
    }

    const { context, state } = activeTowels;
    setSelectedDate(context, state, root.EcoVilaCrmCalendar.todayISO());
    return loadTowels(context, state).catch((error) => {
      context.setAlert(error?.message || 'Stergarele nu s-au putut încărca.');
    });
  }

  function init(context) {
    const state = {
      selectedDate: root.EcoVilaCrmCalendar.todayISO(),
      rooms: [],
      counts: [],
    };
    activeTowels = { context, state };

    const dateInput = qs('[data-towels-date]');
    dateInput?.addEventListener('change', () => {
      setSelectedDate(context, state, dateInput.value || state.selectedDate);
      loadTowels(context, state);
    });
    qs('[data-towels-prev]')?.addEventListener('click', () => {
      setSelectedDate(context, state, root.EcoVilaCrmCalendar.addDays(state.selectedDate, -1));
      loadTowels(context, state);
    });
    qs('[data-towels-next]')?.addEventListener('click', () => {
      setSelectedDate(context, state, root.EcoVilaCrmCalendar.addDays(state.selectedDate, 1));
      loadTowels(context, state);
    });

    loadTowels(context, state).catch((error) => context.setAlert(error?.message || 'Stergarele nu s-au putut încărca.'));

    context.client
      .channel('crm-towel-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: TOWEL_COUNTS_TABLE }, () => loadTowels(context, state))
      .subscribe();
  }

  return {
    TOWEL_COUNTS_TABLE,
    TOWEL_SAVE_DELAY_MS,
    init,
    loadTowels,
    renderTowels,
    saveTowelCount,
    scheduleTowelCountSave,
    showToday,
  };
});
