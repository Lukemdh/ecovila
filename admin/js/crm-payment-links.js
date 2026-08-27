(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.EcoVilaCrmPaymentLinks = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  let activeContext = null;
  const state = {
    links: [],
    loading: false,
    selectedRail: 'mia',
    selectedExpiry: null,
    activeRefundLink: null,
    nextBefore: null,
  };

  const RAIL_HINTS = Object.freeze({
    mia: 'MIA: comision redus, recomandat pentru clienți din Moldova (+373).',
    card: 'Card: acceptă plăți cu orice card bancar internațional (Visa / Mastercard).',
  });

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function qsa(selector, scope) {
    return Array.from((scope || root.document).querySelectorAll(selector));
  }

  function formatMDL(amount) {
    const pricing = root.EcoVilaPricing;
    if (pricing?.formatMDL) {
      return pricing.formatMDL(amount);
    }
    if (activeContext?.formatMDL) {
      return activeContext.formatMDL(amount);
    }
    return `${Number(amount || 0).toLocaleString('ro-MD')} MDL`;
  }

  function formatCreatedAt(value) {
    if (!value) return '--';
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return String(value);

    return new Intl.DateTimeFormat('ro-MD', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Chisinau',
    }).format(parsed);
  }

  async function copyToClipboard(text, button, input) {
    let copied = false;
    if (root.navigator?.clipboard?.writeText) {
      try {
        await root.navigator.clipboard.writeText(text);
        copied = true;
      } catch (_error) {
        copied = false;
      }
    }

    if (!copied && input) {
      try {
        input.focus?.();
        input.select?.();
        copied = Boolean(root.document?.execCommand?.('copy'));
      } catch (_error) {
        copied = false;
      }
    }

    if (button) {
      const originalText = button.textContent;
      if (copied) {
        button.textContent = 'Copiat!';
        root.setTimeout?.(() => {
          button.textContent = originalText;
        }, 2000);
      } else {
        if (input?.select) {
          input.select();
        }
        button.textContent = 'Copiază manual';
        root.setTimeout?.(() => {
          button.textContent = originalText;
        }, 3000);
      }
    }
  }

  function isLinkPayable(link) {
    const effective = link?.effectiveStatus || link?.status;
    return effective === 'active' || effective === 'pending';
  }

  function isLinkRefundable(link) {
    const status = link?.effectiveStatus || link?.status;
    const paid = Number(link?.paidAmount ?? link?.amount ?? 0);
    const refunded = Number(link?.refundedAmount ?? 0);
    return status === 'paid' && paid > 0 && refunded < paid;
  }

  function buildStatusBadge(link) {
    const effective = link?.effectiveStatus || link?.status || 'active';
    const badge = root.document.createElement('span');
    badge.className = `crm-link-status crm-link-status--${effective}`;

    if (effective === 'paid') {
      if (link.refundedAmount && link.refundedAmount > 0) {
        badge.textContent = `Achitat · restituit ${formatMDL(link.refundedAmount)}`;
      } else {
        badge.textContent = 'Achitat';
      }
      return badge;
    }

    if (effective === 'pending') {
      if (link.paymentRail === 'card' && link.lastAttempt?.status === 'pending') {
        badge.textContent = 'Plată inițiată — neconfirmată';
      } else {
        badge.textContent = 'Plată în curs';
      }
      return badge;
    }

    if (effective === 'active') {
      badge.textContent = 'Activ';
      return badge;
    }

    if (effective === 'expired') {
      badge.textContent = 'Expirat';
      return badge;
    }

    if (effective === 'revoked') {
      badge.textContent = 'Revocat';
      return badge;
    }

    if (effective === 'review') {
      badge.textContent = 'Necesită verificare';
      return badge;
    }

    badge.textContent = effective;
    return badge;
  }

  function buildLinkCard(link) {
    const card = root.document.createElement('article');
    card.className = 'crm-payment-link-card';
    card.dataset.linkId = link.id;

    // Manual review is the highest-priority fact in a money row.
    if (link.manualReview || link.effectiveStatus === 'review') {
      const warningStrip = root.document.createElement('div');
      warningStrip.className = 'crm-link-warning-strip';
      const ref = link.lastAttempt?.payId || link.lastAttempt?.providerPaymentId || link.settledAttemptId || '—';
      warningStrip.textContent = `Necesită verificare · Referință: ${ref}`;
      card.appendChild(warningStrip);
    }

    // Top row: Amount + Rail badge + Status badge
    const topRow = root.document.createElement('div');
    topRow.className = 'crm-link-card__top';

    const amountWrapper = root.document.createElement('div');
    amountWrapper.className = 'crm-link-amount';

    const amountEl = root.document.createElement('strong');
    amountEl.className = 'crm-link-amount__value';
    amountEl.textContent = formatMDL(link.amount);

    const railEl = root.document.createElement('span');
    railEl.className = 'crm-link-rail';
    railEl.textContent = link.paymentRail === 'mia' ? 'MIA' : 'Card';

    amountWrapper.append(amountEl, railEl);
    topRow.append(amountWrapper, buildStatusBadge(link));
    card.appendChild(topRow);

    // Pending attempt info for card
    if (link.paymentRail === 'card' && link.lastAttempt?.status === 'pending' && !link.manualReview) {
      const pendingInfo = root.document.createElement('div');
      pendingInfo.className = 'crm-link-pending-info';
      const ref = link.lastAttempt?.payId || link.lastAttempt?.providerPaymentId || '—';
      pendingInfo.textContent = `Sesiune checkout MAIB inițiată · Ref: ${ref}`;
      card.appendChild(pendingInfo);
    }

    // Label / Description row
    if (link.label) {
      const labelEl = root.document.createElement('div');
      labelEl.className = 'crm-link-label';
      labelEl.textContent = link.label;
      card.appendChild(labelEl);
    }

    // Meta details row
    const metaRow = root.document.createElement('div');
    metaRow.className = 'crm-link-meta';

    const createdEl = root.document.createElement('span');
    createdEl.textContent = `Creat: ${formatCreatedAt(link.createdAt)}`;

    const expiryEl = root.document.createElement('span');
    expiryEl.textContent = `Valabil: ${link.expiresAt ? formatCreatedAt(link.expiresAt) : 'fără expirare'}`;

    metaRow.append(createdEl, expiryEl);

    if (link.paidAt) {
      const paidEl = root.document.createElement('span');
      paidEl.textContent = `Achitat: ${formatCreatedAt(link.paidAt)}`;
      metaRow.appendChild(paidEl);
    }

    if (link.refundedAt) {
      const refundedEl = root.document.createElement('span');
      const noteSuffix = link.refundNote ? ` (${link.refundNote})` : '';
      refundedEl.textContent = `Restituit: ${formatCreatedAt(link.refundedAt)}${noteSuffix}`;
      metaRow.appendChild(refundedEl);
    }

    card.appendChild(metaRow);

    // Actions row
    const actionsRow = root.document.createElement('div');
    actionsRow.className = 'crm-link-actions';

    const copyBtn = root.document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'crm-button crm-button--small crm-button--ghost';
    copyBtn.dataset.action = 'copy';
    copyBtn.textContent = 'Copiază link';
    copyBtn.addEventListener('click', () => copyToClipboard(link.payUrl, copyBtn));
    actionsRow.appendChild(copyBtn);

    if (isLinkPayable(link)) {
      const revokeBtn = root.document.createElement('button');
      revokeBtn.type = 'button';
      revokeBtn.className = 'crm-button crm-button--small crm-button--danger';
      revokeBtn.dataset.action = 'revoke';
      revokeBtn.textContent = 'Revocă';
      revokeBtn.addEventListener('click', () => handleRevokeLink(link, revokeBtn));
      actionsRow.appendChild(revokeBtn);
    }

    if (isLinkRefundable(link)) {
      const refundBtn = root.document.createElement('button');
      refundBtn.type = 'button';
      refundBtn.className = 'crm-button crm-button--small';
      refundBtn.dataset.action = 'refund';
      refundBtn.textContent = 'Marchează ca restituit';
      refundBtn.addEventListener('click', () => handleOpenRefund(link));
      actionsRow.appendChild(refundBtn);
    }

    card.appendChild(actionsRow);
    return card;
  }

  function ensureLoadMoreButton() {
    let loadMoreBtn = qs('[data-link-load-more]');
    if (!loadMoreBtn) {
      const list = qs('[data-link-list]');
      if (list && list.parentNode) {
        loadMoreBtn = root.document.createElement('button');
        loadMoreBtn.type = 'button';
        loadMoreBtn.className = 'crm-button crm-button--small crm-link-load-more';
        loadMoreBtn.dataset.linkLoadMore = '';
        loadMoreBtn.textContent = 'Încarcă mai multe';
        loadMoreBtn.hidden = true;
        loadMoreBtn.addEventListener('click', () => {
          loadLinks({ append: true });
        });
        if (list.nextSibling) {
          list.parentNode.insertBefore(loadMoreBtn, list.nextSibling);
        } else {
          list.parentNode.appendChild(loadMoreBtn);
        }
      }
    }
    return loadMoreBtn;
  }

  function renderLinkList() {
    const list = qs('[data-link-list]');
    const empty = qs('[data-link-empty]');
    if (!list) return;

    list.innerHTML = '';
    const links = state.links || [];

    if (empty) {
      empty.hidden = links.length > 0;
    }

    links.forEach((link) => {
      list.appendChild(buildLinkCard(link));
    });

    const loadMoreBtn = ensureLoadMoreButton();
    if (loadMoreBtn) {
      loadMoreBtn.hidden = !state.nextBefore || links.length === 0;
    }
  }

  async function loadLinks(options = {}) {
    if (!activeContext?.client) return;
    const append = Boolean(options && options.append);
    if (append && !state.nextBefore) return;

    state.loading = true;
    const loadMoreBtn = qs('[data-link-load-more]');
    if (loadMoreBtn && append) {
      loadMoreBtn.disabled = true;
    }

    try {
      const params = { limit: 50 };
      if (append && state.nextBefore) {
        params.before = state.nextBefore;
      }
      const result = await root.EcoVilaSupabase.listPaymentLinks(activeContext.client, params);
      const incoming = Array.isArray(result?.links) ? result.links : [];

      if (append) {
        const existingIds = new Set(state.links.map((l) => l.id));
        incoming.forEach((link) => {
          if (!existingIds.has(link.id)) {
            state.links.push(link);
            existingIds.add(link.id);
          }
        });
      } else {
        state.links = incoming;
      }

      state.nextBefore = result?.nextBefore || null;
      renderLinkList();
    } catch (error) {
      activeContext?.setAlert?.(error?.message || 'Linkurile de plată nu s-au putut încărca.');
    } finally {
      state.loading = false;
      if (loadMoreBtn) {
        loadMoreBtn.disabled = false;
      }
    }
  }

  async function handleRevokeLink(link, button) {
    const confirmMessage = 'Revoci acest link de plată? Oaspetele nu va mai putea achita.';
    if (typeof root.confirm === 'function' && !root.confirm(confirmMessage)) {
      return;
    }

    if (button) button.disabled = true;

    try {
      const result = await root.EcoVilaSupabase.revokePaymentLink(activeContext.client, { id: link.id });
      const updated = result?.link || result;
      if (updated && typeof updated === 'object') {
        Object.assign(link, updated);
      } else {
        link.status = 'revoked';
        link.effectiveStatus = 'revoked';
      }
      renderLinkList();
      activeContext?.setAlert?.('');
    } catch (error) {
      if (button) button.disabled = false;
      activeContext?.setAlert?.(error?.message || 'Linkul nu a putut fi revocat.');
    }
  }

  function handleOpenRefund(link) {
    state.activeRefundLink = link;
    const dialog = qs('[data-link-refund-dialog]');
    const amountInput = qs('[data-link-refund-amount]', dialog);
    const noteInput = qs('[data-link-refund-note]', dialog);
    const errorEl = qs('[data-link-refund-error]', dialog);

    if (errorEl) {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }

    const paidAmount = Number(link.paidAmount || link.amount || 0);
    const alreadyRefunded = Number(link.refundedAmount || 0);
    const prefillAmount = alreadyRefunded > 0 ? alreadyRefunded : paidAmount;

    if (amountInput) {
      amountInput.value = String(prefillAmount);
      amountInput.min = '1';
      amountInput.max = String(paidAmount);
      const labelSpan = amountInput.closest?.('label')?.querySelector?.('span');
      if (labelSpan) {
        labelSpan.textContent = `Total nou restituit (MDL, max ${formatMDL(paidAmount)}) — suma totală cumulată, nu adițională`;
      }
    }
    if (noteInput) {
      noteInput.value = link.refundNote || '';
    }

    if (dialog?.showModal) {
      dialog.showModal();
    } else {
      // Fallback for non-dialog environments / testing
      const promptAmount = root.prompt?.(
        `Total nou restituit (MDL, max ${paidAmount}) — suma totală cumulată, nu adițională:`,
        String(prefillAmount),
      );
      if (promptAmount) {
        const numAmount = parseInt(promptAmount, 10);
        if (Number.isInteger(numAmount) && numAmount > 0 && numAmount <= paidAmount) {
          executeRefund(link, numAmount, null);
        }
      }
    }
  }

  async function executeRefund(link, amount, note) {
    try {
      const result = await root.EcoVilaSupabase.markPaymentLinkRefunded(activeContext.client, {
        id: link.id,
        amount,
        note,
      });
      const updated = result?.link || result;
      if (updated && typeof updated === 'object') {
        Object.assign(link, updated);
      }
      renderLinkList();
      activeContext?.setAlert?.('');
      return true;
    } catch (error) {
      activeContext?.setAlert?.(error?.message || 'Restituirea nu a putut fi înregistrată.');
      throw error;
    }
  }

  function wireCreationForm() {
    const form = qs('[data-link-create-form]');
    const amountInput = qs('[data-link-amount]');
    const labelInput = qs('[data-link-label]');
    const createBtn = qs('[data-link-create]');
    const createError = qs('[data-link-create-error]');
    const resultBlock = qs('[data-link-result]');
    const urlInput = qs('[data-link-url]');
    const copyBtn = qs('[data-link-copy]');
    const openLink = qs('[data-link-open]');
    const railHint = qs('[data-link-rail-hint]');

    // Wire rail buttons
    qsa('[data-link-rail]').forEach((button) => {
      button.addEventListener('click', () => {
        const rail = button.dataset.linkRail;
        state.selectedRail = rail;
        qsa('[data-link-rail]').forEach((btn) => {
          const isActive = btn.dataset.linkRail === rail;
          btn.classList.toggle('is-active', isActive);
          btn.setAttribute('aria-pressed', String(isActive));
        });
        if (railHint) {
          railHint.textContent = RAIL_HINTS[rail] || '';
        }
      });
    });

    // Wire expiry pills
    qsa('[data-link-expiry]').forEach((button) => {
      button.addEventListener('click', () => {
        const value = button.dataset.linkExpiry;
        state.selectedExpiry = value ? Number(value) : null;
        qsa('[data-link-expiry]').forEach((btn) => {
          const isActive = btn.dataset.linkExpiry === value;
          btn.classList.toggle('is-active', isActive);
          btn.setAttribute('aria-pressed', String(isActive));
        });
      });
    });

    // Wire copy button in result block
    copyBtn?.addEventListener('click', () => {
      if (urlInput?.value) {
        copyToClipboard(urlInput.value, copyBtn, urlInput);
      }
    });

    // Wire refresh button
    qs('[data-link-refresh]')?.addEventListener('click', () => {
      loadLinks();
    });

    // Wire refund dialog
    const refundDialog = qs('[data-link-refund-dialog]');
    const refundForm = qs('[data-link-refund-form]');
    const refundCancel = qs('[data-link-refund-cancel]');
    const refundError = qs('[data-link-refund-error]');
    const refundAmountInput = qs('[data-link-refund-amount]');
    const refundNoteInput = qs('[data-link-refund-note]');
    const refundSubmit = qs('[data-link-refund-submit]');

    refundCancel?.addEventListener('click', () => {
      refundDialog?.close?.('cancel');
    });

    refundForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const link = state.activeRefundLink;
      if (!link) return;

      const amount = parseInt(refundAmountInput?.value || '', 10);
      const note = refundNoteInput?.value?.trim() || null;
      const maxAmount = Number(link.paidAmount || link.amount || 0);

      if (!Number.isInteger(amount) || amount < 1 || amount > maxAmount) {
        if (refundError) {
          refundError.textContent = `Introdu o sumă validă între 1 și ${formatMDL(maxAmount)} (totalul cumulativ nou restituit).`;
          refundError.hidden = false;
        }
        return;
      }

      if (typeof root.confirm === 'function' && !root.confirm(`Înregistrezi noul total restituit de ${formatMDL(amount)} din ${formatMDL(maxAmount)}?`)) {
        return;
      }

      if (refundSubmit) refundSubmit.disabled = true;
      if (refundError) refundError.hidden = true;

      try {
        await executeRefund(link, amount, note);
        refundDialog?.close?.('confirm');
      } catch (error) {
        if (refundError) {
          refundError.textContent = error?.message || 'Restituirea nu a putut fi înregistrată.';
          refundError.hidden = false;
        }
      } finally {
        if (refundSubmit) refundSubmit.disabled = false;
      }
    });

    // Wire creation form submit
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const amount = parseInt(amountInput?.value || '', 10);
      const label = labelInput?.value?.trim() || null;

      if (!Number.isInteger(amount) || amount < 1 || amount > 1000000) {
        if (createError) {
          createError.textContent = 'Introdu o sumă între 1 și 1.000.000 MDL.';
          createError.hidden = false;
        }
        amountInput?.focus();
        return;
      }

      if (label && Array.from(label).length > 120) {
        if (createError) {
          createError.textContent = 'Descrierea poate avea cel mult 120 de caractere.';
          createError.hidden = false;
        }
        labelInput?.focus();
        return;
      }

      if (createError) {
        createError.textContent = '';
        createError.hidden = true;
      }

      if (createBtn) createBtn.disabled = true;

      try {
        const result = await root.EcoVilaSupabase.createPaymentLink(activeContext.client, {
          amount,
          paymentRail: state.selectedRail,
          expiresInHours: state.selectedExpiry,
          label,
        });

        const link = result?.link || result;
        if (resultBlock && urlInput) {
          resultBlock.hidden = false;
          urlInput.value = link.payUrl;
          if (openLink) {
            openLink.href = link.payUrl;
          }
        }

        if (link && link.id) {
          state.links.unshift(link);
          renderLinkList();
        }

        if (amountInput) amountInput.value = '';
        if (labelInput) labelInput.value = '';
      } catch (error) {
        if (createError) {
          createError.textContent = error?.message || 'Linkul de plată nu a putut fi generat.';
          createError.hidden = false;
        }
      } finally {
        if (createBtn) createBtn.disabled = false;
      }
    });
  }

  function showPanel() {
    loadLinks();
    const amountInput = qs('[data-link-amount]');
    amountInput?.focus?.();
  }

  function init(context) {
    activeContext = context;
    wireCreationForm();
    loadLinks();

    if (context?.client?.channel) {
      context.client
        .channel('crm-payment-links-realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'payment_links' }, () => loadLinks())
        .subscribe();
    }
  }

  return {
    init,
    showPanel,
    loadLinks,
    renderLinkList,
    formatMDL,
    formatCreatedAt,
    state,
  };
});
