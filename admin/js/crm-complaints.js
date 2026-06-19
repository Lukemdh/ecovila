(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmComplaints = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const COMPLAINTS_TABLE = 'complaints';
  const CATEGORY_LABELS = {
    casuta: 'Căsuța',
    facilitati: 'Facilități',
    personal: 'Personal',
    altceva: 'Altceva',
  };

  let active = null;

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function qsa(selector, scope) {
    return Array.from((scope || root.document).querySelectorAll(selector));
  }

  function helpers() {
    return root.EcoVilaSupabase;
  }

  function isPanelActive() {
    return Boolean(qs('[data-panel="probleme"]')?.classList?.contains('is-active'));
  }

  function setBadge(count) {
    const badge = qs('[data-complaints-badge]');
    if (!badge) {
      return;
    }
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count <= 0;
  }

  async function refreshBadge() {
    if (!active) {
      return;
    }
    try {
      const count = await helpers().countUnreadComplaints(active.context.client, active.lastSeenAt);
      setBadge(count);
    } catch (error) {
      // A failed badge count must never break the CRM; the list still loads.
      console.error('complaints badge count failed', error);
    }
  }

  function formatCreated(context, value) {
    const dateOnly = String(value || '').slice(0, 10);
    return dateOnly ? context.formatDate(dateOnly) : '';
  }

  function buildCard(context, complaint, view) {
    const card = root.document.createElement('article');
    card.className = 'crm-complaint-card';
    card.dataset.complaintId = complaint.id;

    const head = root.document.createElement('div');
    head.className = 'crm-complaint-card__head';

    const category = root.document.createElement('span');
    category.className = 'crm-complaint-card__category';
    category.textContent = CATEGORY_LABELS[complaint.category] || complaint.category;
    head.appendChild(category);

    const date = root.document.createElement('span');
    date.className = 'crm-complaint-card__date';
    date.textContent = formatCreated(context, complaint.created_at);
    head.appendChild(date);
    card.appendChild(head);

    // User-supplied text — set via textContent so a description can never inject
    // markup into the dashboard.
    const text = root.document.createElement('p');
    text.className = 'crm-complaint-card__text';
    text.textContent = complaint.description || '';
    card.appendChild(text);

    const meta = root.document.createElement('div');
    meta.className = 'crm-complaint-card__meta';

    const guest = root.document.createElement('span');
    guest.className = 'crm-complaint-card__guest';
    if (complaint.is_anonymous) {
      guest.classList.add('crm-complaint-card__guest--anon');
      guest.textContent = 'Anonim';
    } else {
      const parts = [complaint.guest_first_name, complaint.guest_phone].filter(Boolean);
      guest.textContent = parts.join(' · ') || '—';
    }
    meta.appendChild(guest);

    if (complaint.language) {
      const lang = root.document.createElement('span');
      lang.className = 'crm-complaint-card__lang';
      lang.textContent = String(complaint.language).toUpperCase();
      meta.appendChild(lang);
    }
    card.appendChild(meta);

    if (view === 'archive') {
      if (complaint.solved_at) {
        const solved = root.document.createElement('p');
        solved.className = 'crm-complaint-card__solved';
        solved.textContent = `Rezolvată · ${formatCreated(context, complaint.solved_at)}`;
        card.appendChild(solved);
      }
    } else {
      const actions = root.document.createElement('div');
      actions.className = 'crm-complaint-card__actions';
      const button = root.document.createElement('button');
      button.className = 'crm-button crm-button--primary crm-button--small';
      button.type = 'button';
      button.dataset.complaintSolve = '';
      button.textContent = 'Marchează rezolvată';
      button.addEventListener('click', () => solveComplaint(context, complaint.id, button));
      actions.appendChild(button);
      card.appendChild(actions);
    }

    return card;
  }

  function renderList(context, complaints, view) {
    const list = qs('[data-complaints-list]');
    if (!list) {
      return;
    }

    list.innerHTML = '';

    if (!complaints.length) {
      const empty = root.document.createElement('p');
      empty.className = 'crm-complaints-empty';
      empty.textContent = view === 'archive'
        ? 'Nu există probleme rezolvate.'
        : 'Nu există probleme noi.';
      list.appendChild(empty);
      return;
    }

    complaints.forEach((complaint) => list.appendChild(buildCard(context, complaint, view)));
  }

  async function loadList(context, state) {
    const status = state.view === 'archive' ? 'solved' : 'new';
    try {
      const complaints = await helpers().fetchComplaints(context.client, { status });
      renderList(context, complaints, state.view);
    } catch (error) {
      context.setAlert(error?.message || 'Problemele nu s-au putut încărca.');
    }
  }

  async function solveComplaint(context, complaintId, button) {
    if (button) {
      button.disabled = true;
    }
    try {
      await helpers().markComplaintSolved(context.client, complaintId, context.session.user.id);
      // The realtime UPDATE event reloads both views, but reload now so the click
      // feels immediate even if realtime is delayed.
      if (active) {
        await loadList(context, active.state);
      }
    } catch (error) {
      if (button) {
        button.disabled = false;
      }
      context.setAlert(error?.message || 'Problema nu a putut fi marcată ca rezolvată.');
    }
  }

  function setView(context, state, view) {
    state.view = view === 'archive' ? 'archive' : 'current';
    qsa('[data-complaints-view]').forEach((tab) => {
      const isActive = tab.dataset.complaintsView === state.view;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
    });
    return loadList(context, state);
  }

  async function markRead(context) {
    if (!active) {
      return;
    }
    const now = new Date().toISOString();
    active.lastSeenAt = now;
    setBadge(0);
    try {
      await helpers().upsertComplaintReadState(context.client, context.session.user.id);
    } catch (error) {
      // Losing the cursor write just means the badge re-counts from the old
      // timestamp next time; not worth alarming the user.
      console.error('complaint read-state upsert failed', error);
    }
  }

  // Called by crm-app when the Probleme tab is opened: clear the unread badge,
  // record this view as "seen", and (re)load the current list.
  function showPanel() {
    if (!active) {
      return;
    }
    const { context, state } = active;
    markRead(context);
    loadList(context, state);
  }

  function init(context) {
    const state = { view: 'current' };
    active = { context, state, lastSeenAt: null };

    qsa('[data-complaints-view]').forEach((tab) => {
      tab.addEventListener('click', () => setView(context, state, tab.dataset.complaintsView));
    });

    // Establish the unread cursor + badge without marking the page seen (the
    // staff member has not opened the tab yet). markRead always writes a non-null
    // timestamp, so if the tab was opened before this resolves we must NOT clobber
    // that fresh cursor with the older stored one (which would resurrect the
    // badge the user just cleared).
    helpers()
      .fetchComplaintReadState(context.client, context.session.user.id)
      .then((readState) => {
        if (active && active.lastSeenAt === null) {
          active.lastSeenAt = readState?.last_seen_at || null;
        }
        return refreshBadge();
      })
      .catch((error) => console.error('complaint read-state load failed', error));

    context.client
      .channel('crm-complaints')
      .on('postgres_changes', { event: '*', schema: 'public', table: COMPLAINTS_TABLE }, () => {
        if (isPanelActive()) {
          markRead(context);
          loadList(context, state);
        } else {
          refreshBadge();
        }
      })
      .subscribe();
  }

  return {
    COMPLAINTS_TABLE,
    CATEGORY_LABELS,
    init,
    showPanel,
    setView,
    renderList,
    buildCard,
  };
});
