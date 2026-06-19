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

  // Inline SVGs (feather-style, currentColor) kept as trusted constants so they
  // can be set via innerHTML without ever touching guest-supplied data.
  const ICON_USER =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>';
  const ICON_ANON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13h20"/><path d="M4 13l1.6-5.2A2 2 0 0 1 7.5 6.4h9a2 2 0 0 1 1.9 1.4L20 13"/><circle cx="7" cy="16.5" r="2.5"/><circle cx="17" cy="16.5" r="2.5"/><path d="M9.5 16.2c.8-.5 4.2-.5 5 0"/></svg>';
  const ICON_PHONE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const ICON_EMPTY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  let active = null;
  let lastFocused = null;

  function ce(tag, className) {
    const el = root.document.createElement(tag);
    if (className) {
      el.className = className;
    }
    return el;
  }

  function svgEl(markup) {
    const span = ce('span', 'crm-icon');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = markup; // trusted static constant — never guest data
    return span;
  }

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

  // Footer identity block: a guest icon + name, plus a tappable phone link when
  // a number was left. All text values stay textContent so guest data is inert.
  function buildGuest(complaint) {
    const who = root.document.createElement('div');
    who.className = 'crm-complaint-card__who';

    const guest = root.document.createElement('span');
    guest.className = 'crm-complaint-card__guest';

    if (complaint.is_anonymous) {
      guest.classList.add('crm-complaint-card__guest--anon');
      guest.appendChild(svgEl(ICON_ANON));
      const label = root.document.createElement('span');
      label.textContent = 'Anonim';
      guest.appendChild(label);
      who.appendChild(guest);
      return who;
    }

    guest.appendChild(svgEl(ICON_USER));
    const name = root.document.createElement('span');
    name.textContent = complaint.guest_first_name || 'Oaspete';
    guest.appendChild(name);
    who.appendChild(guest);

    if (complaint.guest_phone) {
      const phone = root.document.createElement('a');
      phone.className = 'crm-complaint-card__phone';
      phone.href = `tel:${String(complaint.guest_phone).replace(/[^+\d]/g, '')}`;
      phone.appendChild(svgEl(ICON_PHONE));
      const num = root.document.createElement('span');
      num.textContent = complaint.guest_phone;
      phone.appendChild(num);
      who.appendChild(phone);
    }

    return who;
  }

  function buildCategoryChip(complaint) {
    const category = ce('span', 'crm-complaint-card__category');
    const dot = ce('span', 'crm-complaint-card__dot');
    dot.setAttribute('aria-hidden', 'true');
    category.appendChild(dot);
    const label = ce('span');
    label.textContent = CATEGORY_LABELS[complaint.category] || complaint.category || '—';
    category.appendChild(label);
    return category;
  }

  function buildSolvedBadge(context, complaint) {
    const solved = ce('span', 'crm-complaint-card__solved');
    solved.appendChild(svgEl(ICON_CHECK));
    const label = ce('span');
    label.textContent = `Rezolvată · ${formatCreated(context, complaint.solved_at)}`;
    solved.appendChild(label);
    return solved;
  }

  // The resolve button is reused on the card and inside the detail modal; the
  // optional onDone callback lets the modal close itself once the write lands.
  // The card uses a short label to keep the footer on a single line; the modal
  // has room for the full call-to-action.
  function buildSolveButton(context, complaint, onDone, labelText) {
    const button = ce('button', 'crm-button crm-button--primary crm-button--small crm-complaint-card__solve');
    button.type = 'button';
    button.dataset.complaintSolve = '';
    button.appendChild(svgEl(ICON_CHECK));
    const label = ce('span');
    label.textContent = labelText || 'Marchează rezolvată';
    button.appendChild(label);
    button.addEventListener('click', async () => {
      const ok = await solveComplaint(context, complaint.id, button);
      if (ok && typeof onDone === 'function') {
        onDone();
      }
    });
    return button;
  }

  function buildCard(context, complaint, view) {
    const card = ce('article', 'crm-complaint-card');
    if (complaint.category) {
      card.classList.add(`crm-complaint-card--${complaint.category}`);
    }
    if (view === 'archive') {
      card.classList.add('crm-complaint-card--resolved');
    }
    card.dataset.complaintId = complaint.id;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.setAttribute('aria-haspopup', 'dialog');

    const head = ce('div', 'crm-complaint-card__head');
    head.appendChild(buildCategoryChip(complaint));

    const headRight = ce('div', 'crm-complaint-card__head-right');
    const date = ce('span', 'crm-complaint-card__date');
    date.textContent = formatCreated(context, complaint.created_at);
    headRight.appendChild(date);
    if (complaint.language) {
      const lang = ce('span', 'crm-complaint-card__lang');
      lang.textContent = String(complaint.language).toUpperCase();
      headRight.appendChild(lang);
    }
    head.appendChild(headRight);
    card.appendChild(head);

    // User-supplied text — set via textContent so a description can never inject
    // markup into the dashboard. CSS clamps it to a fixed height; the full text
    // lives in the detail modal opened on click.
    const text = ce('p', 'crm-complaint-card__text');
    text.textContent = complaint.description || '';
    card.appendChild(text);

    const footer = ce('div', 'crm-complaint-card__footer');
    footer.appendChild(buildGuest(complaint));
    if (view === 'archive') {
      if (complaint.solved_at) {
        footer.appendChild(buildSolvedBadge(context, complaint));
      }
    } else {
      footer.appendChild(buildSolveButton(context, complaint, null, 'Rezolvă'));
    }
    card.appendChild(footer);

    // Click anywhere on the card (except the phone link / resolve button) opens
    // the enlarged detail view so cropped descriptions stay readable.
    const open = (event) => {
      if (event.target.closest('a, button')) {
        return;
      }
      openDetail(context, complaint, view);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === card) {
        event.preventDefault();
        openDetail(context, complaint, view);
      }
    });

    return card;
  }

  function ensureDetailModal() {
    let overlay = qs('[data-complaint-detail]');
    if (overlay) {
      return overlay;
    }
    overlay = ce('div', 'crm-complaint-modal');
    overlay.dataset.complaintDetail = '';
    overlay.hidden = true;

    const backdrop = ce('div', 'crm-complaint-modal__backdrop');
    backdrop.dataset.close = '';
    overlay.appendChild(backdrop);

    const dialog = ce('div', 'crm-complaint-modal__dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    overlay.appendChild(dialog);

    overlay.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) {
        closeDetail();
      }
    });
    root.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !overlay.hidden) {
        closeDetail();
      }
    });

    root.document.body.appendChild(overlay);
    return overlay;
  }

  function openDetail(context, complaint, view) {
    const overlay = ensureDetailModal();
    const dialog = qs('.crm-complaint-modal__dialog', overlay);
    dialog.className = 'crm-complaint-modal__dialog';
    if (complaint.category) {
      dialog.classList.add(`crm-complaint-card--${complaint.category}`);
    }
    dialog.innerHTML = '';

    const top = ce('div', 'crm-complaint-modal__top');
    top.appendChild(buildCategoryChip(complaint));
    const close = ce('button', 'crm-complaint-modal__close');
    close.type = 'button';
    close.dataset.close = '';
    close.setAttribute('aria-label', 'Închide');
    close.appendChild(svgEl(ICON_CLOSE));
    top.appendChild(close);
    dialog.appendChild(top);

    const meta = ce('div', 'crm-complaint-modal__meta');
    const date = ce('span');
    date.textContent = formatCreated(context, complaint.created_at);
    meta.appendChild(date);
    if (complaint.language) {
      const sep = ce('span', 'crm-complaint-modal__sep');
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '·';
      meta.appendChild(sep);
      const lang = ce('span');
      lang.textContent = String(complaint.language).toUpperCase();
      meta.appendChild(lang);
    }
    dialog.appendChild(meta);

    // Full, unclamped description — textContent keeps guest input inert.
    const text = ce('p', 'crm-complaint-modal__text');
    text.textContent = complaint.description || '';
    dialog.appendChild(text);

    const footer = ce('div', 'crm-complaint-card__footer');
    footer.appendChild(buildGuest(complaint));
    if (view === 'archive') {
      if (complaint.solved_at) {
        footer.appendChild(buildSolvedBadge(context, complaint));
      }
    } else {
      footer.appendChild(buildSolveButton(context, complaint, closeDetail));
    }
    dialog.appendChild(footer);

    lastFocused = root.document.activeElement;
    overlay.hidden = false;
    root.document.body.classList.add('crm-modal-open');
    close.focus();
  }

  function closeDetail() {
    const overlay = qs('[data-complaint-detail]');
    if (!overlay) {
      return;
    }
    overlay.hidden = true;
    root.document.body.classList.remove('crm-modal-open');
    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
    }
    lastFocused = null;
  }

  function setCount(count) {
    const el = qs('[data-complaints-count]');
    if (!el) {
      return;
    }
    el.textContent = count
      ? `${count} ${count === 1 ? 'sesizare' : 'sesizări'}`
      : '';
  }

  function renderList(context, complaints, view) {
    const list = qs('[data-complaints-list]');
    if (!list) {
      return;
    }

    list.innerHTML = '';
    setCount(complaints.length);

    if (!complaints.length) {
      const empty = root.document.createElement('div');
      empty.className = 'crm-complaints-empty';
      empty.appendChild(svgEl(ICON_EMPTY));
      const msg = root.document.createElement('p');
      msg.textContent = view === 'archive'
        ? 'Nu există probleme rezolvate.'
        : 'Nu există probleme noi. Totul e sub control.';
      empty.appendChild(msg);
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
      return true;
    } catch (error) {
      if (button) {
        button.disabled = false;
      }
      context.setAlert(error?.message || 'Problema nu a putut fi marcată ca rezolvată.');
      return false;
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
