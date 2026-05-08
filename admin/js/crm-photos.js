(function (root, factory) {
  const api = factory(root);
  root.EcoVilaCrmPhotos = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const ECOVILA_PHOTO_BUCKET = 'ecovila-photos';
  const PUBLISH_RPC = 'publish_crm_photos';
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

  function renderPhotoSection(context, section, photos) {
    const existing = qs(`[data-photo-section="${section.slug}"]`);
    if (!existing) {
      return;
    }

    existing.innerHTML = `
      <div class="crm-section-heading">
        <h2>${section.label}</h2>
        <label class="crm-button crm-button--small">
          Adaugă poze
          <input type="file" accept="image/*" multiple hidden data-photo-upload="${section.slug}">
        </label>
      </div>
      <div class="crm-photo-list"></div>
    `;

    const list = qs('.crm-photo-list', existing);
    const ordered = photos.slice().sort((left, right) => left.sort_order - right.sort_order);

    if (!ordered.length) {
      list.innerHTML = '<p class="crm-empty">Nu sunt poze în draft.</p>';
    } else {
      ordered.forEach((photo) => {
        const isMain = photo.sort_order === 1;
        const item = root.document.createElement('article');
        item.className = 'crm-photo-thumb';
        item.innerHTML = `
          <img src="${publicUrl(context, photo)}" alt="${photo.alt_text || section.label}">
          <div>
            <strong>${isMain ? 'Imagine principală' : `Poza ${photo.sort_order}`}</strong>
            <p>${photo.alt_text || section.label}</p>
            <button class="crm-button crm-button--small" type="button" data-remove-photo="${photo.id}">Șterge</button>
          </div>
        `;
        list.appendChild(item);
      });
    }

    qs(`[data-photo-upload="${section.slug}"]`, existing)?.addEventListener('change', (event) => {
      uploadFiles(context, section, Array.from(event.target.files || []), ordered.length);
    });

    existing.querySelectorAll('[data-remove-photo]').forEach((button) => {
      button.addEventListener('click', () => removePhoto(context, button.dataset.removePhoto));
    });
  }

  async function uploadFiles(context, section, files, currentCount) {
    for (const [index, file] of files.entries()) {
      const extension = file.name.split('.').pop() || 'jpg';
      const storagePath = `${section.slug}/${Date.now()}-${index}.${extension}`;
      const upload = await root.EcoVilaSupabase.uploadCrmPhoto(context.client, storagePath, file);
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
    }
    await loadPhotos(context);
  }

  async function removePhoto(context, photoId) {
    await root.EcoVilaSupabase.deleteCrmPhoto(context.client, photoId);
    await loadPhotos(context);
  }

  async function publish(context) {
    await root.EcoVilaSupabase.publishCrmPhotos(context.client);
    await loadPhotos(context);
    context.setAlert('Pozele au fost publicate.');
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
    renderPhotoSection,
  };
});
