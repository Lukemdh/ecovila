(function () {
  'use strict';

  // Shared photo carousel used by every detail pop-up (accommodation, facility).
  // One swipeable scroll-snap track + thumbnails, and a photo-only fullscreen
  // lightbox opened by tapping the active photo. Portrait photos are shown in
  // full (object-fit: contain) over a blurred cover backdrop, so nothing gets
  // cropped regardless of orientation.

  const DEFAULT_LABELS = {
    prev: 'Imaginea precedentă',
    next: 'Imaginea următoare',
    close: 'Închide',
    expand: 'Vezi fotografia mărită',
    image: 'Imaginea',
  };

  const CHEVRON_LEFT =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';
  const CHEVRON_RIGHT =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
  const EXPAND_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  const CLOSE_ICON =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

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

  function photoAlt(photo, fallback, index) {
    const base = (photo && typeof photo === 'object' && photo.alt) || fallback || '';
    return index > 0 && base ? `${base} — ${index + 1}` : base;
  }

  function createElement(tag, className, attributes) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    Object.entries(attributes || {}).forEach(([name, value]) => {
      element.setAttribute(name, value);
    });
    return element;
  }

  function clampIndex(index, count) {
    return Math.max(0, Math.min(count - 1, index));
  }

  // Keeps a scroll-snap track and its logical index in sync, and adds
  // mouse drag-to-swipe (touch swiping is native scroll behavior).
  function setupTrack(viewport, callbacks) {
    const track = {
      suppressClick: false,
      goTo(index, behavior) {
        viewport.scrollTo({
          left: index * (viewport.clientWidth || 1),
          behavior: behavior || 'smooth',
        });
      },
      indexFromScroll() {
        return Math.round(viewport.scrollLeft / (viewport.clientWidth || 1));
      },
    };

    let scrollTimer = 0;
    viewport.addEventListener(
      'scroll',
      () => {
        window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => {
          callbacks.onIndexChange(track.indexFromScroll());
        }, 60);
      },
      { passive: true },
    );

    let dragging = false;
    let dragMoved = false;
    let dragStartX = 0;
    let dragStartScroll = 0;

    viewport.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) {
        return;
      }
      dragging = true;
      dragMoved = false;
      dragStartX = event.clientX;
      dragStartScroll = viewport.scrollLeft;
      viewport.style.scrollSnapType = 'none';
      viewport.style.scrollBehavior = 'auto';
    });

    viewport.addEventListener('pointermove', (event) => {
      if (!dragging) {
        return;
      }
      const delta = event.clientX - dragStartX;
      if (Math.abs(delta) > 8) {
        dragMoved = true;
        viewport.setPointerCapture(event.pointerId);
      }
      viewport.scrollLeft = dragStartScroll - delta;
    });

    const endDrag = (event) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      viewport.style.scrollSnapType = '';
      viewport.style.scrollBehavior = '';
      if (dragMoved) {
        track.suppressClick = true;
        window.setTimeout(() => {
          track.suppressClick = false;
        }, 0);
        const width = viewport.clientWidth || 1;
        const delta = event.clientX - dragStartX;
        let target = dragStartScroll / width;
        if (delta < -32) {
          target = Math.ceil(viewport.scrollLeft / width);
        } else if (delta > 32) {
          target = Math.floor(viewport.scrollLeft / width);
        } else {
          target = Math.round(viewport.scrollLeft / width);
        }
        track.goTo(clampIndex(Math.round(target), viewport.children.length));
      }
    };

    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);

    return track;
  }

  // --- Fullscreen photo-only lightbox (shared singleton) -------------------

  const lightbox = {
    element: null,
    viewport: null,
    counter: null,
    prevButton: null,
    nextButton: null,
    closeButton: null,
    track: null,
    photos: [],
    index: 0,
    onClose: null,
    lastFocused: null,
  };

  function isLightboxOpen() {
    return Boolean(lightbox.element) && !lightbox.element.hidden;
  }

  function ensureLightbox() {
    if (lightbox.element) {
      return;
    }

    const element = createElement('div', 'ev-lightbox', {
      role: 'dialog',
      'aria-modal': 'true',
    });
    element.hidden = true;

    const scrim = createElement('div', 'ev-lightbox__scrim');
    const viewport = createElement('div', 'ev-lightbox__viewport');
    const counter = createElement('div', 'ev-lightbox__counter');
    const closeButton = createElement('button', 'ev-lightbox__close', { type: 'button' });
    closeButton.innerHTML = CLOSE_ICON;
    const prevButton = createElement('button', 'ev-lightbox__nav ev-lightbox__nav--prev', { type: 'button' });
    prevButton.innerHTML = CHEVRON_LEFT;
    const nextButton = createElement('button', 'ev-lightbox__nav ev-lightbox__nav--next', { type: 'button' });
    nextButton.innerHTML = CHEVRON_RIGHT;

    element.append(scrim, viewport, counter, closeButton, prevButton, nextButton);
    document.body.appendChild(element);

    lightbox.element = element;
    lightbox.viewport = viewport;
    lightbox.counter = counter;
    lightbox.prevButton = prevButton;
    lightbox.nextButton = nextButton;
    lightbox.closeButton = closeButton;

    lightbox.track = setupTrack(viewport, {
      onIndexChange(index) {
        if (index !== lightbox.index) {
          lightbox.index = clampIndex(index, lightbox.photos.length);
          updateLightboxChrome();
        }
      },
    });

    scrim.addEventListener('click', closeLightbox);
    closeButton.addEventListener('click', closeLightbox);
    prevButton.addEventListener('click', () => moveLightbox(-1));
    nextButton.addEventListener('click', () => moveLightbox(1));

    // Clicking the empty letterbox area around a photo closes the view.
    viewport.addEventListener('click', (event) => {
      if (lightbox.track.suppressClick) {
        return;
      }
      if (!event.target.closest('img')) {
        closeLightbox();
      }
    });

    // Capture phase so Escape/arrows act on the lightbox before the
    // document-level handlers of the pop-up underneath.
    document.addEventListener(
      'keydown',
      (event) => {
        if (!isLightboxOpen()) {
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeLightbox();
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          event.stopPropagation();
          moveLightbox(-1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          moveLightbox(1);
        }
      },
      true,
    );

    window.addEventListener('resize', () => {
      if (isLightboxOpen()) {
        lightbox.track.goTo(lightbox.index, 'auto');
      }
    });
  }

  function updateLightboxChrome() {
    const count = lightbox.photos.length;
    lightbox.counter.textContent = `${lightbox.index + 1} / ${count}`;
    lightbox.prevButton.disabled = lightbox.index <= 0;
    lightbox.nextButton.disabled = lightbox.index >= count - 1;
    const single = count <= 1;
    lightbox.counter.hidden = single;
    lightbox.prevButton.hidden = single;
    lightbox.nextButton.hidden = single;
  }

  function moveLightbox(direction) {
    const next = clampIndex(lightbox.index + direction, lightbox.photos.length);
    if (next !== lightbox.index) {
      lightbox.index = next;
      updateLightboxChrome();
      lightbox.track.goTo(next);
    }
  }

  function openLightbox(options) {
    ensureLightbox();

    lightbox.photos = options.photos || [];
    lightbox.index = clampIndex(options.index || 0, lightbox.photos.length);
    lightbox.onClose = options.onClose || null;
    lightbox.lastFocused = document.activeElement;

    const labels = { ...DEFAULT_LABELS, ...(options.labels || {}) };
    lightbox.element.setAttribute('aria-label', options.alt || labels.expand);
    lightbox.closeButton.setAttribute('aria-label', labels.close);
    lightbox.prevButton.setAttribute('aria-label', labels.prev);
    lightbox.nextButton.setAttribute('aria-label', labels.next);

    lightbox.viewport.innerHTML = '';
    lightbox.photos.forEach((photo, index) => {
      const slide = createElement('figure', 'ev-lightbox__slide');
      const image = createElement('img', '', {
        alt: photoAlt(photo, options.alt, index),
        decoding: 'async',
      });
      image.loading = index === lightbox.index ? 'eager' : 'lazy';
      image.draggable = false;
      image.src = photoUrl(photo, 'full');
      slide.appendChild(image);
      lightbox.viewport.appendChild(slide);
    });

    lightbox.element.hidden = false;
    lightbox.track.goTo(lightbox.index, 'auto');
    updateLightboxChrome();
    lightbox.closeButton.focus();
  }

  function closeLightbox() {
    if (!isLightboxOpen()) {
      return;
    }
    lightbox.element.hidden = true;
    lightbox.viewport.innerHTML = '';
    if (typeof lightbox.onClose === 'function') {
      lightbox.onClose(lightbox.index);
    }
    lightbox.onClose = null;
    if (lightbox.lastFocused && typeof lightbox.lastFocused.focus === 'function') {
      lightbox.lastFocused.focus();
    }
    lightbox.lastFocused = null;
  }

  // --- In-modal carousel ----------------------------------------------------

  function attach(container) {
    if (container.__evGallery) {
      return container.__evGallery;
    }

    container.classList.add('ev-gallery');
    container.innerHTML = '';

    const stage = createElement('div', 'ev-gallery__stage');
    const viewport = createElement('div', 'ev-gallery__viewport');
    const prevButton = createElement('button', 'ev-gallery__nav ev-gallery__nav--prev', { type: 'button' });
    prevButton.innerHTML = CHEVRON_LEFT;
    const nextButton = createElement('button', 'ev-gallery__nav ev-gallery__nav--next', { type: 'button' });
    nextButton.innerHTML = CHEVRON_RIGHT;
    const expandButton = createElement('button', 'ev-gallery__expand', { type: 'button' });
    expandButton.innerHTML = EXPAND_ICON;
    const counter = createElement('div', 'ev-gallery__counter', { 'aria-hidden': 'true' });
    const thumbs = createElement('div', 'ev-gallery__thumbs');

    stage.append(viewport, prevButton, nextButton, expandButton, counter);
    container.append(stage, thumbs);

    const state = {
      photos: [],
      index: 0,
      alt: '',
      labels: { ...DEFAULT_LABELS },
    };

    function updateChrome() {
      const count = state.photos.length;
      const single = count <= 1;
      counter.textContent = `${state.index + 1} / ${count}`;
      counter.hidden = single;
      prevButton.hidden = single;
      nextButton.hidden = single;
      prevButton.disabled = state.index <= 0;
      nextButton.disabled = state.index >= count - 1;
      thumbs.hidden = single;
      Array.from(thumbs.children).forEach((button, index) => {
        const isActive = index === state.index;
        button.classList.toggle('is-active', isActive);
        if (isActive) {
          button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      });
    }

    const track = setupTrack(viewport, {
      onIndexChange(index) {
        const next = clampIndex(index, state.photos.length);
        if (next !== state.index) {
          state.index = next;
          updateChrome();
        }
      },
    });

    function goTo(index, behavior) {
      state.index = clampIndex(index, state.photos.length);
      updateChrome();
      track.goTo(state.index, behavior);
    }

    function openCurrentInLightbox() {
      if (!state.photos.length) {
        return;
      }
      openLightbox({
        photos: state.photos,
        index: state.index,
        alt: state.alt,
        labels: state.labels,
        onClose(index) {
          goTo(index, 'auto');
        },
      });
    }

    function renderSlides() {
      viewport.innerHTML = '';
      state.photos.forEach((photo, index) => {
        const slide = createElement('div', 'ev-gallery__slide');
        const backdropUrl = photoUrl(photo, 'preview');
        if (backdropUrl) {
          const backdrop = createElement('img', 'ev-gallery__backdrop', {
            alt: '',
            'aria-hidden': 'true',
            decoding: 'async',
          });
          backdrop.loading = index === state.index ? 'eager' : 'lazy';
          backdrop.draggable = false;
          backdrop.src = backdropUrl;
          slide.appendChild(backdrop);
        }
        const image = createElement('img', 'ev-gallery__photo', {
          alt: photoAlt(photo, state.alt, index),
          decoding: 'async',
        });
        image.loading = index === state.index ? 'eager' : 'lazy';
        image.draggable = false;
        image.src = photoUrl(photo, 'full');
        slide.appendChild(image);
        slide.addEventListener('click', () => {
          if (!track.suppressClick) {
            openCurrentInLightbox();
          }
        });
        viewport.appendChild(slide);
      });
    }

    function renderThumbs() {
      thumbs.innerHTML = '';
      state.photos.forEach((photo, index) => {
        const button = createElement('button', '', {
          type: 'button',
          'aria-label': `${state.labels.image} ${index + 1}`,
        });
        const image = createElement('img', '', { alt: '', decoding: 'async' });
        image.loading = 'lazy';
        image.draggable = false;
        image.src = photoUrl(photo, 'thumbnail');
        button.appendChild(image);
        button.addEventListener('click', () => goTo(index));
        thumbs.appendChild(button);
      });
    }

    function applyLabels() {
      prevButton.setAttribute('aria-label', state.labels.prev);
      nextButton.setAttribute('aria-label', state.labels.next);
      expandButton.setAttribute('aria-label', state.labels.expand);
      Array.from(thumbs.children).forEach((button, index) => {
        button.setAttribute('aria-label', `${state.labels.image} ${index + 1}`);
      });
    }

    prevButton.addEventListener('click', () => goTo(state.index - 1));
    nextButton.addEventListener('click', () => goTo(state.index + 1));
    expandButton.addEventListener('click', openCurrentInLightbox);

    // Arrow keys page the carousel while its pop-up is visible (and the
    // fullscreen lightbox is not on top — that one captures keys itself).
    document.addEventListener('keydown', (event) => {
      if (isLightboxOpen() || !container.isConnected || container.offsetParent === null) {
        return;
      }
      if (event.target instanceof Element && event.target.closest('input, textarea, select')) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        goTo(state.index - 1);
      } else if (event.key === 'ArrowRight') {
        goTo(state.index + 1);
      }
    });

    window.addEventListener('resize', () => {
      if (container.offsetParent !== null) {
        track.goTo(state.index, 'auto');
      }
    });

    const instance = {
      update(options) {
        const photos = Array.isArray(options.photos) ? options.photos.filter(Boolean) : [];
        const urls = photos.map((photo) => photoUrl(photo, 'full')).join('\n');
        const previousUrls = state.photos.map((photo) => photoUrl(photo, 'full')).join('\n');
        const samePhotos = urls === previousUrls && photos.length > 0;

        state.photos = photos;
        state.alt = options.alt || '';
        state.labels = { ...DEFAULT_LABELS, ...(options.labels || {}) };

        if (typeof options.startIndex === 'number') {
          state.index = clampIndex(options.startIndex, photos.length);
        } else if (samePhotos) {
          state.index = clampIndex(state.index, photos.length);
        } else {
          state.index = 0;
        }

        renderSlides();
        renderThumbs();
        applyLabels();
        updateChrome();
        window.requestAnimationFrame(() => {
          track.goTo(state.index, 'auto');
        });
      },
      goTo,
      getIndex() {
        return state.index;
      },
    };

    container.__evGallery = instance;
    return instance;
  }

  window.EcoVilaGallery = {
    attach,
    open: openLightbox,
    close: closeLightbox,
  };
})();
