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
    modalImageIndex: 0,
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

  function fillModal(type) {
    const modal = document.querySelector('[data-booking-modal]');
    if (!modal) {
      return;
    }

    const gallery = typeGalleries[type] || [accommodationImages[type]];
    const activeIndex = Math.min(state.modalImageIndex, gallery.length - 1);
    const activePhoto = gallery[activeIndex];

    modal.querySelector('[data-booking-modal-gallery]').dataset.imageCount = String(gallery.length);
    const modalImage = modal.querySelector('[data-booking-modal-image]');
    prepareLazyImage(modalImage);
    modalImage.src = photoUrl(activePhoto, 'full');
    modal.querySelector('[data-booking-modal-title]').textContent = t(`accommodation.${type}.title`);
    modal.querySelector('[data-booking-modal-body]').textContent = t(`accommodation.${type}.details`);

    renderList(modal.querySelector('[data-booking-modal-bathroom]'), t('accommodation.shared.bathroom'));
    renderList(modal.querySelector('[data-booking-modal-facilities]'), t('accommodation.shared.facilities'));

    const thumbnails = modal.querySelector('[data-booking-modal-thumbnails]');
    thumbnails.innerHTML = '';
    gallery.forEach((photo, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-label', `Imaginea ${index + 1}`);
      btn.classList.toggle('is-active', index === activeIndex);
      const thumb = document.createElement('img');
      prepareLazyImage(thumb);
      thumb.src = photoUrl(photo, 'thumbnail');
      thumb.alt = '';
      btn.appendChild(thumb);
      btn.addEventListener('click', () => {
        state.modalImageIndex = index;
        fillModal(state.activeModalType);
      });
      thumbnails.appendChild(btn);
    });

    const dots = modal.querySelector('[data-booking-modal-dots]');
    dots.innerHTML = '';
    gallery.forEach((_, index) => {
      const dot = document.createElement('span');
      dot.classList.toggle('is-active', index === activeIndex);
      dots.appendChild(dot);
    });
  }

  function openModal(type, trigger) {
    const modal = document.querySelector('[data-booking-modal]');
    if (!modal) {
      return;
    }

    state.lastFocusedElement = trigger || document.activeElement;
    state.activeModalType = type;
    state.modalImageIndex = 0;
    fillModal(type);
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

  function moveImage(direction) {
    if (!state.activeModalType) {
      return;
    }
    const gallery = typeGalleries[state.activeModalType] || [accommodationImages[state.activeModalType]];
    state.modalImageIndex = (state.modalImageIndex + direction + gallery.length) % gallery.length;
    fillModal(state.activeModalType);
  }

  function initializeAccommodationModal() {
    document.querySelectorAll('[data-accommodation]').forEach((button) => {
      button.addEventListener('click', () => {
        openModal(button.dataset.accommodation, button);
      });
    });

    document.querySelectorAll('[data-modal-close]').forEach((el) => {
      el.addEventListener('click', closeModal);
    });

    const prevBtn = document.querySelector('[data-booking-modal-prev]');
    const nextBtn = document.querySelector('[data-booking-modal-next]');
    if (prevBtn) prevBtn.addEventListener('click', () => moveImage(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => moveImage(1));

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
    element.alt = photo.alt || '';
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
