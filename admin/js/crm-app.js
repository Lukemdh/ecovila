(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmApp = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

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
    if (name === 'towels') {
      root.EcoVilaCrmTowels?.showToday?.();
    }
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
    setActiveTab(qs('[data-tab].is-active')?.dataset.tab || 'dashboard');

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
      root.EcoVilaCrmDaily?.init?.(context);
      root.EcoVilaCrmTowels?.init?.(context);
      root.EcoVilaCrmPhotos?.init?.(context);
      root.EcoVilaCrmPricing?.init?.(context);
      setActiveTab('dashboard');
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
