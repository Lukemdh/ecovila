(function () {
  'use strict';

  const doc = document;
  const app = doc.querySelector('[data-complaints-app]');
  if (!app) {
    return;
  }

  const helpers = window.EcoVilaSupabase;
  const state = {
    loginId: '',
    complaintToken: '',
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

  function setError(selector, message) {
    const node = el(selector);
    if (!node) {
      return;
    }
    node.textContent = message || '';
    node.hidden = !message;
  }

  function setLoginError(message) {
    setError('[data-cmp-login-error]', message);
  }

  function setFormError(message) {
    setError('[data-cmp-form-error]', message);
  }

  function normalizePhone(value) {
    return String(value || '').trim().replace(/[\s().-]/g, '');
  }

  function isRateLimited(error) {
    return Boolean(helpers.isRateLimited?.(error));
  }

  async function handleStart() {
    const button = el('[data-cmp-start]');
    const phone = normalizePhone(el('[data-cmp-phone]')?.value);

    if (!/^\+\d{8,15}$/.test(phone)) {
      setLoginError(t('complaints.loginError'));
      return;
    }

    setLoginError('');
    if (button) {
      button.disabled = true;
    }

    try {
      const result = await helpers.startComplaintLogin(getClient(), phone, getLanguage());

      if (result.rateLimited) {
        setLoginError(t('complaints.rateLimited'));
        return;
      }

      if (result.hasReservations === false) {
        setLoginError(t('complaints.noReservations'));
        return;
      }

      state.loginId = result.loginId || '';
      hide(el('[data-cmp-phone-step]'));
      show(el('[data-cmp-code-step]'));
      el('[data-cmp-code]')?.focus();
    } catch (error) {
      setLoginError(isRateLimited(error) ? t('complaints.rateLimited') : t('complaints.loginError'));
    } finally {
      if (button) {
        button.disabled = false;
      }
    }
  }

  async function handleVerify() {
    const button = el('[data-cmp-verify]');
    const code = String(el('[data-cmp-code]')?.value || '').replace(/\D/g, '').slice(0, 4);

    if (!state.loginId || code.length !== 4) {
      setLoginError(t('complaints.codeError'));
      return;
    }

    setLoginError('');
    if (button) {
      button.disabled = true;
    }

    try {
      const result = await helpers.verifyComplaintLogin(getClient(), {
        loginId: state.loginId,
        code,
      });

      state.complaintToken = result.complaintToken || '';
      if (!state.complaintToken) {
        setLoginError(t('complaints.codeError'));
        return;
      }

      hide(el('[data-cmp-login]'));
      show(el('[data-cmp-form]'));
    } catch (error) {
      setLoginError(isRateLimited(error) ? t('complaints.rateLimited') : t('complaints.codeError'));
    } finally {
      if (button) {
        button.disabled = false;
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
    setFormError('');
  }

  async function handleSubmit() {
    if (state.submitting) {
      return;
    }

    const description = String(el('[data-cmp-description]')?.value || '').trim();

    if (!state.category) {
      setFormError(t('complaints.categoryRequired'));
      return;
    }

    if (!description) {
      setFormError(t('complaints.descriptionRequired'));
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
        complaintToken: state.complaintToken,
        category: state.category,
        description,
        isAnonymous: el('[data-cmp-anonymous]')?.checked === true,
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
    const description = el('[data-cmp-description]');
    if (description) {
      description.value = '';
    }
    const anonymous = el('[data-cmp-anonymous]');
    if (anonymous) {
      anonymous.checked = false;
    }
    setFormError('');
    hide(el('[data-cmp-success]'));
    show(el('[data-cmp-form]'));
  }

  function updatePlaceholder() {
    const description = el('[data-cmp-description]');
    if (description) {
      description.placeholder = t('complaints.descriptionPlaceholder');
    }
  }

  function onEnter(node, handler) {
    node?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handler();
      }
    });
  }

  el('[data-cmp-start]')?.addEventListener('click', handleStart);
  onEnter(el('[data-cmp-phone]'), handleStart);
  el('[data-cmp-verify]')?.addEventListener('click', handleVerify);
  onEnter(el('[data-cmp-code]'), handleVerify);
  app.querySelectorAll('[data-cmp-category]').forEach((chip) => {
    chip.addEventListener('click', () => selectCategory(chip.dataset.cmpCategory));
  });
  el('[data-cmp-submit]')?.addEventListener('click', handleSubmit);
  el('[data-cmp-again]')?.addEventListener('click', resetForAnother);

  window.addEventListener('ecovila:languagechange', updatePlaceholder);
  updatePlaceholder();
})();
