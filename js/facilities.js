(function () {
  'use strict';

  const list = document.querySelector('[data-facilities-list]');
  const modal = document.querySelector('[data-facility-modal]');

  // The modal is required; the cards list is optional, so the same detail view
  // can be opened from CTAs on pages that don't render the full facilities list.
  if (!modal) {
    return;
  }

  const STORAGE_LANGUAGE = 'ecovila_language';

  // Card order is intentional: SPA first, then meals, location, and kids.
  // `slug` maps to the published photo section in the DB; `fallback` is shown
  // until the live photo library loads (or if a section has no photos yet).
  const FACILITIES = [
    {
      id: 'spa',
      slug: 'spa',
      heatBadge: true,
      fallback: [
        '/assets/photos/spa/pool.svg',
        '/assets/photos/spa/sauna.svg',
        '/assets/photos/spa/salt-room.svg',
      ],
    },
    {
      id: 'dining',
      slug: 'restaurant-food',
      fallback: [
        '/assets/photos/restaurant/dining.svg',
        '/assets/photos/restaurant/dessert.svg',
        '/assets/photos/restaurant/tea.svg',
      ],
    },
    {
      id: 'location',
      slug: 'territory',
      fallback: [
        '/assets/photos/territory/garden.svg',
        '/assets/photos/territory/terrace.svg',
        '/assets/photos/territory/forest-path.svg',
      ],
    },
    {
      id: 'kids',
      slug: 'playground',
      fallback: [
        '/assets/photos/playground/slide.svg',
        '/assets/photos/playground/swings.svg',
        '/assets/photos/playground/sandbox.svg',
      ],
    },
  ];

  const CHECK_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const ARROW_ICON =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
  const THERMO_ICON =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>';

  const state = {
    library: window.EcoVilaPhotoLibrary || null,
    activeFacility: '',
  };

  function getTranslations() {
    return window.EcoVilaTranslations || {};
  }

  function currentLanguage() {
    const translations = getTranslations();
    const lang = document.documentElement.lang || localStorage.getItem(STORAGE_LANGUAGE) || 'ro';
    return translations[lang] ? lang : 'ro';
  }

  function t(key) {
    const translations = getTranslations();
    const lang = currentLanguage();
    const value = translations[lang]?.[key] ?? translations.ro?.[key] ?? key;
    return value;
  }

  function tList(key) {
    const value = t(key);
    return Array.isArray(value) ? value : [];
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

  function getFacilityPhotos(facility) {
    const fromDb =
      state.library && Array.isArray(state.library[facility.slug]) ? state.library[facility.slug] : [];
    return fromDb.length ? fromDb : facility.fallback;
  }

  function buildCard(facility, index) {
    const photos = getFacilityPhotos(facility);
    const card = document.createElement('article');
    card.className = 'facility-card';
    if (index % 2 === 1) {
      card.classList.add('facility-card--reverse');
    }
    card.dataset.facility = facility.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', t(`facilities.${facility.id}.title`));

    const media = document.createElement('div');
    media.className = 'facility-card__media';
    const displayPhotos = photos.slice(0, 2);
    if (displayPhotos.length < 2) {
      media.classList.add('facility-card__media--single');
    }
    displayPhotos.forEach((photo, photoIndex) => {
      const image = document.createElement('img');
      image.className = 'facility-card__photo';
      if (photoIndex === 1) {
        image.classList.add('facility-card__photo--second');
      }
      prepareLazyImage(image);
      image.src = photoUrl(photo, 'card');
      image.alt = '';
      media.appendChild(image);
    });

    if (facility.heatBadge) {
      const chip = document.createElement('div');
      chip.className = 'facility-card__heat';
      chip.innerHTML = THERMO_ICON;
      const chipText = document.createElement('span');
      chipText.innerHTML = `${t(`facilities.${facility.id}.heatLabel`)} <strong>${t(`facilities.${facility.id}.heatValue`)}</strong>`;
      chip.appendChild(chipText);
      media.appendChild(chip);
    }

    const body = document.createElement('div');
    body.className = 'facility-card__body';

    const kicker = document.createElement('span');
    kicker.className = 'facility-card__kicker';
    kicker.innerHTML = CHECK_ICON;
    const kickerText = document.createElement('span');
    kickerText.textContent = t('facilities.included');
    kicker.appendChild(kickerText);

    const title = document.createElement('h3');
    title.className = 'facility-card__title';
    title.textContent = t(`facilities.${facility.id}.title`);

    const summary = document.createElement('p');
    summary.className = 'facility-card__summary';
    summary.textContent = t(`facilities.${facility.id}.summary`);

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'facility-card__cta';
    cta.dataset.facilityMore = facility.id;
    const ctaLabel = document.createElement('span');
    ctaLabel.textContent = t('facilities.seeMore');
    cta.appendChild(ctaLabel);
    cta.insertAdjacentHTML('beforeend', ARROW_ICON);
    cta.addEventListener('click', (event) => {
      event.stopPropagation();
      openFacility(facility.id);
    });

    body.append(kicker, title, summary, cta);
    card.append(media, body);

    card.addEventListener('click', (event) => {
      if (event.target.closest('button, a')) {
        return;
      }
      openFacility(facility.id);
    });
    card.addEventListener('keydown', (event) => {
      if (event.target.closest('button, a') || !['Enter', ' '].includes(event.key)) {
        return;
      }
      event.preventDefault();
      openFacility(facility.id);
    });

    return card;
  }

  function renderCards() {
    if (!list) {
      return;
    }
    list.innerHTML = '';
    FACILITIES.forEach((facility, index) => {
      list.appendChild(buildCard(facility, index));
    });
  }

  function openFacility(id) {
    if (!FACILITIES.some((item) => item.id === id)) {
      return;
    }
    state.activeFacility = id;
    renderModal({ resetIndex: true });
    showModal();
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

  function renderModal(options) {
    const facility = FACILITIES.find((item) => item.id === state.activeFacility);
    if (!facility) {
      return;
    }

    const photos = getFacilityPhotos(facility);
    const galleryElement = modal.querySelector('[data-facility-gallery]');
    if (galleryElement && window.EcoVilaGallery) {
      window.EcoVilaGallery.attach(galleryElement).update({
        photos,
        alt: t(`facilities.${facility.id}.title`),
        labels: galleryLabels(),
        startIndex: options?.resetIndex ? 0 : undefined,
      });
    }

    modal.querySelector('[data-facility-title]').textContent = t(`facilities.${facility.id}.title`);
    modal.querySelector('[data-facility-body]').textContent = t(`facilities.${facility.id}.details`);
    modal.querySelector('[data-facility-highlights-label]').textContent = t('facilities.highlightsLabel');

    const heat = modal.querySelector('[data-facility-heat]');
    if (facility.heatBadge) {
      heat.hidden = false;
      heat.innerHTML =
        `<span class="facility-heat-banner__icon">${THERMO_ICON}</span>` +
        '<div class="facility-heat-banner__text">' +
        `<strong>${t(`facilities.${facility.id}.heatLabel`)}</strong>` +
        `<span class="facility-heat-banner__value">${t(`facilities.${facility.id}.heatValue`)}*</span>` +
        '</div>';
    } else {
      heat.hidden = true;
      heat.innerHTML = '';
    }

    const highlights = modal.querySelector('[data-facility-highlights]');
    highlights.innerHTML = '';
    tList(`facilities.${facility.id}.highlights`).forEach((item) => {
      const listItem = document.createElement('li');
      listItem.textContent = item;
      highlights.appendChild(listItem);
    });
  }

  function showModal() {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    modal.hidden = true;
    state.activeFacility = '';
    document.body.style.overflow = '';
  }

  function bindOpenTriggers() {
    document.querySelectorAll('[data-facility-open]').forEach((trigger) => {
      trigger.addEventListener('click', () => openFacility(trigger.dataset.facilityOpen));
    });
  }

  function bindModalEvents() {
    modal.querySelectorAll('[data-facility-close]').forEach((button) => {
      button.addEventListener('click', closeModal);
    });

    document.addEventListener('keydown', (event) => {
      if (modal.hidden) {
        return;
      }
      if (event.key === 'Escape') {
        closeModal();
      }
    });
  }

  window.addEventListener('ecovila:photolibrary', (event) => {
    state.library = event.detail?.library || state.library;
    renderCards();
    if (!modal.hidden && state.activeFacility) {
      renderModal();
    }
  });

  window.addEventListener('ecovila:languagechange', () => {
    renderCards();
    if (!modal.hidden && state.activeFacility) {
      renderModal();
    }
  });

  window.EcoVilaFacilities = { open: openFacility };

  bindModalEvents();
  bindOpenTriggers();
  renderCards();
})();
