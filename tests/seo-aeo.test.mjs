import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const origin = 'https://ecovila.md';

const localizedHomePages = [
  {
    file: 'index.html',
    lang: 'ro',
    canonical: `${origin}/`,
    title: /EcoVila.+Orheiul Vechi/i,
    staticText: /Un refugiu all-inclusive în inima pădurii/i,
  },
  {
    file: 'ru/index.html',
    lang: 'ru',
    canonical: `${origin}/ru/`,
    title: /EcoVila.+Орхеюл Векь/i,
    staticText: /All-inclusive отдых в сердце леса/i,
  },
  {
    file: 'en/index.html',
    lang: 'en',
    canonical: `${origin}/en/`,
    title: /EcoVila.+Orheiul Vechi/i,
    staticText: /all-inclusive refuge in the heart of Moldova’s forest/i,
  },
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function head(html) {
  const match = html.match(/<head[\s\S]*?<\/head>/i);
  return match ? match[0] : '';
}

describe('EcoVila SEO/AEO ranking protection foundation', () => {
  it('replaces the root maintenance page with the full Romanian landing page', () => {
    const html = read('index.html');

    assert.doesNotMatch(html, /În curând|Site-ul EcoVila este în curs de îmbunătățire/i);
    assert.match(html, /<main\b/i, 'root should serve full HTML content');
    assert.match(html, /Un refugiu all-inclusive în inima pădurii/i);
    assert.match(html, /Orheiul Vechi/i);
    assert.doesNotMatch(html, /class="legacy-content/i, 'old content inventory should not be shown as public sections');
    assert.doesNotMatch(html, /Ofertă 2026|Prețuri, cazare|1550 lei|1800 lei|Copiii 3-11/i);
    assert.doesNotMatch(html, /Accesul pe teritoriu cu bucate și băuturi este strict interzis/i);
  });

  it('serves distinct static localized home URLs with self canonicals and reciprocal hreflang', () => {
    for (const page of localizedHomePages) {
      assert.ok(exists(page.file), `${page.file} should exist`);
      const html = read(page.file);
      const headHtml = head(html);

      assert.match(html, new RegExp(`<html[^>]+lang="${page.lang}"`, 'i'));
      assert.match(headHtml, page.title, `${page.file} should have a localized title`);
      assert.match(headHtml, new RegExp(`<link rel="canonical" href="${page.canonical.replaceAll('/', '\\/')}"`, 'i'));
      assert.match(headHtml, /<meta property="og:title"/i);
      assert.match(headHtml, /<meta property="og:description"/i);
      assert.match(headHtml, /<meta property="og:image"/i);
      assert.match(headHtml, /<meta name="twitter:card" content="summary_large_image"/i);
      assert.match(html, page.staticText, `${page.file} should contain localized body copy in served HTML`);
      assert.doesNotMatch(html, /data-lang-select/i, `${page.file} should navigate languages, not mutate one URL`);
      assert.doesNotMatch(html, /class="language-switcher/i, `${page.file} should not use the link-list language control`);
      assert.match(html, /class="language-dropdown header-bar-control"/i);
      assert.match(html, /class="language-select"/i);
      assert.match(html, /data-static-lang-select/i);
      assert.match(html, /<option value="\/"[^>]*>RO<\/option>/i);
      assert.match(html, /<option value="\/ru\/"[^>]*>RU<\/option>/i);
      assert.match(html, /<option value="\/en\/"[^>]*>EN<\/option>/i);
      assert.doesNotMatch(html, /class="legacy-content/i, `${page.file} should not expose the old pricing/info sections`);
      assert.doesNotMatch(html, /1550\s*(?:lei|MDL)|1800\s*(?:lei|MDL)|Copiii 3-11|Children 3-11|Дети 3-11/i);

      for (const [hreflang, href] of [
        ['ro', `${origin}/`],
        ['ru', `${origin}/ru/`],
        ['en', `${origin}/en/`],
        ['x-default', `${origin}/`],
      ]) {
        assert.match(
          headHtml,
          new RegExp(`<link rel="alternate" hreflang="${hreflang}" href="${href.replaceAll('/', '\\/')}"`, 'i'),
          `${page.file} should include ${hreflang} hreflang`,
        );
      }
    }

    assert.equal(exists('ro/index.html'), false, 'Romanian should not be duplicated at /ro/');
  });

  it('publishes crawler, sitemap, and AI summary files for the approved language cluster', () => {
    const robots = read('robots.txt');
    const sitemap = read('sitemap.xml');
    const llms = read('llms.txt');

    for (const crawler of [
      'Googlebot',
      'Bingbot',
      'YandexBot',
      'GPTBot',
      'OAI-SearchBot',
      'ChatGPT-User',
      'ClaudeBot',
      'Claude-User',
      'Claude-SearchBot',
      'PerplexityBot',
      'Perplexity-User',
      'Google-Extended',
      'Applebot',
      'Amazonbot',
      'CCBot',
    ]) {
      assert.match(robots, new RegExp(`User-agent:\\s*${crawler}[\\s\\S]*?Allow:\\s*/`, 'i'));
    }

    assert.match(robots, /Sitemap:\s*https:\/\/ecovila\.md\/sitemap\.xml/i);
    assert.match(llms, /EcoVila is an all-inclusive villa complex near Orheiul Vechi/i);
    assert.match(llms, /Languages:\s*Romanian, Russian, English/i);

    for (const href of [`${origin}/`, `${origin}/ru/`, `${origin}/en/`]) {
      assert.match(sitemap, new RegExp(`<loc>${href.replaceAll('/', '\\/')}<\\/loc>`, 'i'));
    }

    assert.match(sitemap, /xhtml:link rel="alternate" hreflang="ro" href="https:\/\/ecovila\.md\/"/i);
    assert.match(sitemap, /xhtml:link rel="alternate" hreflang="ru" href="https:\/\/ecovila\.md\/ru\/"/i);
    assert.match(sitemap, /xhtml:link rel="alternate" hreflang="en" href="https:\/\/ecovila\.md\/en\/"/i);
    assert.match(sitemap, /xhtml:link rel="alternate" hreflang="x-default" href="https:\/\/ecovila\.md\/"/i);
  });

  it('defines the approved legacy 301 map including query-string PHP pages', () => {
    const htaccess = read('.htaccess');

    assert.match(htaccess, /^RewriteRule \^index\\\.php\$ \/ \[R=301,L\]$/m);
    assert.match(htaccess, /^RewriteRule \^home\\\.php\$ \/ \[R=301,L\]$/m);
    assert.match(htaccess, /^RewriteRule \^site\\\.html\$ \/ \[R=301,L\]$/m);
    assert.match(htaccess, /^RewriteCond %\{QUERY_STRING\} \(\^\|&\)id=3\(&\|\$\)$/m);
    assert.match(htaccess, /^RewriteRule \^continut\\\.php\$ \/rezervari\.html \[R=301,L,QSD\]$/m);
    assert.match(htaccess, /^RewriteCond %\{QUERY_STRING\} \(\^\|&\)id=18\(&\|\$\)$/m);
    assert.match(htaccess, /^RewriteRule \^continut\\\.php\$ \/#restaurant \[R=301,L,NE,QSD\]$/m);
    assert.match(htaccess, /^RewriteCond %\{QUERY_STRING\} \(\^\|&\)id=5\(&\|\$\)$/m);
    assert.match(htaccess, /^RewriteRule \^continut\\\.php\$ \/#despre \[R=301,L,NE,QSD\]$/m);
    assert.match(htaccess, /^RewriteCond %\{QUERY_STRING\} \(\^\|&\)id=6\(&\|\$\)$/m);
    assert.match(htaccess, /^RewriteRule \^continut\\\.php\$ \/#contact \[R=301,L,NE,QSD\]$/m);
    assert.match(htaccess, /^RewriteCond %\{QUERY_STRING\} \(\^\|&\)id=\(20\|21\)\(&\|\$\)$/m);
    assert.match(htaccess, /^RewriteRule \^continut\\\.php\$ \/#accommodation \[R=301,L,NE,QSD\]$/m);
    assert.doesNotMatch(htaccess, /RewriteRule\s+\^\$\s+\/ro\//i, 'root must not redirect to /ro/');
  });

  it('keeps every approved 301 target backed by a shipped page or root anchor', () => {
    const html = read('index.html');

    for (const anchor of ['restaurant', 'despre', 'contact', 'accommodation']) {
      assert.match(html, new RegExp(`id="${anchor}"`, 'i'), `/#${anchor} should resolve on the Romanian root`);
    }

    for (const page of ['index.html', 'rezervari.html', 'admin/index.html']) {
      assert.ok(exists(page), `/${page.replace(/index\\.html$/, '')} should exist for redirect targets`);
    }
  });
});
