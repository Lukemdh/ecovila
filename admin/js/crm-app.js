(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmApp = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  // The active tab is mirrored to the URL hash (#finance, #daily, ...) so a page
  // refresh restores the view the user was on instead of snapping back to the
  // dashboard/calendar. The dashboard is the default and stays on a clean URL.
  const TAB_NAMES = ['dashboard', 'finance', 'daily', 'towels', 'photos', 'pricing'];
  let hashNavigationWired = false;

  function resolveTabFromHash() {
    const hash = String(root.location?.hash || '').replace(/^#/, '');
    return TAB_NAMES.includes(hash) ? hash : null;
  }

  function syncTabHash(name) {
    if (!TAB_NAMES.includes(name) || !root.history?.replaceState || !root.location) {
      return;
    }

    const location = root.location;
    // replaceState (not `location.hash =`) keeps tab switches out of the browser
    // history, so Back leaves the CRM rather than cycling through tabs, and it
    // never fires a `hashchange` (avoids re-entering the listener below).
    if (name === 'dashboard') {
      if (location.hash) {
        root.history.replaceState(null, '', `${location.pathname}${location.search}`);
      }
      return;
    }

    if (location.hash !== `#${name}`) {
      root.history.replaceState(null, '', `#${name}`);
    }
  }

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function qsa(selector, scope) {
    return Array.from((scope || root.document).querySelectorAll(selector));
  }

  function setAlert(message) {
    const alert = qs('[data-crm-alert]');
    if (!alert) {
      return;
    }

    alert.textContent = message || '';
    alert.hidden = !message;
  }

  function setActiveTab(name) {
    qsa('[data-tab]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.tab === name);
    });

    qsa('[data-panel]').forEach((panel) => {
      panel.classList.toggle('is-active', panel.dataset.panel === name);
    });

    if (name === 'daily') {
      root.EcoVilaCrmDaily?.showToday?.();
    }
    if (name === 'finance') {
      root.EcoVilaCrmFinance?.showCurrentMonth?.();
    }
    if (name === 'towels') {
      root.EcoVilaCrmTowels?.showToday?.();
    }

    syncTabHash(name);
  }

  function wireTabs() {
    qsa('[data-tab]').forEach((button) => {
      if (button.dataset.crmTabWired === 'true') {
        return;
      }

      button.dataset.crmTabWired = 'true';
      button.addEventListener('click', () => setActiveTab(button.dataset.tab));
    });
  }

  function wireHashNavigation() {
    if (hashNavigationWired || typeof root.addEventListener !== 'function') {
      return;
    }

    hashNavigationWired = true;
    // Follow direct #tab links / manual hash edits that arrive after load.
    root.addEventListener('hashchange', () => {
      const tab = resolveTabFromHash();
      if (tab && tab !== qs('[data-tab].is-active')?.dataset.tab) {
        setActiveTab(tab);
      }
    });
  }

  function formatDate(date) {
    return new Intl.DateTimeFormat('ro-MD', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(`${date}T00:00:00Z`));
  }

  function formatMDL(amount) {
    const pricing = root.EcoVilaPricing;
    return pricing?.formatMDL ? pricing.formatMDL(amount) : `${Number(amount || 0).toLocaleString('ro-MD')} MDL`;
  }

  async function init() {
    const app = qs('[data-crm-app]');
    if (!app) {
      return;
    }

    app.hidden = false;
    wireTabs();
    wireHashNavigation();
    setActiveTab(resolveTabFromHash() || qs('[data-tab].is-active')?.dataset.tab || 'dashboard');

    try {
      const auth = root.EcoVilaCrmAuth;
      const sessionState = await auth.requireSession();

      if (!sessionState) {
        return;
      }

      qs('[data-crm-user-label]').textContent = sessionState.role === 'angela' ? 'Angela' : 'Diana';
      qs('[data-crm-sign-out]')?.addEventListener('click', () => auth.signOut(sessionState.client));

      const context = {
        client: sessionState.client,
        role: sessionState.role,
        session: sessionState.session,
        setAlert,
        setActiveTab,
        formatDate,
        formatMDL,
      };

      root.EcoVilaCrmDashboard?.init?.(context);
      root.EcoVilaCrmFinance?.init?.(context);
      root.EcoVilaCrmDaily?.init?.(context);
      root.EcoVilaCrmTowels?.init?.(context);
      root.EcoVilaCrmPhotos?.init?.(context);
      root.EcoVilaCrmPricing?.init?.(context);
      setActiveTab(resolveTabFromHash() || 'dashboard');
    } catch (error) {
      app.hidden = false;
      setAlert(error?.message || 'CRM nu poate porni. Verifică configurarea Supabase.');
    }
  }

  if (root.document?.querySelector('[data-crm-app]')) {
    init();
  }

  return {
    formatDate,
    formatMDL,
    init,
    setActiveTab,
  };
});
