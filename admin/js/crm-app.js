(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmApp = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  // The active tab is mirrored to the URL hash (#finance, #daily, ...) so a page
  // refresh restores the view the user was on instead of snapping back to the
  // dashboard/calendar. The dashboard is the default and stays on a clean URL.
  const TAB_NAMES = ['dashboard', 'finance', 'daily', 'towels', 'photos', 'pricing'];
  // Per-role visible tabs. Angela operates a read-only dashboard plus the daily
  // ("Situația zilnică") and towels tabs; finance, photos and pricing are hidden
  // for her. Roles not listed here (e.g. diana) see every tab. The same boundary
  // is enforced server-side by RLS on public.reservations.
  const ROLE_TABS = Object.freeze({
    angela: ['dashboard', 'daily', 'towels'],
  });
  let allowedTabs = TAB_NAMES;
  let hashNavigationWired = false;

  function isTabAllowed(name) {
    return allowedTabs.includes(name);
  }

  function applyTabVisibility() {
    qsa('[data-tab]').forEach((button) => {
      button.hidden = !isTabAllowed(button.dataset.tab);
    });
  }

  function resolveTabFromHash() {
    const hash = String(root.location?.hash || '').replace(/^#/, '');
    return isTabAllowed(hash) ? hash : null;
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
    // Clamp to the role's allowed tabs so a stale hash (#finance) or a direct
    // call can never surface a hidden tab.
    const target = isTabAllowed(name) ? name : 'dashboard';

    qsa('[data-tab]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.tab === target);
    });

    qsa('[data-panel]').forEach((panel) => {
      panel.classList.toggle('is-active', panel.dataset.panel === target);
    });

    if (target === 'daily') {
      root.EcoVilaCrmDaily?.showToday?.();
    }
    if (target === 'finance') {
      root.EcoVilaCrmFinance?.showToday?.();
    }
    if (target === 'towels') {
      root.EcoVilaCrmTowels?.showToday?.();
    }

    syncTabHash(target);
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
      timeZone: 'UTC',
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

      allowedTabs = ROLE_TABS[sessionState.role] || TAB_NAMES;
      applyTabVisibility();

      const context = {
        client: sessionState.client,
        role: sessionState.role,
        session: sessionState.session,
        permissions: {
          tabs: allowedTabs,
          // A read-only dashboard means Angela can view the calendar and search,
          // but cannot add, swap, mark paid or cancel reservations.
          dashboardReadOnly: sessionState.role === 'angela',
        },
        setAlert,
        setActiveTab,
        formatDate,
        formatMDL,
      };

      // Dashboard, daily and towels are visible to every CRM role; the rest only
      // initialise (and fetch their data) when the role is allowed to see them.
      root.EcoVilaCrmDashboard?.init?.(context);
      root.EcoVilaCrmDaily?.init?.(context);
      root.EcoVilaCrmTowels?.init?.(context);
      if (isTabAllowed('finance')) {
        root.EcoVilaCrmFinance?.init?.(context);
      }
      if (isTabAllowed('photos')) {
        root.EcoVilaCrmPhotos?.init?.(context);
      }
      if (isTabAllowed('pricing')) {
        root.EcoVilaCrmPricing?.init?.(context);
      }
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
