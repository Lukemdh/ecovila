(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const LABELS = {
    '1-weekday': ['1 noapte', 'Zi lucrătoare'],
    '1-holiday': ['1 noapte', 'Weekend / Sărbătoare'],
    '2-weekday': ['2 nopți', 'Zi lucrătoare'],
    '2-holiday': ['2 nopți', 'Weekend / Sărbătoare'],
    '3-weekday': ['3+ nopți', 'Zi lucrătoare'],
    '3-holiday': ['3+ nopți', 'Weekend / Sărbătoare'],
  };

  const ROW_ICONS = {
    '1-weekday': 'moon',
    '1-holiday': 'calendar',
    '2-weekday': 'moon',
    '2-holiday': 'calendar',
    '3-weekday': 'users',
    '3-holiday': 'calendar',
  };

  const MONTHS = [
    'ianuarie',
    'februarie',
    'martie',
    'aprilie',
    'mai',
    'iunie',
    'iulie',
    'august',
    'septembrie',
    'octombrie',
    'noiembrie',
    'decembrie',
  ];

  const RECURRING_HOLIDAY_YEAR = 2000;
  const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  let pricingToastTimer = null;
  let pricingToastHideTimer = null;

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char]);
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function toRecurringHolidayDate(input) {
    const day = Number(input?.day);
    const month = Number(input?.month);
    const date = new Date(Date.UTC(RECURRING_HOLIDAY_YEAR, month - 1, day));

    if (
      !Number.isInteger(day) ||
      !Number.isInteger(month) ||
      date.getUTCFullYear() !== RECURRING_HOLIDAY_YEAR ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new Error('Alege o zi și o lună valide.');
    }

    return `${RECURRING_HOLIDAY_YEAR}-${pad2(month)}-${pad2(day)}`;
  }

  function getRecurringHolidayParts(holiday) {
    if (holiday?.month && holiday?.day) {
      return {
        month: Number(holiday.month),
        day: Number(holiday.day),
      };
    }

    const match = String(holiday?.date || holiday || '').match(ISO_DATE_PATTERN);
    if (!match) {
      throw new Error(`Data sărbătorii nu este validă: ${holiday?.date || holiday}`);
    }

    return {
      month: Number(match[2]),
      day: Number(match[3]),
    };
  }

  function formatRecurringHoliday(holiday) {
    const { day, month } = getRecurringHolidayParts(holiday);
    return `${day} ${MONTHS[month - 1]}`;
  }

  function recurringHolidaySortKey(holiday) {
    const { day, month } = getRecurringHolidayParts(holiday);
    return `${pad2(month)}-${pad2(day)}`;
  }

  function iconSvg(name) {
    const paths = {
      moon: '<path d="M21 14.6A8 8 0 0 1 9.4 3a7 7 0 1 0 11.6 11.6Z"></path>',
      calendar: '<path d="M8 2v4"></path><path d="M16 2v4"></path><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M3 10h18"></path>',
      users: '<path d="M16 21v-2a4 4 0 0 0-8 0v2"></path><circle cx="12" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M2 21v-2a4 4 0 0 1 3-3.87"></path>',
      dots: '<path d="M12 5h.01"></path><path d="M12 12h.01"></path><path d="M12 19h.01"></path>',
    };

    return `
      <span class="crm-price-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">${paths[name] || paths.calendar}</svg>
      </span>
    `;
  }

  function todayISO() {
    const date = new Date();
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
    return localDate.toISOString().slice(0, 10);
  }

  function dayBeforeISO(iso) {
    const match = ISO_DATE_PATTERN.exec(String(iso || ''));
    if (!match) {
      return String(iso ?? '');
    }
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }

  function formatScheduleDate(iso) {
    const match = ISO_DATE_PATTERN.exec(String(iso || ''));
    if (!match) {
      return String(iso ?? '');
    }
    return `${match[3]}.${match[2]}.${match[1]}`;
  }

  function comparePricingRowsByRecency(left, right) {
    const effectiveCompare = String(right.effective_from || '').localeCompare(String(left.effective_from || ''));
    if (effectiveCompare !== 0) {
      return effectiveCompare;
    }

    return String(right.created_at || '').localeCompare(String(left.created_at || ''));
  }

  function resolveActiveRows(rows, asOfISO) {
    const list = Array.isArray(rows) ? rows : [];
    return Object.keys(LABELS).map((key) => {
      const [tier, dayType] = key.split('-');
      return list
        .filter((row) => Number(row.nights_tier) === Number(tier) && row.day_type === dayType && row.effective_from <= asOfISO)
        .sort(comparePricingRowsByRecency)[0] || {
        nights_tier: Number(tier),
        day_type: dayType,
        adult_price: 0,
        kid_price: 0,
        effective_from: asOfISO,
      };
    });
  }

  function activePricingRows(rows) {
    return resolveActiveRows(rows, todayISO());
  }

  function samePriceSet(left, right) {
    if (!left || !right || left.length !== right.length) {
      return false;
    }
    return left.every((row, index) => (
      Number(row.adult_price) === Number(right[index].adult_price) &&
      Number(row.kid_price) === Number(right[index].kid_price)
    ));
  }

  function pricingSchedule(rows) {
    const valid = (Array.isArray(rows) ? rows : []).filter((row) => (
      ISO_DATE_PATTERN.test(String(row?.effective_from || ''))
    ));
    const boundaries = Array.from(new Set(valid.map((row) => row.effective_from))).sort();

    const segments = [];
    boundaries.forEach((from) => {
      const prices = resolveActiveRows(valid, from);
      const previous = segments[segments.length - 1];
      if (previous && samePriceSet(previous.prices, prices)) {
        return;
      }
      segments.push({ from, until: null, prices });
    });

    const today = todayISO();
    segments.forEach((segment, index) => {
      const next = segments[index + 1];
      segment.until = next ? dayBeforeISO(next.from) : null;
      segment.isCurrent = segment.from <= today && (segment.until === null || segment.until >= today);
      segment.isFuture = segment.from > today;
      segment.isPast = segment.until !== null && segment.until < today;
    });

    // Drop fully elapsed periods: once newer prices take effect the old ones are no
    // longer useful. Keep the period currently in force plus any scheduled ahead.
    return segments.filter((segment) => !segment.isPast);
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
            <th>Adult (MDL)</th>
            <th>Copil (MDL)</th>
            <th aria-label="Acțiuni"></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => {
            const labels = LABELS[`${row.nights_tier}-${row.day_type}`];
            const icon = ROW_ICONS[`${row.nights_tier}-${row.day_type}`];
            return `
              <tr data-price-row data-tier="${row.nights_tier}" data-day-type="${row.day_type}">
                <td>
                  <span class="crm-price-duration">
                    ${iconSvg(icon)}
                    <span>${labels[0]}</span>
                  </span>
                </td>
                <td><span class="crm-price-type">${labels[1]}</span></td>
                <td><input type="number" min="0" value="${row.adult_price}" data-adult-price aria-label="${labels[0]} ${labels[1]} adult"></td>
                <td><input type="number" min="0" value="${row.kid_price}" data-kid-price aria-label="${labels[0]} ${labels[1]} copil"></td>
                <td class="crm-price-actions">${iconSvg('dots')}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function renderPricingSchedule(rows) {
    const container = qs('[data-price-schedule]');
    if (!container) {
      return;
    }

    const segments = pricingSchedule(rows);
    if (!segments.length) {
      container.innerHTML = '<p class="crm-empty">Nu există tarife salvate încă.</p>';
      return;
    }

    container.innerHTML = segments.map((segment) => {
      const range = segment.until
        ? `${formatScheduleDate(segment.from)} – ${formatScheduleDate(segment.until)}`
        : `${formatScheduleDate(segment.from)} – în continuare`;

      let badge = '';
      if (segment.isCurrent) {
        badge = '<span class="crm-price-period__badge crm-price-period__badge--current">Activ acum</span>';
      } else if (segment.isFuture) {
        badge = '<span class="crm-price-period__badge crm-price-period__badge--future">Programat</span>';
      }

      const body = segment.prices.map((price) => {
        const labels = LABELS[`${price.nights_tier}-${price.day_type}`];
        const icon = ROW_ICONS[`${price.nights_tier}-${price.day_type}`];
        return `
          <tr>
            <td>
              <span class="crm-price-duration">
                ${iconSvg(icon)}
                <span>${labels[0]}</span>
              </span>
            </td>
            <td><span class="crm-price-type">${labels[1]}</span></td>
            <td class="crm-price-cell">${escapeHtml(price.adult_price)}</td>
            <td class="crm-price-cell">${escapeHtml(price.kid_price)}</td>
          </tr>
        `;
      }).join('');

      return `
        <article class="crm-price-period${segment.isCurrent ? ' is-current' : ''}">
          <header class="crm-price-period__header">
            <span class="crm-price-period__range">${range}</span>
            ${badge}
          </header>
          <div class="crm-price-table crm-price-table--readonly">
            <table>
              <thead>
                <tr>
                  <th>Durată</th>
                  <th>Tip zi</th>
                  <th>Adult (MDL)</th>
                  <th>Copil (MDL)</th>
                </tr>
              </thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        </article>
      `;
    }).join('');
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

    list.innerHTML = [...holidays].sort((left, right) => (
      recurringHolidaySortKey(left).localeCompare(recurringHolidaySortKey(right))
    )).map((holiday) => `
      <article class="crm-holiday-item">
        ${iconSvg('calendar')}
        <div class="crm-holiday-item__text">
          <strong>${escapeHtml(formatRecurringHoliday(holiday))}</strong>
          ${holiday.label ? `<span>${escapeHtml(holiday.label)}</span>` : ''}
        </div>
        <button class="crm-button crm-button--small" type="button" data-delete-holiday="${escapeHtml(holiday.date)}">Șterge</button>
      </article>
    `).join('');
  }

  function collectPricingRows(document) {
    const effectiveFrom = qs('[data-price-effective-from]', document)?.value || todayISO();
    return Array.from(document.querySelectorAll('[data-price-row]')).map((row) => ({
      nights_tier: Number(row.dataset.tier),
      day_type: row.dataset.dayType,
      adult_price: Number(qs('[data-adult-price]', row).value || 0),
      kid_price: Number(qs('[data-kid-price]', row).value || 0),
      effective_from: effectiveFrom,
    }));
  }

  function showPricingToast(message) {
    const toast = qs('[data-crm-toast]');
    if (!toast) {
      return;
    }

    toast.textContent = message || '';
    toast.hidden = false;
    toast.classList.remove('is-visible', 'is-hiding');
    clearTimeout(pricingToastTimer);
    clearTimeout(pricingToastHideTimer);
    toast.offsetWidth;
    toast.classList.add('is-visible');

    pricingToastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
      toast.classList.add('is-hiding');
      pricingToastHideTimer = setTimeout(() => {
        toast.hidden = true;
        toast.classList.remove('is-hiding');
        pricingToastHideTimer = null;
      }, 240);
      pricingToastTimer = null;
    }, 3000);
  }

  async function savePrices(context) {
    const rows = collectPricingRows(root.document);

    await root.EcoVilaSupabase.insertPricingRows(context.client, rows);
    await loadPricing(context);
    context.setAlert('');
    showPricingToast('Prețuri actualizate');
  }

  async function addHoliday(context, form) {
    await root.EcoVilaSupabase.insertHoliday(context.client, {
      date: toRecurringHolidayDate({
        day: qs('[data-holiday-day]', form).value,
        month: qs('[data-holiday-month]', form).value,
      }),
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
    renderPricingSchedule(pricing_tiers);
    renderHolidays(holidays);
    const dateInput = qs('[data-price-effective-from]');
    if (dateInput && !dateInput.value) {
      dateInput.value = todayISO();
    }

    root.document.querySelectorAll('[data-delete-holiday]').forEach((button) => {
      button.addEventListener('click', async () => {
        await root.EcoVilaSupabase.deleteHoliday(context.client, button.dataset.deleteHoliday);
        await loadPricing(context);
      });
    });
  }

  function setupPriceViews() {
    const buttons = Array.from(root.document.querySelectorAll('[data-price-view]'));
    if (!buttons.length) {
      return;
    }
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.priceView;
        buttons.forEach((other) => {
          const active = other.dataset.priceView === view;
          other.classList.toggle('is-active', active);
          other.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        root.document.querySelectorAll('[data-price-view-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.priceViewPanel !== view;
        });
      });
    });
  }

  function init(context) {
    setupPriceViews();
    qs('[data-save-prices]')?.addEventListener('click', () => {
      savePrices(context).catch((error) => context.setAlert(error?.message || 'Prețurile nu au putut fi salvate.'));
    });
    qs('[data-add-holiday-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      addHoliday(context, event.currentTarget).catch((error) => context.setAlert(error?.message || 'Ziua nu a putut fi adăugată.'));
    });
    loadPricing(context).catch((error) => context.setAlert(error?.message || 'Prețurile nu s-au putut încărca.'));
  }

  return {
    activePricingRows,
    resolveActiveRows,
    pricingSchedule,
    renderPricingSchedule,
    formatScheduleDate,
    dayBeforeISO,
    collectPricingRows,
    init,
    loadPricing,
    formatRecurringHoliday,
    savePrices,
    showPricingToast,
    pricing_tiers: 'pricing_tiers',
    holidays: 'holidays',
    effective_from: 'effective_from',
    toRecurringHolidayDate,
  };
});
