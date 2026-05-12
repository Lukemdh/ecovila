(function () {
  const storageKeys = {
    language: 'ecovila_language',
    cookie: 'ecovila_cookie_consent',
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
    language: 'ro',
    lastFocusedElement: null,
    activeModalType: null,
    modalImageIndex: 0,
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

    window.dispatchEvent(
      new CustomEvent('ecovila:languagechange', {
        detail: { language: state.language },
      }),
    );
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

  function renderList(ul, items) {
    ul.innerHTML = '';
    (Array.isArray(items) ? items : []).forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    });
  }

  function fillModal(type) {
    const modal = document.querySelector('[data-booking-modal]');
    if (!modal) {
      return;
    }

    const gallery = typeGalleries[type] || [accommodationImages[type]];
    const activeIndex = Math.min(state.modalImageIndex, gallery.length - 1);

    modal.querySelector('[data-booking-modal-gallery]').dataset.imageCount = String(gallery.length);
    modal.querySelector('[data-booking-modal-image]').src = gallery[activeIndex];
    modal.querySelector('[data-booking-modal-title]').textContent = t(`accommodation.${type}.title`);
    modal.querySelector('[data-booking-modal-body]').textContent = t(`accommodation.${type}.details`);

    renderList(modal.querySelector('[data-booking-modal-bathroom]'), t('accommodation.shared.bathroom'));
    renderList(modal.querySelector('[data-booking-modal-facilities]'), t('accommodation.shared.facilities'));

    const thumbnails = modal.querySelector('[data-booking-modal-thumbnails]');
    thumbnails.innerHTML = '';
    gallery.forEach((src, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-label', `Imaginea ${index + 1}`);
      btn.classList.toggle('is-active', index === activeIndex);
      const thumb = document.createElement('img');
      thumb.src = src;
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

  function cssImageUrl(url) {
    return `url("${String(url).replaceAll('"', '%22')}")`;
  }

  function photoAt(library, section, index) {
    const photos = library?.[section] || [];
    return photos[index] || photos[0] || null;
  }

  function applyImageElement(element, photo) {
    if (!photo?.url) {
      return;
    }

    element.src = photo.url;
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

      if (!photo?.url) {
        return;
      }

      element.style.backgroundImage = [
        'linear-gradient(180deg, rgba(18, 15, 13, 0.28), rgba(18, 15, 13, 0.62))',
        cssImageUrl(photo.url),
      ].join(', ');
    });

    Object.entries(accommodationPhotoSections).forEach(([type, section]) => {
      const photos = library?.[section] || [];
      const urls = photos.map((p) => p?.url).filter(Boolean);

      if (urls.length > 0) {
        typeGalleries[type] = urls;
        accommodationImages[type] = urls[0];
        const cardImg = document.querySelector(`img[data-accommodation-type="${type}"]`);
        if (cardImg) cardImg.src = urls[0];
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
