(function () {
  const storageKeys = {
    language: 'ecovila_language',
    cookie: 'ecovila_cookie_consent_v2',
    legacyCookie: 'ecovila_cookie_consent',
  };

  const accommodationImages = {
    small: '/assets/photos/small-villa/exterior.svg',
    large: '/assets/photos/large-villa/exterior.svg',
    hotel: '/assets/photos/hotel/room.svg',
  };

  const typeGalleries = {
    small: [
      '/assets/photos/small-villa/exterior.svg',
      '/assets/photos/small-villa/interior.svg',
      '/assets/photos/territory/terrace.svg',
      '/assets/photos/spa/pool.svg',
    ],
    large: [
      '/assets/photos/large-villa/exterior.svg',
      '/assets/photos/large-villa/living.svg',
      '/assets/photos/territory/garden.svg',
      '/assets/photos/restaurant/dining.svg',
    ],
    hotel: [
      '/assets/photos/hotel/room.svg',
      '/assets/photos/hotel/building.svg',
      '/assets/photos/spa/salt-room.svg',
      '/assets/photos/restaurant/tea.svg',
    ],
  };

  const accommodationPhotoSections = {
    small: 'small-villa',
    large: 'large-villa',
    hotel: 'hotel',
  };

  const state = {
    language: document.documentElement.lang || 'ro',
    lastFocusedElement: null,
    activeModalType: null,
    modalGallery: null,
  };

  function normalizeLanguage(language) {
    const translations = getTranslations();
    const normalized = String(language || '').toLowerCase();

    return translations[normalized] ? normalized : 'ro';
  }

  function getTranslations() {
    return window.EcoVilaTranslations || {};
  }

  function t(key) {
    const translations = getTranslations();
    return translations[state.language]?.[key] || translations.ro?.[key] || key;
  }

  function applyLanguage(language) {
    const translations = getTranslations();
    state.language = normalizeLanguage(language);
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

    window.dispatchEvent(
      new CustomEvent('ecovila:languagechange', {
        detail: { language: state.language },
      }),
    );
  }

  function initializeLanguageSwitcher() {
    const hasSelectSwitcher = document.querySelector('[data-lang-select]');
    const staticSelectSwitcher = document.querySelector('[data-static-lang-select]');
    const currentLanguage = normalizeLanguage(document.documentElement.lang || state.language);
    state.language = currentLanguage;

    if (staticSelectSwitcher) {
      staticSelectSwitcher.value = currentLanguage === 'ru' ? '/ru/' : currentLanguage === 'en' ? '/en/' : '/';
      staticSelectSwitcher.addEventListener('change', () => {
        const target = staticSelectSwitcher.value || '/';
        const nextLanguage = target === '/ru/' ? 'ru' : target === '/en/' ? 'en' : 'ro';
        localStorage.setItem(storageKeys.language, nextLanguage);
        window.location.href = target;
      });
      window.dispatchEvent(
        new CustomEvent('ecovila:languagechange', {
          detail: { language: currentLanguage },
        }),
      );
    } else if (hasSelectSwitcher) {
      const storedLanguage = localStorage.getItem(storageKeys.language);
      applyLanguage(storedLanguage || currentLanguage);
    } else {
      document.querySelectorAll('[data-lang-link]').forEach((link) => {
        const isActive = link.dataset.langLink === currentLanguage;
        link.classList.toggle('is-active', isActive);
        if (isActive) {
          link.setAttribute('aria-current', 'true');
        } else {
          link.removeAttribute('aria-current');
        }
      });
      window.dispatchEvent(
        new CustomEvent('ecovila:languagechange', {
          detail: { language: currentLanguage },
        }),
      );
    }

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

  function renderList(ul, items) {
    ul.innerHTML = '';
    (Array.isArray(items) ? items : []).forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    });
  }

  function photoUrl(photo, variant) {
    if (!photo) {
      return '';
    }

    if (typeof photo === 'string') {
      return photo;
    }

    const key = `${variant || 'preview'}Url`;
    return photo[key] || photo.url || photo.previewUrl || photo.originalUrl || '';
  }

  function prepareLazyImage(image) {
    image.loading = 'lazy';
    image.decoding = 'async';
  }

  function galleryLabels() {
    return {
      prev: t('gallery.prev'),
      next: t('gallery.next'),
      close: t('gallery.close'),
      expand: t('gallery.expand'),
      image: t('booking.image'),
    };
  }

  function fillModal(type, options) {
    const modal = document.querySelector('[data-booking-modal]');
    if (!modal) {
      return;
    }

    const gallery = typeGalleries[type] || [accommodationImages[type]];
    const galleryElement = modal.querySelector('[data-booking-modal-gallery]');
    if (galleryElement && window.EcoVilaGallery) {
      state.modalGallery = window.EcoVilaGallery.attach(galleryElement);
      state.modalGallery.update({
        photos: gallery,
        alt: t(`accommodation.${type}.title`),
        labels: galleryLabels(),
        startIndex: options?.resetIndex ? 0 : undefined,
      });
    }

    modal.querySelector('[data-booking-modal-title]').textContent = t(`accommodation.${type}.title`);
    modal.querySelector('[data-booking-modal-body]').textContent = t(`accommodation.${type}.details`);

    renderList(modal.querySelector('[data-booking-modal-bathroom]'), t('accommodation.shared.bathroom'));
    renderList(modal.querySelector('[data-booking-modal-facilities]'), t('accommodation.shared.facilities'));
  }

  function openModal(type, trigger) {
    const modal = document.querySelector('[data-booking-modal]');
    if (!modal) {
      return;
    }

    state.lastFocusedElement = trigger || document.activeElement;
    state.activeModalType = type;
    fillModal(type, { resetIndex: true });
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    modal.querySelector('[data-modal-close]')?.focus();
  }

  function closeModal() {
    const modal = document.querySelector('[data-booking-modal]');
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
    // On the booking page (rezervari.html) booking.js fully owns the details modal,
    // including the [data-booking-modal-reserve] button (Select → Continue → checkout).
    // main.js's landing-page version of this modal must not bind here, otherwise its
    // reserve handler (window.location.href = 'rezervari.html') fires alongside
    // booking.js's and reloads the page, wiping the selection.
    if (document.body.classList.contains('page-booking')) {
      return;
    }

    document.querySelectorAll('[data-accommodation]').forEach((button) => {
      button.addEventListener('click', () => {
        openModal(button.dataset.accommodation, button);
      });
    });

    document.querySelectorAll('[data-modal-close]').forEach((el) => {
      el.addEventListener('click', closeModal);
    });

    const reserveBtn = document.querySelector('[data-booking-modal-reserve]');
    if (reserveBtn) {
      reserveBtn.addEventListener('click', () => {
        window.location.href = 'rezervari.html';
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeModal();
      }
    });
  }

  function defaultConsent() {
    return {
      necessary: true,
      analytics: false,
      marketing: false,
      updatedAt: '',
    };
  }

  function normalizeConsent(value) {
    return {
      necessary: true,
      analytics: Boolean(value?.analytics),
      marketing: Boolean(value?.marketing),
      updatedAt: value?.updatedAt || new Date().toISOString(),
    };
  }

  function readConsent() {
    try {
      const raw = localStorage.getItem(storageKeys.cookie);
      if (raw) {
        return normalizeConsent(JSON.parse(raw));
      }
    } catch (_error) {
      localStorage.removeItem(storageKeys.cookie);
    }

    const legacy = localStorage.getItem(storageKeys.legacyCookie);
    if (legacy === 'accepted') {
      return normalizeConsent({ analytics: true, marketing: true });
    }
    if (legacy === 'essential') {
      return normalizeConsent({ analytics: false, marketing: false });
    }

    return null;
  }

  function saveConsent(consent) {
    const normalized = normalizeConsent({
      ...consent,
      updatedAt: new Date().toISOString(),
    });

    localStorage.setItem(storageKeys.cookie, JSON.stringify(normalized));
    localStorage.removeItem(storageKeys.legacyCookie);
    window.dispatchEvent(
      new CustomEvent('ecovila:consentchange', {
        detail: { consent: normalized },
      }),
    );

    return normalized;
  }

  function currentConsent() {
    return readConsent() || defaultConsent();
  }

  function consentFromChoice(choice, banner) {
    if (choice === 'accepted' || choice === 'all') {
      return { necessary: true, analytics: true, marketing: true };
    }

    if (choice === 'custom') {
      return {
        necessary: true,
        analytics: Boolean(banner.querySelector('[data-cookie-category="analytics"]')?.checked),
        marketing: Boolean(banner.querySelector('[data-cookie-category="marketing"]')?.checked),
      };
    }

    return { necessary: true, analytics: false, marketing: false };
  }

  function applyConsentToBanner(banner, consent) {
    banner.querySelectorAll('[data-cookie-category]').forEach((input) => {
      input.checked = Boolean(consent[input.dataset.cookieCategory]);
    });
  }

  function initializeCookieBanner() {
    const banner = document.getElementById('cookie-banner');
    const storedConsent = readConsent();

    window.EcoVilaConsent = {
      get: currentConsent,
      has: (category) => Boolean(currentConsent()[category]),
      set: saveConsent,
    };

    window.dispatchEvent(
      new CustomEvent('ecovila:consentchange', {
        detail: { consent: currentConsent() },
      }),
    );

    if (!banner || storedConsent) {
      return;
    }

    applyConsentToBanner(banner, defaultConsent());
    banner.hidden = false;
    banner.querySelectorAll('[data-cookie-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        saveConsent(consentFromChoice(button.dataset.cookieChoice, banner));
        banner.hidden = true;
      });
    });

    const settingsToggle = banner.querySelector('[data-cookie-settings]');
    const settingsPanel = banner.querySelector('.cookie-banner__settings');
    if (settingsToggle && settingsPanel) {
      settingsToggle.addEventListener('click', () => {
        const expanded = settingsPanel.hidden;
        settingsPanel.hidden = !expanded;
        settingsToggle.setAttribute('aria-expanded', String(expanded));
        banner.classList.toggle('is-expanded', expanded);
      });
    }
  }

  function cssImageUrl(url) {
    return `url("${String(url).replaceAll('"', '%22')}")`;
  }

  function photoAt(library, section, index) {
    const photos = library?.[section] || [];
    return photos[index] || photos[0] || null;
  }

  function applyImageElement(element, photo) {
    const url = photoUrl(photo, element.dataset.photoVariant || 'preview');

    if (!url) {
      return;
    }

    prepareLazyImage(element);
    element.src = url;
    element.alt = photo.alt || element.alt || '';
  }

  function applyPublishedPhotos(library) {
    document.querySelectorAll('img[data-photo-section]').forEach((image) => {
      const section = image.dataset.photoSection;
      const index = Number(image.dataset.photoIndex || 0);
      applyImageElement(image, photoAt(library, section, index));
    });

    document.querySelectorAll('[data-photo-background]').forEach((element) => {
      const section = element.dataset.photoBackground;
      const photo = photoAt(library, section, 0);

      const url = photoUrl(photo, element.dataset.photoVariant || 'wide');

      if (!url) {
        return;
      }

      element.style.backgroundImage = [
        'linear-gradient(180deg, rgba(18, 15, 13, 0.28), rgba(18, 15, 13, 0.62))',
        cssImageUrl(url),
      ].join(', ');
    });

    Object.entries(accommodationPhotoSections).forEach(([type, section]) => {
      const photos = library?.[section] || [];
      const displayPhotos = photos.filter((photo) => photoUrl(photo, 'preview'));

      if (displayPhotos.length > 0) {
        typeGalleries[type] = displayPhotos;
        accommodationImages[type] = displayPhotos[0];
        const cardImg = document.querySelector(`img[data-accommodation-type="${type}"]`);
        if (cardImg) {
          prepareLazyImage(cardImg);
          cardImg.src = photoUrl(displayPhotos[0], cardImg.dataset.photoVariant || 'card');
        }
      }
    });
  }

  async function initializePublishedPhotos() {
    const supabaseHelpers = window.EcoVilaSupabase;

    if (!supabaseHelpers?.fetchPublicPhotoLibrary) {
      return;
    }

    try {
      const client = supabaseHelpers.getSupabaseClient();
      const library = await supabaseHelpers.fetchPublicPhotoLibrary(client);
      applyPublishedPhotos(library);
      // Share the published library so facilities.js can render real photos.
      window.EcoVilaPhotoLibrary = library;
      window.dispatchEvent(new CustomEvent('ecovila:photolibrary', { detail: { library } }));
    } catch (_error) {
      // Keep local SVG placeholders when Supabase photos are not available.
    }
  }

  window.EcoVilaLanguage = {
    getLanguage: () => state.language,
    setLanguage: applyLanguage,
    t,
  };

  document.addEventListener('DOMContentLoaded', () => {
    initializeLanguageSwitcher();
    initializeHeader();
    initializeAccommodationModal();
    initializeCookieBanner();
    initializePublishedPhotos();
  });
})();
