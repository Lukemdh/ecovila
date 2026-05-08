(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const LABELS = {
    '1-weekday': ['1 noapte', 'Zi lucrătoare'],
    '1-holiday': ['1 noapte', 'Weekend/Sărbătoare'],
    '2-weekday': ['2 nopți', 'Zi lucrătoare'],
    '2-holiday': ['2 nopți', 'Weekend/Sărbătoare'],
    '3-weekday': ['3+ nopți', 'Zi lucrătoare'],
    '3-holiday': ['3+ nopți', 'Weekend/Sărbătoare'],
  };

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function activePricingRows(rows) {
    const today = new Date().toISOString().slice(0, 10);
    return Object.keys(LABELS).map((key) => {
      const [tier, dayType] = key.split('-');
      return rows
        .filter((row) => Number(row.nights_tier) === Number(tier) && row.day_type === dayType && row.effective_from <= today)
        .sort((left, right) => right.effective_from.localeCompare(left.effective_from))[0] || {
        nights_tier: Number(tier),
        day_type: dayType,
        adult_price: 0,
        kid_price: 0,
        effective_from: today,
      };
    });
  }

  function renderPricingTable(rows) {
    const container = qs('[data-pricing-table]');
    if (!container) {
      return;
    }

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Durată</th>
            <th>Tip zi</th>
            <th>Adult</th>
            <th>Copil</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => {
            const labels = LABELS[`${row.nights_tier}-${row.day_type}`];
            return `
              <tr data-price-row data-tier="${row.nights_tier}" data-day-type="${row.day_type}">
                <td>${labels[0]}</td>
                <td>${labels[1]}</td>
                <td><input type="number" min="0" value="${row.adult_price}" data-adult-price></td>
                <td><input type="number" min="0" value="${row.kid_price}" data-kid-price></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function renderHolidays(holidays) {
    const list = qs('[data-holiday-list]');
    if (!list) {
      return;
    }

    if (!holidays?.length) {
      list.innerHTML = '<p class="crm-empty">Nu sunt zile de sărbătoare adăugate manual.</p>';
      return;
    }

    list.innerHTML = holidays.map((holiday) => `
      <article class="crm-search-card">
        <strong>${holiday.date}</strong>
        <span>${holiday.label || 'Fără etichetă'}</span>
        <button class="crm-button crm-button--small" type="button" data-delete-holiday="${holiday.date}">Șterge</button>
      </article>
    `).join('');
  }

  async function savePrices(context) {
    const effectiveFrom = qs('[data-price-effective-from]')?.value || new Date().toISOString().slice(0, 10);
    const rows = Array.from(root.document.querySelectorAll('[data-price-row]')).map((row) => ({
      nights_tier: Number(row.dataset.tier),
      day_type: row.dataset.dayType,
      adult_price: Number(qs('[data-adult-price]', row).value || 0),
      kid_price: Number(qs('[data-kid-price]', row).value || 0),
      effective_from: effectiveFrom,
    }));

    await root.EcoVilaSupabase.insertPricingRows(context.client, rows);
    await loadPricing(context);
    context.setAlert('Prețurile au fost salvate. Rezervările existente nu vor fi afectate.');
  }

  async function addHoliday(context, form) {
    await root.EcoVilaSupabase.insertHoliday(context.client, {
      date: qs('[data-holiday-date]', form).value,
      label: qs('[data-holiday-label]', form).value.trim() || null,
      created_by: context.session.user.id,
    });
    form.reset();
    await loadPricing(context);
  }

  async function loadPricing(context) {
    const [pricing_tiers, holidays] = await Promise.all([
      root.EcoVilaSupabase.fetchPricingTiers(context.client),
      root.EcoVilaSupabase.fetchHolidays(context.client),
    ]);

    renderPricingTable(activePricingRows(pricing_tiers));
    renderHolidays(holidays);
    const dateInput = qs('[data-price-effective-from]');
    if (dateInput && !dateInput.value) {
      dateInput.value = new Date().toISOString().slice(0, 10);
    }

    root.document.querySelectorAll('[data-delete-holiday]').forEach((button) => {
      button.addEventListener('click', async () => {
        await root.EcoVilaSupabase.deleteHoliday(context.client, button.dataset.deleteHoliday);
        await loadPricing(context);
      });
    });
  }

  function init(context) {
    qs('[data-save-prices]')?.addEventListener('click', () => savePrices(context));
    qs('[data-add-holiday-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      addHoliday(context, event.currentTarget).catch((error) => context.setAlert(error?.message || 'Ziua nu a putut fi adăugată.'));
    });
    loadPricing(context).catch((error) => context.setAlert(error?.message || 'Prețurile nu s-au putut încărca.'));
  }

  return {
    activePricingRows,
    init,
    loadPricing,
    pricing_tiers: 'pricing_tiers',
    holidays: 'holidays',
    effective_from: 'effective_from',
  };
});
