import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const requiredFiles = [
  'site.html',
  'css/main.css',
  'js/main.js',
  'js/translations.js',
  'assets/logo.png',
];

const photoFolders = [
  'small-villa',
  'large-villa',
  'hotel',
  'conference-room',
  'spa',
  'territory',
  'restaurant',
  'other',
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function sectionMarkup(html, id) {
  const match = html.match(new RegExp(`<section[^>]+id="${id}"[\\s\\S]*?</section>`));
  return match ? match[0] : '';
}

function footerMarkup(html) {
  const match = html.match(/<footer[\s\S]*?<\/footer>/);
  return match ? match[0] : '';
}

describe('EcoVila landing page structure', () => {
  it('creates the required static files', () => {
    for (const file of requiredFiles) {
      assert.ok(fs.existsSync(path.join(root, file)), `${file} should exist`);
    }
  });

  it('creates approved photo folders with replaceable placeholders', () => {
    for (const folder of photoFolders) {
      const folderPath = path.join(root, 'assets/photos', folder);
      assert.ok(fs.existsSync(folderPath), `${folderPath} should exist`);
      const svgFiles = fs.readdirSync(folderPath).filter((file) => file.endsWith('.svg'));
      assert.ok(svgFiles.length >= 1, `${folder} should contain at least one SVG placeholder`);
    }
  });

  it('includes all required landing sections and public CTAs', () => {
    const html = read('site.html');
    const sections = [
      'hero',
      'spa',
      'restaurant',
      'accommodation',
      'conference',
      'footer',
    ];

    for (const section of sections) {
      assert.match(html, new RegExp(`id="${section}"`), `${section} section should exist`);
    }

    assert.doesNotMatch(html, /id="territory"/, 'territory section should be removed from the landing page');
    assert.doesNotMatch(html, /Teritoriu relaxant/, 'territory intro copy should not remain in the page');
    assert.match(html, /href="rezervari\.html"/, 'reservation CTA should link to rezervari.html');
    assert.match(html, /data-lang-select/, 'language dropdown should exist');
    assert.match(html, /id="cookie-banner"/, 'cookie consent banner should exist');
    assert.match(html, /data-booking-modal/, 'accommodation modal should exist');
  });

  it('references only local assets that exist', () => {
    const html = read('site.html');
    const css = read('css/main.css');
    const combined = `${html}\n${css}`;
    const assetReferences = [...combined.matchAll(/["'(]\/?(assets\/[^"')]+)["')]/g)].map(
      (match) => match[1],
    );

    assert.ok(assetReferences.length >= 10, 'landing page should reference local assets');

    for (const asset of assetReferences) {
      assert.ok(fs.existsSync(path.join(root, asset)), `${asset} should exist`);
    }
  });

  it('uses the alternate logo artwork in the footer', () => {
    const html = read('site.html');
    const footer = footerMarkup(html);

    assert.match(footer, /src="\/assets\/logoNT\.png"/, 'footer should use the alternate PNG logo');
  });

  it('marks public photo surfaces for lazy asynchronous loading', () => {
    const html = read('site.html');
    const photoTags = Array.from(
      html.matchAll(/<img[^>]+(?:data-photo-section|data-accommodation-type|data-booking-modal-image)[^>]*>/g),
      (match) => match[0],
    );

    assert.ok(photoTags.length >= 10, 'landing page should expose public photo tags');

    for (const tag of photoTags) {
      assert.match(tag, /loading="lazy"/, `${tag} should lazy-load`);
      assert.match(tag, /decoding="async"/, `${tag} should decode asynchronously`);
    }
  });

  it('defines the editorial hospitality design language and translation surface', () => {
    const css = read('css/main.css');
    const html = read('site.html');
    const translations = read('js/translations.js');

    assert.doesNotMatch(html, /class="primary-nav"/, 'header should not include a copied white pill navigation');
    assert.doesNotMatch(css, /\.primary-nav/, 'CSS should not keep the white pill nav styles');
    assert.doesNotMatch(html, /logo\.svg/, 'landing page should not use the old SVG logo');
    assert.match(html, /src="\/assets\/logo\.png"/, 'landing page should use the provided PNG logo');
    assert.match(html, /class="language-dropdown header-bar-control"/, 'language control should use the header bar treatment');
    assert.match(html, /class="language-select"/, 'language dropdown should use a native select');
    assert.match(html, /class="hero__cta editorial-link"/, 'hero CTA should use an editorial underline link');
    assert.match(html, /class="menu-link header-bar-control"/, 'header CTA should use the shared bar control style');
    assert.equal(
      [...html.matchAll(/href="rezervari\.html"/g)].length,
      3,
      'reservation CTAs should appear only in the header, hero, and bottom repeat section',
    );
    assert.match(css, /--paper:\s*#F7F4EF/i, 'CSS should include a light editorial paper surface');
    assert.match(css, /--espresso:\s*#33261F/i, 'CSS should include a dark brown footer surface');
    assert.match(css, /\.site-footer\s*{[^}]*padding:\s*30px 0/s, 'footer should stay compact');
    assert.match(css, /\.site-footer__logo\s*{[^}]*width:\s*96px/s, 'footer logo should stay small');
    assert.match(
      css,
      /\.site-footer__grid\s*{[^}]*grid-template-columns:\s*minmax\(220px,\s*280px\)\s+minmax\(180px,\s*220px\)\s+minmax\(140px,\s*180px\)\s+minmax\(180px,\s*220px\)[^}]*width:\s*fit-content[^}]*margin-inline:\s*auto/s,
      'desktop footer columns should stay compact and center as one group',
    );
    assert.match(
      css,
      /\.site-footer__legal\s*{[^}]*grid-template-columns:\s*1fr/s,
      'footer contact details should stack in one column',
    );
    assert.doesNotMatch(
      css,
      /\.site-footer__legal\s*{[^}]*justify-items:\s*center|\.site-footer__legal\s*{[^}]*text-align:\s*center/s,
      'footer contact details should align like the other footer columns',
    );
    assert.match(
      css,
      /\.site-footer__legal dt,\s*\.site-footer__social h2,\s*\.site-footer__links h2\s*{[^}]*font-size:\s*0\.68rem/s,
      'footer labels should use small utility text',
    );
    assert.match(css, /\.site-header\s*{[^}]*grid-template-columns:\s*minmax\(88px,\s*120px\) auto/s, 'desktop header should use a compact logo column');
    assert.match(css, /\.site-header\s*{[^}]*padding:\s*12px 24px/s, 'desktop header should use compact padding');
    assert.match(css, /\.brand\s*{[^}]*width:\s*min\(120px,\s*13vw\)/s, 'desktop header logo should stay small');
    assert.match(css, /Cormorant Garamond/, 'CSS should use an elegant serif for display typography');
    assert.match(css, /Montserrat/, 'CSS should use a clean uppercase-friendly sans');
    assert.match(css, /\.photo-panel/, 'CSS should support large editorial image panels');
    assert.match(css, /\.image-hero/, 'CSS should support full-bleed image sections');
    assert.match(css, /\.header-bar-control\s*{[^}]*width:\s*fit-content/s, 'header link controls should avoid extra underline length');
    assert.match(css, /\.header-bar-control::after\s*{[^}]*width:\s*100%/s, 'header controls should draw underlines from their own control width');
    assert.match(css, /\.language-dropdown\.header-bar-control\s*{[^}]*width:\s*48px/s, 'language control should use a tight desktop width');
    assert.match(css, /\.language-select\s*{[^}]*width:\s*100%/s, 'language select should fill the tight language control width');
    assert.match(css, /\.editorial-link\s*{[^}]*justify-content:\s*flex-start/s, 'reservation CTA text should align left');
    assert.match(css, /\.editorial-link\s*{[^}]*text-align:\s*left/s, 'reservation CTA should not inherit centered text alignment');
    assert.match(css, /\.editorial-link\s*{[^}]*min-width:\s*0/s, 'reservation CTA underline should shrink to text width');
    assert.match(css, /\.hero\s*{[^}]*place-items:\s*end start/s, 'hero content should sit low and left');
    assert.match(css, /\.hero__content\s*{[^}]*text-align:\s*left/s, 'hero text should align left');

    const hero = sectionMarkup(html, 'hero');
    assert.match(hero, /data-i18n="hero\.title"/, 'hero should keep the main headline');
    assert.match(hero, /data-i18n="hero\.cta"/, 'hero should keep the reservation CTA');
    assert.doesNotMatch(hero, /data-i18n="hero\.place"/, 'hero should not show the location line');
    assert.doesNotMatch(hero, /data-i18n="hero\.text"/, 'hero should not show the descriptive subheading');

    const accommodation = sectionMarkup(html, 'accommodation');
    assert.match(accommodation, /data-i18n="showcase\.accommodation\.title"/, 'accommodation section should keep the headline');
    assert.doesNotMatch(accommodation, /data-i18n="showcase\.accommodation\.kicker"/, 'accommodation section should remove the Cazare kicker');
    assert.doesNotMatch(accommodation, /data-i18n="showcase\.accommodation\.body"/, 'accommodation section should remove the intro body');
    assert.match(css, /\.section-heading--center h2\s*{[^}]*white-space:\s*nowrap/s, 'accommodation headline should avoid wrapping when there is space');

    for (const lang of ['ro', 'ru', 'en']) {
      assert.match(translations, new RegExp(`${lang}:\\s*{`), `${lang} translations should exist`);
    }

    for (const key of [
      'hero.title',
      'showcase.spa.title',
      'showcase.restaurant.title',
      'showcase.accommodation.title',
      'conference.title',
      'cookie.text',
    ]) {
      assert.match(translations, new RegExp(`['"]${key}['"]`), `${key} translation should exist`);
    }
  });
});
