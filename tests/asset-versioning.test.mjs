import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TOPHOST_UPLOAD_ENTRIES } from '../scripts/prepare-tophost-upload.mjs';
import {
  stampHtml,
  defaultVersion,
  findUnversionedAssetRefs,
  collectHtmlFiles,
} from '../scripts/stamp-asset-versions.mjs';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('Asset cache-busting version stamps', () => {
  it('exposes a root npm command for bumping asset versions', () => {
    const manifest = JSON.parse(read('package.json'));
    assert.equal(manifest.scripts['bump:assets'], 'node scripts/stamp-asset-versions.mjs');
  });

  it('stamps a ?v= token onto local css and js references', () => {
    const input = '<link rel="stylesheet" href="css/main.css">\n<script src="js/app.js"></script>';
    const { html, count } = stampHtml(input, '20260619');

    assert.equal(count, 2);
    assert.match(html, /href="css\/main\.css\?v=20260619"/);
    assert.match(html, /src="js\/app\.js\?v=20260619"/);
  });

  it('covers every local path style (root-absolute, relative, parent-relative, vendor)', () => {
    const input = [
      '<link href="/css/main.css">',
      '<link href="../css/crm.css">',
      '<script src="js/booking.js"></script>',
      '<script src="../js/pricing.js"></script>',
      '<script src="js/vendor/qrcode.js"></script>',
    ].join('\n');

    const { html, count } = stampHtml(input, '1');
    assert.equal(count, 5);
    assert.equal(findUnversionedAssetRefs(html).length, 0);
  });

  it('replaces an existing token instead of stacking it (re-runnable bumps)', () => {
    const once = stampHtml('<script src="js/app.js"></script>', '20260101').html;
    const twice = stampHtml(once, '20260619').html;

    assert.match(twice, /src="js\/app\.js\?v=20260619"/);
    assert.doesNotMatch(twice, /\?v=20260101/);
    assert.doesNotMatch(twice, /\?v=[^"]*\?v=/);
  });

  it('never rewrites external, protocol-relative, or data URLs', () => {
    const input = [
      '<link href="https://fonts.googleapis.com/css2?family=Montserrat">',
      '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
      '<script src="//cdn.example.com/lib.js"></script>',
    ].join('\n');

    const { html, count } = stampHtml(input, '20260619');
    assert.equal(count, 0);
    assert.equal(html, input);
  });

  it('leaves non css/js references (html pages, images) untouched', () => {
    const input = '<a href="checkout.html">go</a><img src="/assets/logo.png">';
    const { html, count } = stampHtml(input, '20260619');

    assert.equal(count, 0);
    assert.equal(html, input);
  });

  it('produces a YYYYMMDD default version', () => {
    assert.equal(defaultVersion(new Date(Date.UTC(2026, 5, 9))), '20260609');
    assert.match(defaultVersion(), /^\d{8}$/);
  });

  it('ships no unversioned local css/js reference in any deployed HTML page', async () => {
    const htmlFiles = await collectHtmlFiles(root, TOPHOST_UPLOAD_ENTRIES);

    // Sanity: the deploy really does include the public pages and admin.
    assert.ok(htmlFiles.includes('rezervari.html'));
    assert.ok(htmlFiles.includes('admin/dashboard.html'));
    assert.ok(htmlFiles.includes('en/index.html'));

    const offenders = [];
    for (const relPath of htmlFiles) {
      const unversioned = findUnversionedAssetRefs(read(relPath));
      if (unversioned.length) {
        offenders.push(`${relPath}: ${unversioned.join(', ')}`);
      }
    }

    assert.deepEqual(offenders, [], `Unversioned assets found:\n${offenders.join('\n')}`);
  });
});
