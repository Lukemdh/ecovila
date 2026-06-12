import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadBrowserModule(relativePath, extras = {}) {
  const sandbox = {
    console,
    ...extras,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(read(relativePath), sandbox, { filename: relativePath });
  return sandbox;
}

function scriptIndex(html, src) {
  return html.indexOf(`src="${src}"`);
}

describe('EcoVila live Supabase wiring', () => {
  it('defines the live Supabase browser config with the anon JWT required by Edge Functions', () => {
    const config = read('js/supabase-config.js');

    assert.match(config, /https:\/\/mckchrviaawdxtsfytut\.supabase\.co/);
    assert.match(config, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
    assert.doesNotMatch(config, /service_role|secret/i);
    assert.match(config, /EcoVilaSupabaseConfig/);
  });

  it('loads Supabase config before the shared Supabase helper on every connected page', () => {
    const pages = [
      ['site.html', 'js/supabase-config.js', 'js/supabase.js'],
      ['rezervari.html', 'js/supabase-config.js', 'js/supabase.js'],
      ['checkout.html', 'js/supabase-config.js', 'js/supabase.js'],
      ['admin/index.html', '../js/supabase-config.js', '../js/supabase.js'],
      ['admin/dashboard.html', '../js/supabase-config.js', '../js/supabase.js'],
    ];

    for (const [page, configSrc, helperSrc] of pages) {
      const html = read(page);
      const configIndex = scriptIndex(html, configSrc);
      const helperIndex = scriptIndex(html, helperSrc);

      assert.ok(configIndex > -1, `${page} should load ${configSrc}`);
      assert.ok(helperIndex > -1, `${page} should load ${helperSrc}`);
      assert.ok(configIndex < helperIndex, `${page} should load Supabase config before helper`);
    }
  });

  it('wires published CRM photos into the public website and booking galleries', () => {
    const landingHtml = read('site.html');
    const mainJs = read('js/main.js');
    const bookingJs = read('js/booking.js');

    assert.match(landingHtml, /data-photo-section="landing"/);
    assert.match(landingHtml, /data-photo-index="5"/);
    assert.match(mainJs, /fetchPublicPhotoLibrary/);
    assert.match(mainJs, /applyPublishedPhotos/);
    assert.match(mainJs, /data-photo-section/);
    assert.match(bookingJs, /fetchPublicPhotoLibrary/);
    assert.match(bookingJs, /mergePublishedPhotos/);
    assert.match(bookingJs, /small-villa/);
  });

  it('maps Landing tab photos to homepage slots after the hardcoded hero media', () => {
    const landingHtml = read('site.html');
    const heroTag = landingHtml.match(/<section class="hero"[\s\S]*?>/)?.[0] || '';
    const landingSlotIndexes = Array.from(
      landingHtml.matchAll(/<img[^>]+data-photo-section="landing"[^>]+data-photo-index="(\d+)"/g),
      (match) => Number(match[1]),
    );

    assert.doesNotMatch(heroTag, /data-photo-background="landing"/);
    assert.deepEqual(landingSlotIndexes, [0, 1, 2, 3, 4, 5]);
  });

  it('builds optimized public photo variants instead of only raw storage URLs', () => {
    const { EcoVilaSupabase: helpers } = loadBrowserModule('js/supabase.js');
    const calls = [];
    const client = {
      storage: {
        from(bucket) {
          return {
            getPublicUrl(storagePath, options) {
              calls.push({ bucket, storagePath, options });
              const width = options?.transform?.width || 'raw';
              const height = options?.transform?.height || 'auto';
              return { data: { publicUrl: `/public/${bucket}/${storagePath}/${width}x${height}` } };
            },
          };
        },
      },
    };

    const library = helpers.groupPublishedPhotos(client, [
      {
        id: 'photo-1',
        storage_path: 'landing/forest.jpg',
        alt_text: 'Forest',
        sort_order: 1,
        crm_photo_sections: { slug: 'landing' },
      },
    ]);

    assert.equal(library.landing[0].originalUrl, '/public/ecovila-photos/landing/forest.jpg/rawxauto');
    assert.equal(library.landing[0].previewUrl, '/public/ecovila-photos/landing/forest.jpg/1400x1050');
    assert.equal(library.landing[0].wideUrl, '/public/ecovila-photos/landing/forest.jpg/2200x950');
    assert.equal(library.landing[0].cardUrl, '/public/ecovila-photos/landing/forest.jpg/900x600');
    assert.equal(library.landing[0].thumbnailUrl, '/public/ecovila-photos/landing/forest.jpg/360x240');
    assert.equal(library.landing[0].fullUrl, '/public/ecovila-photos/landing/forest.jpg/1800x1800');
    assert.equal(library.landing[0].url, library.landing[0].previewUrl);
    assert.deepEqual(
      calls
        .map((call) => call.options?.transform)
        .filter(Boolean)
        .map((transform) => ({
          width: transform.width,
          height: transform.height,
          quality: transform.quality,
          resize: transform.resize,
        })),
      [
        { width: 1400, height: 1050, quality: 72, resize: 'cover' },
        { width: 2200, height: 950, quality: 72, resize: 'cover' },
        { width: 900, height: 600, quality: 72, resize: 'cover' },
        { width: 360, height: 240, quality: 65, resize: 'cover' },
        // The full variant keeps the original aspect ratio so the pop-up
        // carousel and lightbox never receive server-cropped portraits.
        { width: 1800, height: 1800, quality: 78, resize: 'contain' },
      ],
    );
  });
});
