(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmPhotos = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const ECOVILA_PHOTO_BUCKET = 'ecovila-photos';
  const PUBLISH_RPC = 'publish_crm_photos';
  // Uploads are downscaled and re-encoded to WebP in the browser before they
  // reach storage, so the stored master is a few hundred KB instead of a
  // multi-MB phone photo. 2000px on the long edge keeps headroom above the
  // 1800px lightbox variant; quality 0.82 is visually lossless for photos.
  const UPLOAD_MAX_EDGE = 2000;
  const UPLOAD_WEBP_QUALITY = 0.82;
  const TRANSFORMABLE_TYPE = /^image\/(jpeg|png|webp|avif)$/i;
  let photoToastTimer;
  let photoToastHideTimer;
  const FALLBACK_SECTIONS = [
    { slug: 'landing', label: 'Landing' },
    { slug: 'small-villa', label: 'Căsuță Mică' },
    { slug: 'large-villa', label: 'Căsuță Mare' },
    { slug: 'hotel', label: 'Hotel' },
    { slug: 'spa', label: 'SPA' },
    { slug: 'territory', label: 'Teritoriu' },
    { slug: 'restaurant-food', label: 'Restaurant/Mâncare' },
    { slug: 'playground', label: 'Teren de joacă' },
  ];

  function qs(selector, scope) {
    return (scope || root.document).querySelector(selector);
  }

  function publicUrl(context, photo) {
    return root.EcoVilaSupabase.getCrmPhotoPublicUrl(context.client, photo.storage_path);
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character]));
  }

  function photoCountLabel(count) {
    return count === 1 ? '1 poză' : `${count} poze`;
  }

  function sectionTitle(label) {
    return escapeHtml(label).replace(/\//g, '/<wbr>');
  }

  function photoTitle(section, photo, index) {
    if (section.slug === 'landing') {
      return `Poza ${index + 2} pe site`;
    }

    return photo.sort_order === 1 ? 'Imagine principală' : `Poza ${photo.sort_order}`;
  }

  function renderPhotoThumb(context, section, photo, index, variant) {
    const item = root.document.createElement('article');
    const variantClass = variant === 'primary' ? 'crm-photo-thumb--primary' : 'crm-photo-thumb--secondary';
    const title = photoTitle(section, photo, index);
    const alt = photo.alt_text || section.label;

    item.className = `crm-photo-thumb ${variantClass}`;
    item.draggable = true;
    item.innerHTML = `
      <div class="crm-photo-thumb__media">
        <img src="${escapeHtml(publicUrl(context, photo))}" alt="${escapeHtml(alt)}">
      </div>
      <button class="crm-button crm-button--small crm-photo-remove" type="button" data-remove-photo="${escapeHtml(photo.id)}" title="Șterge poza">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 6h18"></path>
          <path d="M8 6V4h8v2"></path>
          <path d="m10 11 .5 7"></path>
          <path d="m14 11-.5 7"></path>
          <path d="M6 6l1 15h10l1-15"></path>
        </svg>
        <span>Șterge</span>
      </button>
      <span class="crm-photo-position">${escapeHtml(title)}</span>
    `;
    if (item.setAttribute) {
      item.setAttribute('data-photo-id', photo.id);
      item.setAttribute('data-photo-section-slug', section.slug);
      item.setAttribute('draggable', 'true');
      item.setAttribute('title', 'Trage poza pentru a schimba ordinea');
    }

    return item;
  }

  function movePhotoBefore(photos, draggedId, targetId) {
    if (!draggedId || !targetId || draggedId === targetId) {
      return photos.slice();
    }

    const nextPhotos = photos.slice();
    const draggedIndex = nextPhotos.findIndex((photo) => photo.id === draggedId);
    const targetIndex = nextPhotos.findIndex((photo) => photo.id === targetId);

    if (draggedIndex < 0 || targetIndex < 0) {
      return nextPhotos;
    }

    const [draggedPhoto] = nextPhotos.splice(draggedIndex, 1);
    const insertionIndex = nextPhotos.findIndex((photo) => photo.id === targetId);
    nextPhotos.splice(insertionIndex, 0, draggedPhoto);

    return nextPhotos;
  }

  function withSortOrder(photos) {
    return photos.map((photo, index) => ({
      ...photo,
      sort_order: index + 1,
    }));
  }

  async function reorderPhotos(context, section, ordered, draggedId, targetId) {
    const nextPhotos = withSortOrder(movePhotoBefore(ordered, draggedId, targetId));

    renderPhotoSection(context, section, nextPhotos);

    await Promise.all(nextPhotos.map((photo, index) => (
      root.EcoVilaSupabase.updateCrmPhoto(context.client, photo.id, { sort_order: index + 1 })
    )));

    return nextPhotos;
  }

  function wirePhotoReordering(context, section, ordered, scope) {
    scope.querySelectorAll('.crm-photo-thumb[draggable="true"]').forEach((thumb) => {
      thumb.addEventListener('dragstart', (event) => {
        thumb.classList.add('is-dragging');
        event.dataTransfer?.setData('text/plain', thumb.dataset.photoId);
        event.dataTransfer?.setData('application/x-ecovila-photo-section', section.slug);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
        }
      });

      thumb.addEventListener('dragend', () => {
        thumb.classList.remove('is-dragging');
        scope.querySelectorAll('.crm-photo-thumb.is-drop-target').forEach((target) => {
          target.classList.remove('is-drop-target');
        });
      });

      thumb.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'move';
        }
        thumb.classList.add('is-drop-target');
      });

      thumb.addEventListener('dragleave', () => {
        thumb.classList.remove('is-drop-target');
      });

      thumb.addEventListener('drop', async (event) => {
        event.preventDefault();
        thumb.classList.remove('is-drop-target');

        const draggedId = event.dataTransfer?.getData('text/plain');
        const draggedSection = event.dataTransfer?.getData('application/x-ecovila-photo-section');
        const targetId = thumb.dataset.photoId;

        if (!draggedId || draggedSection !== section.slug || draggedId === targetId) {
          return;
        }

        try {
          await reorderPhotos(context, section, ordered, draggedId, targetId);
        } catch (error) {
          loadPhotos(context).catch(() => {});
          context.setAlert(error?.message || 'Ordinea pozelor nu s-a putut salva.');
        }
      });
    });
  }

  function renderPhotoSection(context, section, photos) {
    const existing = qs(`[data-photo-section="${section.slug}"]`);
    if (!existing) {
      return;
    }

    const ordered = photos.slice().sort((left, right) => left.sort_order - right.sort_order);

    existing.innerHTML = `
      <div class="crm-photo-card-head">
        <h2>${sectionTitle(section.label)}</h2>
        <span class="crm-photo-count" data-photo-count="${ordered.length}">${photoCountLabel(ordered.length)}</span>
        <label class="crm-button crm-button--small crm-photo-add">
          <span>Adaugă poze</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8"></circle>
            <path d="M12 8v8"></path>
            <path d="M8 12h8"></path>
          </svg>
          <input type="file" accept="image/*" multiple hidden data-photo-upload="${section.slug}">
        </label>
      </div>
      <div class="crm-photo-list"></div>
    `;

    const list = qs('.crm-photo-list', existing);

    if (!ordered.length) {
      list.innerHTML = `
        <div class="crm-photo-empty">
          <span class="crm-photo-empty__icon" aria-hidden="true">
            <svg viewBox="0 0 96 96">
              <circle cx="48" cy="48" r="40"></circle>
              <path d="M31 62V36h31v26H31Z"></path>
              <path d="m35 58 12-12 8 8 5-5 8 9"></path>
              <path d="M40 30h31v26"></path>
              <path d="M52 42h.01"></path>
            </svg>
          </span>
          <p>Nu sunt poze în draft.</p>
        </div>
      `;
    } else {
      const primaryLabel = root.document.createElement('p');
      primaryLabel.className = 'crm-photo-group-label';
      primaryLabel.textContent = 'Imagine principală';
      list.appendChild(primaryLabel);
      list.appendChild(renderPhotoThumb(context, section, ordered[0], 0, 'primary'));

      if (ordered.length > 1) {
        const secondaryLabel = root.document.createElement('p');
        const secondaryGrid = root.document.createElement('div');

        secondaryLabel.className = 'crm-photo-group-label';
        secondaryLabel.textContent = 'Alte poze';
        secondaryGrid.className = 'crm-photo-secondary-grid';

        ordered.slice(1).forEach((photo, index) => {
          secondaryGrid.appendChild(renderPhotoThumb(context, section, photo, index + 1, 'secondary'));
        });

        list.appendChild(secondaryLabel);
        list.appendChild(secondaryGrid);
      }
    }

    qs(`[data-photo-upload="${section.slug}"]`, existing)?.addEventListener('change', (event) => {
      uploadFiles(context, section, Array.from(event.target.files || []), ordered.length)
        .catch((error) => {
          console.error('Photo upload flow failed', error);
          showPhotoToast('Încărcarea pozelor a eșuat. Reîncarcă pagina și încearcă din nou.');
        });
    });

    existing.querySelectorAll('[data-remove-photo]').forEach((button) => {
      button.addEventListener('click', () => {
        removePhoto(context, button.dataset.removePhoto).catch((error) => {
          console.error('Photo delete flow failed', error);
          showPhotoToast('Ștergerea a eșuat. Reîncarcă pagina și încearcă din nou.');
        });
      });
    });

    wirePhotoReordering(context, section, ordered, existing);
  }

  function fileExtension(file) {
    return (file.name.split('.').pop() || 'jpg').toLowerCase();
  }

  // Downscale + re-encode to WebP in the browser. Animated GIFs and anything we
  // can't decode are passed through untouched so the upload still succeeds.
  async function prepareUpload(file) {
    const passthrough = {
      blob: file,
      extension: fileExtension(file),
      contentType: file.type || 'application/octet-stream',
    };

    if (!file || !TRANSFORMABLE_TYPE.test(file.type) || typeof root.createImageBitmap !== 'function') {
      return passthrough;
    }

    try {
      // 'from-image' applies EXIF orientation so portrait phone shots aren't
      // rotated once the orientation tag is dropped by the canvas.
      const bitmap = await root.createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, UPLOAD_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const useOffscreen = typeof root.OffscreenCanvas === 'function';
      const canvas = useOffscreen
        ? new root.OffscreenCanvas(width, height)
        : Object.assign(root.document.createElement('canvas'), { width, height });

      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();

      const blob = canvas.convertToBlob
        ? await canvas.convertToBlob({ type: 'image/webp', quality: UPLOAD_WEBP_QUALITY })
        : await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', UPLOAD_WEBP_QUALITY));

      if (!blob || blob.type !== 'image/webp') {
        return passthrough;
      }

      return { blob, extension: 'webp', contentType: 'image/webp' };
    } catch (error) {
      return passthrough;
    }
  }

  async function uploadFiles(context, section, files, currentCount) {
    // Per-file isolation: one bad file (too large, storage hiccup) must not
    // silently abort the rest of the batch — it used to die as an unhandled
    // rejection mid-loop with zero feedback.
    const failed = [];
    for (const [index, file] of files.entries()) {
      try {
        const prepared = await prepareUpload(file);
        const storagePath = `${section.slug}/${Date.now()}-${index}.${prepared.extension}`;
        const upload = await root.EcoVilaSupabase.uploadCrmPhoto(context.client, storagePath, prepared.blob, {
          contentType: prepared.contentType,
        });
        if (upload.error) {
          throw upload.error;
        }
        await root.EcoVilaSupabase.insertCrmPhoto(context.client, {
          section_id: section.id,
          storage_path: storagePath,
          alt_text: section.label,
          sort_order: currentCount + index + 1,
          status: 'draft',
          created_by: context.session.user.id,
        });
      } catch (error) {
        console.error('Photo upload failed', { file: file?.name, error });
        failed.push(file?.name || `fișierul ${index + 1}`);
      }
    }
    await loadPhotos(context);
    if (failed.length) {
      showPhotoToast(`Nu s-au putut încărca: ${failed.join(', ')}`);
    }
  }

  async function removePhoto(context, photoId) {
    // Deleting is one click on a live gallery — require a confirmation. (The
    // delete is DB-row-only, so the file stays recoverable in storage, but the
    // photo still vanishes from the site at the next publish.)
    if (!root.confirm?.('Ștergi această fotografie din galerie?')) {
      return;
    }
    try {
      await root.EcoVilaSupabase.deleteCrmPhoto(context.client, photoId);
    } catch (error) {
      console.error('Photo delete failed', error);
      showPhotoToast('Fotografia nu a putut fi ștearsă. Încearcă din nou.');
      return;
    }
    await loadPhotos(context);
  }

  async function publish(context) {
    await root.EcoVilaSupabase.publishCrmPhotos(context.client);
    await loadPhotos(context);
    showPhotoToast('Pozele au fost publicate.');
  }

  function showPhotoToast(message) {
    const toast = qs('[data-crm-toast]');
    if (!toast) {
      return false;
    }

    root.clearTimeout?.(photoToastTimer);
    root.clearTimeout?.(photoToastHideTimer);
    toast.textContent = message || '';
    toast.hidden = false;
    toast.classList.remove('is-visible', 'is-hiding');
    toast.offsetWidth;
    toast.classList.add('is-visible');

    photoToastTimer = root.setTimeout(() => {
      toast.classList.remove('is-visible');
      toast.classList.add('is-hiding');
      photoToastHideTimer = root.setTimeout(() => {
        toast.hidden = true;
        toast.classList.remove('is-hiding');
      }, 220);
    }, 3000);

    return true;
  }

  async function loadPhotos(context) {
    const sections = await root.EcoVilaSupabase.fetchPhotoSections(context.client).catch(() => FALLBACK_SECTIONS);
    const photos = await root.EcoVilaSupabase.fetchCrmPhotos(context.client, 'draft').catch(() => []);

    (sections.length ? sections : FALLBACK_SECTIONS).forEach((section) => {
      renderPhotoSection(
        context,
        section,
        photos.filter((photo) => photo.section_id === section.id || photo.crm_photo_sections?.slug === section.slug),
      );
    });
  }

  function init(context) {
    qs('[data-publish-photos]')?.addEventListener('click', () => publish(context));
    loadPhotos(context).catch((error) => context.setAlert(error?.message || 'Pozele nu s-au putut încărca.'));
  }

  return {
    ECOVILA_PHOTO_BUCKET,
    PUBLISH_RPC,
    init,
    loadPhotos,
    publish,
    reorderPhotos,
    renderPhotoSection,
    showPhotoToast,
  };
});
