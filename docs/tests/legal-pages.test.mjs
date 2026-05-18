import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function articleMarkup(html) {
  const match = html.match(/<article[^>]*class="legal-article"[\s\S]*?<\/article>/);
  return match ? match[0] : '';
}

describe('EcoVila Step 8 legal pages', () => {
  it('creates the two legal pages and their focused stylesheet', () => {
    for (const file of [
      'politica-confidentialitate.html',
      'termeni-conditii.html',
      'css/legal.css',
    ]) {
      assert.ok(exists(file), `${file} should exist`);
    }
  });

  it('reuses the public header, footer, cookie banner, and shared scripts', () => {
    for (const file of ['politica-confidentialitate.html', 'termeni-conditii.html']) {
      const html = read(file);

      for (const pattern of [
        /<header class="site-header" data-header>/,
        /data-lang-select/,
        /href="rezervari\.html"/,
        /<footer class="site-footer" id="footer">/,
        /id="cookie-banner"/,
        /href="politica-confidentialitate\.html"/,
        /href="termeni-conditii\.html"/,
        /href="css\/main\.css"/,
        /href="css\/legal\.css"/,
        /src="js\/translations\.js"/,
        /src="js\/main\.js"/,
      ]) {
        assert.match(html, pattern, `${file} should include ${pattern}`);
      }
    }
  });

  it('renders the Romanian privacy-policy article from the supplied source', () => {
    const html = read('politica-confidentialitate.html');
    const article = articleMarkup(html);

    assert.match(html, /<h1>Politică de confidențialitate<\/h1>/);
    assert.match(article, /Textul juridic este afișat în limba română\./);
    assert.match(article, /Ce date colectăm/);
    assert.match(article, /Drepturile persoanei vizate/);
    assert.match(article, /privacy@ecovila\.md/);
  });

  it('renders the Romanian terms article with the supplied 7-day refund wording', () => {
    const html = read('termeni-conditii.html');
    const article = articleMarkup(html);

    assert.match(html, /<h1>Termeni și condiții<\/h1>/);
    assert.match(article, /Textul juridic este afișat în limba română\./);
    assert.match(article, /Check-in și check-out/);
    assert.match(article, /Reguli pentru piscină și SPA/);
    assert.match(article, /cel puțin 7 zile calendaristice/);
  });

  it('keeps legal body copy Romanian-only instead of wiring it to translations', () => {
    for (const file of ['politica-confidentialitate.html', 'termeni-conditii.html']) {
      const article = articleMarkup(read(file));
      assert.ok(article, `${file} should have a legal article`);
      assert.doesNotMatch(article, /data-i18n=/, `${file} article should stay Romanian-only`);
    }
  });

  it('keeps existing public links pointed at the new legal pages', () => {
    for (const file of [
      'site.html',
      'rezervari.html',
      'checkout.html',
      'confirmare.html',
      'anulare.html',
    ]) {
      const html = read(file);
      assert.match(html, /href="politica-confidentialitate\.html"/, `${file} should link privacy page`);
      assert.match(html, /href="termeni-conditii\.html"/, `${file} should link terms page`);
    }
  });
});
