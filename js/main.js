(function () {
  const storageKeys = {
    language: 'ecovila_language',
    cookie: 'ecovila_cookie_consent',
  };

  const accommodationImages = {
    small: '/assets/photos/small-villa/interior.svg',
    large: '/assets/photos/large-villa/living.svg',
    hotel: '/assets/photos/hotel/building.svg',
  };

  const state = {
    language: 'ro',
    lastFocusedElement: null,
  };

  function getTranslations() {
    return window.EcoVilaTranslations || {};
  }

  function t(key) {
    const translations = getTranslations();
    return translations[state.language]?.[key] || translations.ro?.[key] || key;
  }

  function applyLanguage(language) {
    const translations = getTranslations();
    state.language = translations[language] ? language : 'ro';
    document.documentElement.lang = state.language;
    localStorage.setItem(storageKeys.language, state.language);

    document.querySelectorAll('[data-i18n]').forEach((element) => {
      const value = t(element.dataset.i18n);
      if (Array.isArray(value)) {
        return;
      }
      element.textContent = value;
    });

    document.querySelectorAll('[data-lang]').forEach((button) => {
      const isActive = button.dataset.lang === state.language;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });

    document.querySelectorAll('[data-lang-select]').forEach((select) => {
      select.value = state.language;
    });
  }

  function initializeLanguageSwitcher() {
    const storedLanguage = localStorage.getItem(storageKeys.language);
    applyLanguage(storedLanguage || 'ro');

    document.querySelectorAll('[data-lang]').forEach((button) => {
      button.addEventListener('click', () => {
        applyLanguage(button.dataset.lang);
      });
    });

    document.querySelectorAll('[data-lang-select]').forEach((select) => {
      select.addEventListener('change', () => {
        applyLanguage(select.value);
      });
    });
  }

  function initializeHeader() {
    const header = document.querySelector('[data-header]');
    if (!header) {
      return;
    }

    const updateHeader = () => {
      header.classList.toggle('is-scrolled', window.scrollY > 28);
    };

    updateHeader();
    window.addEventListener('scroll', updateHeader, { passive: true });
    window.addEventListener('hashchange', () => {
      requestAnimationFrame(updateHeader);
    });
    window.setTimeout(updateHeader, 120);
  }

  function fillModal(type) {
    const modal = document.getElementById('accommodation-modal');
    if (!modal) {
      return;
    }

    const title = modal.querySelector('[data-modal-title]');
    const body = modal.querySelector('[data-modal-body]');
    const list = modal.querySelector('[data-modal-list]');
    const image = modal.querySelector('[data-modal-image]');
    const amenities = t(`accommodation.${type}.amenities`);

    title.textContent = t(`accommodation.${type}.title`);
    body.textContent = t(`accommodation.${type}.details`);
    image.src = accommodationImages[type] || accommodationImages.small;
    image.alt = '';
    list.innerHTML = '';

    if (Array.isArray(amenities)) {
      amenities.forEach((item) => {
        const listItem = document.createElement('li');
        listItem.textContent = item;
        list.appendChild(listItem);
      });
    }
  }

  function openModal(type, trigger) {
    const modal = document.getElementById('accommodation-modal');
    if (!modal) {
      return;
    }

    state.lastFocusedElement = trigger || document.activeElement;
    fillModal(type);
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    modal.querySelector('[data-modal-close]')?.focus();
  }

  function closeModal() {
    const modal = document.getElementById('accommodation-modal');
    if (!modal || modal.hidden) {
      return;
    }

    modal.hidden = true;
    document.body.style.overflow = '';

    if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === 'function') {
      state.lastFocusedElement.focus();
    }
  }

  function initializeAccommodationModal() {
    document.querySelectorAll('[data-accommodation]').forEach((button) => {
      button.addEventListener('click', () => {
        openModal(button.dataset.accommodation, button);
      });
    });

    document.querySelectorAll('[data-modal-close]').forEach((button) => {
      button.addEventListener('click', closeModal);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeModal();
      }
    });
  }

  function initializeCookieBanner() {
    const banner = document.getElementById('cookie-banner');
    if (!banner || localStorage.getItem(storageKeys.cookie)) {
      return;
    }

    banner.hidden = false;
    banner.querySelectorAll('[data-cookie-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        localStorage.setItem(storageKeys.cookie, button.dataset.cookieChoice);
        banner.hidden = true;
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initializeLanguageSwitcher();
    initializeHeader();
    initializeAccommodationModal();
    initializeCookieBanner();
  });
})();
