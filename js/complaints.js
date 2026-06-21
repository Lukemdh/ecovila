(function () {
  'use strict';

  const doc = document;
  const app = doc.querySelector('[data-complaints-app]');
  if (!app) {
    return;
  }

  const helpers = window.EcoVilaSupabase;
  const state = {
    category: '',
    submitting: false,
  };
  let client = null;

  function getLanguage() {
    return doc.documentElement.lang || window.localStorage?.getItem('ecovila_language') || 'ro';
  }

  function t(key) {
    const dictionaries = window.EcoVilaTranslations || {};
    const language = getLanguage();
    return dictionaries[language]?.[key] || dictionaries.ro?.[key] || key;
  }

  function el(selector) {
    return app.querySelector(selector);
  }

  function show(node) {
    if (node) {
      node.hidden = false;
    }
  }

  function hide(node) {
    if (node) {
      node.hidden = true;
    }
  }

  function getClient() {
    if (!client) {
      client = helpers.getSupabaseClient();
    }
    return client;
  }

  function setFormError(message) {
    const node = el('[data-cmp-form-error]');
    if (!node) {
      return;
    }
    node.textContent = message || '';
    node.hidden = !message;
  }

  function normalizePhone(value) {
    return String(value || '').trim().replace(/[\s().-]/g, '');
  }

  function isValidPhone(value) {
    return /^\+\d{8,15}$/.test(value);
  }

  function isRateLimited(error) {
    return Boolean(helpers.isRateLimited?.(error));
  }

  function isCasuta() {
    return state.category === 'casuta';
  }

  // The cabin-number field only exists for "Căsuța" reports; it is required while
  // shown and cleared when the guest switches to another category.
  function syncRoomField() {
    const field = el('[data-cmp-room-field]');
    const input = el('[data-cmp-room]');
    const casuta = isCasuta();
    if (field) {
      field.hidden = !casuta;
    }
    if (input) {
      input.required = casuta;
      if (!casuta) {
        input.value = '';
      }
    }
  }

  function selectCategory(category) {
    state.category = category;
    app.querySelectorAll('[data-cmp-category]').forEach((chip) => {
      const active = chip.dataset.cmpCategory === category;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-checked', String(active));
    });
    syncRoomField();
    setFormError('');
    if (isCasuta()) {
      el('[data-cmp-room]')?.focus();
    }
  }

  async function handleSubmit() {
    if (state.submitting) {
      return;
    }

    const description = String(el('[data-cmp-description]')?.value || '').trim();
    const room = String(el('[data-cmp-room]')?.value || '').trim();
    const phoneRaw = normalizePhone(el('[data-cmp-phone]')?.value);
    const phone = isValidPhone(phoneRaw) ? phoneRaw : '';

    if (!state.category) {
      setFormError(t('complaints.categoryRequired'));
      return;
    }

    if (isCasuta() && !room) {
      setFormError(t('complaints.roomRequired'));
      el('[data-cmp-room]')?.focus();
      return;
    }

    if (!description) {
      setFormError(t('complaints.descriptionRequired'));
      return;
    }

    // The phone is optional, but if the guest typed something that is not a valid
    // number we stop rather than silently drop a callback number they expect us to use.
    if (phoneRaw && phoneRaw !== '+' && !phone) {
      setFormError(t('complaints.phoneInvalid'));
      el('[data-cmp-phone]')?.focus();
      return;
    }

    setFormError('');
    state.submitting = true;
    const button = el('[data-cmp-submit]');
    if (button) {
      button.disabled = true;
    }

    try {
      await helpers.submitComplaint(getClient(), {
        category: state.category,
        description,
        roomNumber: isCasuta() ? room : '',
        phone,
        language: getLanguage(),
      });

      hide(el('[data-cmp-form]'));
      show(el('[data-cmp-success]'));
    } catch (error) {
      setFormError(isRateLimited(error) ? t('complaints.rateLimited') : t('complaints.submitError'));
    } finally {
      state.submitting = false;
      if (button) {
        button.disabled = false;
      }
    }
  }

  function resetForAnother() {
    state.category = '';
    app.querySelectorAll('[data-cmp-category]').forEach((chip) => {
      chip.classList.remove('is-active');
      chip.setAttribute('aria-checked', 'false');
    });
    ['[data-cmp-description]', '[data-cmp-room]', '[data-cmp-phone]'].forEach((selector) => {
      const node = el(selector);
      if (node) {
        node.value = '';
      }
    });
    syncRoomField();
    setFormError('');
    hide(el('[data-cmp-success]'));
    show(el('[data-cmp-form]'));
  }

  function updatePlaceholders() {
    const description = el('[data-cmp-description]');
    if (description) {
      description.placeholder = t('complaints.descriptionPlaceholder');
    }
    const room = el('[data-cmp-room]');
    if (room) {
      room.placeholder = t('complaints.roomPlaceholder');
    }
    const phone = el('[data-cmp-phone]');
    if (phone) {
      phone.placeholder = t('complaints.phonePlaceholder');
    }
  }

  app.querySelectorAll('[data-cmp-category]').forEach((chip) => {
    chip.addEventListener('click', () => selectCategory(chip.dataset.cmpCategory));
  });
  el('[data-cmp-submit]')?.addEventListener('click', handleSubmit);
  el('[data-cmp-again]')?.addEventListener('click', resetForAnother);

  window.addEventListener('ecovila:languagechange', updatePlaceholders);
  updatePlaceholders();
  syncRoomField();
})();
