import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function scriptIndex(html, src) {
  return html.indexOf(`src="${src}"`);
}

describe('EcoVila live Supabase wiring', () => {
  it('defines the live Supabase browser config with a publishable key', () => {
    const config = read('js/supabase-config.js');

    assert.match(config, /https:\/\/mckchrviaawdxtsfytut\.supabase\.co/);
    assert.match(config, /sb_publishable_/);
    assert.doesNotMatch(config, /service_role|secret/i);
    assert.match(config, /EcoVilaSupabaseConfig/);
  });

  it('loads Supabase config before the shared Supabase helper on every connected page', () => {
    const pages = [
      ['index.html', 'js/supabase-config.js', 'js/supabase.js'],
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
    const landingHtml = read('index.html');
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
    const landingHtml = read('index.html');
    const heroTag = landingHtml.match(/<section class="hero"[\s\S]*?>/)?.[0] || '';
    const landingSlotIndexes = Array.from(
      landingHtml.matchAll(/<img[^>]+data-photo-section="landing"[^>]+data-photo-index="(\d+)"/g),
      (match) => Number(match[1]),
    );

    assert.doesNotMatch(heroTag, /data-photo-background="landing"/);
    assert.deepEqual(landingSlotIndexes, [0, 1, 2, 3, 4, 5]);
  });
});
