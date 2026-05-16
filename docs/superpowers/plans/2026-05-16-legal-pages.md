# EcoVila Legal Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the skipped Step 8 privacy-policy and terms-and-conditions pages as polished static public pages using the supplied Romanian legal text.

**Architecture:** Keep the site fully static. Add one focused legal stylesheet, two root-level HTML pages that reuse the existing public shell, and a focused Node contract test that verifies content, shell wiring, and Romanian-only article behavior.

**Tech Stack:** HTML, CSS, vanilla JavaScript already present in the public shell, Node built-in test runner.

---

## File Structure

- `docs/tests/legal-pages.test.mjs`: focused structural contract for both legal pages, shared shell requirements, article content, and footer/checkout link targets.
- `css/legal.css`: long-form reading layout and legal-page header treatment only.
- `politica-confidentialitate.html`: static Romanian privacy-policy page.
- `termeni-conditii.html`: static Romanian terms-and-conditions page.

## Task 1: Legal Pages Contract Test

**Files:**
- Create: `docs/tests/legal-pages.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `docs/tests/legal-pages.test.mjs`:

```js
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
      'index.html',
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test docs/tests/legal-pages.test.mjs
```

Expected: FAIL because the legal HTML pages and `css/legal.css` do not exist yet.

- [ ] **Step 3: Commit the failing test**

```bash
git add docs/tests/legal-pages.test.mjs
git commit -m "test: add legal pages contract"
```

## Task 2: Legal Reading Styles

**Files:**
- Create: `css/legal.css`
- Test: `docs/tests/legal-pages.test.mjs`

- [ ] **Step 1: Write the minimal stylesheet**

Create `css/legal.css`:

```css
/* EcoVila legal pages — long-form reading layout */

.site-header {
  color: var(--ink);
  background: rgba(247, 244, 239, 0.94);
  box-shadow: 0 18px 45px rgba(51, 38, 31, 0.12);
  backdrop-filter: blur(18px);
}

.legal-page {
  min-height: 100svh;
  padding: 118px 0 88px;
  background:
    linear-gradient(180deg, rgba(51, 38, 31, 0.07), transparent 420px),
    var(--paper);
}

.legal-shell {
  width: min(960px, calc(100vw - 64px));
  margin: 0 auto;
}

.legal-hero {
  margin-bottom: 34px;
}

.legal-kicker {
  margin: 0 0 12px;
  color: var(--cocoa);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.legal-hero h1 {
  margin: 0 0 16px;
  color: var(--ink);
  font-family: var(--heading-font);
  font-size: clamp(3rem, 5vw, 5rem);
  font-weight: 500;
  line-height: 0.96;
}

.legal-hero p {
  max-width: 680px;
  margin: 0;
  color: var(--muted);
  font-size: clamp(1rem, 1.3vw, 1.12rem);
  line-height: 1.85;
}

.legal-article {
  max-width: 760px;
  padding: clamp(24px, 4vw, 44px);
  background: var(--white);
  border: 1px solid rgba(51, 47, 44, 0.12);
  box-shadow: 0 20px 60px rgba(51, 38, 31, 0.07);
}

.legal-language-note {
  margin: 0 0 30px;
  padding: 14px 16px;
  color: var(--muted);
  background: rgba(247, 244, 239, 0.8);
  border-left: 3px solid var(--cocoa);
  font-size: 0.88rem;
}

.legal-article h2 {
  margin: 42px 0 14px;
  color: var(--ink);
  font-family: var(--heading-font);
  font-size: clamp(1.9rem, 3vw, 2.6rem);
  font-weight: 500;
  line-height: 1.08;
}

.legal-article h2:first-of-type {
  margin-top: 0;
}

.legal-article p,
.legal-article li {
  color: var(--ink);
  font-size: 0.97rem;
  line-height: 1.85;
}

.legal-article p {
  margin: 0 0 18px;
}

.legal-article ul {
  display: grid;
  gap: 8px;
  margin: 0 0 22px;
  padding-left: 22px;
}

.legal-article a {
  text-underline-offset: 3px;
}

@media (max-width: 720px) {
  .legal-page {
    padding: 102px 0 64px;
  }

  .legal-shell {
    width: min(100% - 32px, 960px);
  }

  .legal-hero {
    margin-bottom: 24px;
  }

  .legal-article h2 {
    margin-top: 34px;
  }
}
```

- [ ] **Step 2: Run the contract test**

Run:

```bash
node --test docs/tests/legal-pages.test.mjs
```

Expected: FAIL only because the two HTML pages are still missing.

- [ ] **Step 3: Commit the stylesheet**

```bash
git add css/legal.css
git commit -m "style: add legal page reading layout"
```

## Task 3: Static Legal HTML Pages

**Files:**
- Create: `politica-confidentialitate.html`
- Create: `termeni-conditii.html`
- Read: `docs/politica-confidentialitate.md`
- Read: `docs/termeni-conditii.md`
- Test: `docs/tests/legal-pages.test.mjs`

- [ ] **Step 1: Generate explicit static HTML from the supplied markdown**

Run this one-off command from the repository root. It reads the approved markdown files, converts headings/paragraphs/lists into semantic HTML, and writes two static HTML files. The generator is not committed; only the final HTML output is kept.

```bash
python3 - <<'PY'
from html import escape
from pathlib import Path

ROOT = Path('.')
PAGES = {
    'docs/politica-confidentialitate.md': {
        'output': 'politica-confidentialitate.html',
        'title': 'Politică de confidențialitate',
        'document_title': 'EcoVila | Politică de confidențialitate',
        'description': 'Politica de confidențialitate EcoVila pentru rezervări, notificări și date personale.',
        'kicker': 'Date personale',
        'intro': 'Informațiile privind modul în care EcoVila colectează, folosește și protejează datele personale.',
    },
    'docs/termeni-conditii.md': {
        'output': 'termeni-conditii.html',
        'title': 'Termeni și condiții',
        'document_title': 'EcoVila | Termeni și condiții',
        'description': 'Termenii și condițiile EcoVila pentru rezervări, plăți, acces și reguli interne.',
        'kicker': 'Reguli de rezervare',
        'intro': 'Condițiile aplicabile rezervărilor, plăților și utilizării serviciilor EcoVila.',
    },
}

def inline(text: str) -> str:
    return escape(text)

def markdown_to_html(markdown: str) -> str:
    lines = markdown.splitlines()
    html = []
    paragraph = []
    in_list = False

    def flush_paragraph():
        nonlocal paragraph
        if paragraph:
            html.append(f'      <p>{inline(" ".join(paragraph))}</p>')
            paragraph = []

    def close_list():
        nonlocal in_list
        if in_list:
            html.append('      </ul>')
            in_list = False

    for raw in lines:
        line = raw.strip()
        if not line:
            flush_paragraph()
            close_list()
            continue
        if line.startswith('# '):
            continue
        if line.startswith('## '):
            flush_paragraph()
            close_list()
            html.append(f'      <h2>{inline(line[3:])}</h2>')
            continue
        if line.startswith('- '):
            flush_paragraph()
            if not in_list:
                html.append('      <ul>')
                in_list = True
            html.append(f'        <li>{inline(line[2:])}</li>')
            continue
        close_list()
        paragraph.append(line)

    flush_paragraph()
    close_list()
    return '\n'.join(html)

def shell(meta: dict, article_html: str) -> str:
    return f'''<!doctype html>
<html lang="ro">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{meta["document_title"]}</title>
    <meta name="description" content="{meta["description"]}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link
      href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Montserrat:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    >
    <link rel="stylesheet" href="css/main.css">
    <link rel="stylesheet" href="css/legal.css">
  </head>
  <body>
    <a class="skip-link" href="#legal-page" data-i18n="access.skip">Sari la conținut</a>

    <header class="site-header" data-header>
      <a class="brand" href="index.html#top" aria-label="EcoVila">
        <img src="/assets/logo.png" alt="EcoVila" class="brand__mark">
      </a>
      <div class="header-actions">
        <div class="language-dropdown header-bar-control">
          <label class="visually-hidden" for="language-select">Language</label>
          <select class="language-select" id="language-select" data-lang-select aria-label="Language">
            <option value="ro">RO</option>
            <option value="ru">RU</option>
            <option value="en">EN</option>
          </select>
        </div>
        <a class="menu-link header-bar-control" href="rezervari.html" data-i18n="nav.cta">Rezervă</a>
      </div>
    </header>

    <main class="legal-page" id="legal-page">
      <div class="legal-shell">
        <header class="legal-hero">
          <p class="legal-kicker">{meta["kicker"]}</p>
          <h1>{meta["title"]}</h1>
          <p>{meta["intro"]}</p>
        </header>
        <article class="legal-article">
          <p class="legal-language-note">Textul juridic este afișat în limba română.</p>
{article_html}
        </article>
      </div>
    </main>

    <footer class="site-footer" id="footer">
      <div class="section-inner site-footer__grid">
        <div class="site-footer__brand">
          <img src="/assets/logoNT.png" alt="EcoVila" class="site-footer__logo">
          <p data-i18n="footer.tagline">Complex all-inclusive în Orheiul Vechi, Moldova.</p>
        </div>
        <dl class="site-footer__legal">
          <div>
            <dt data-i18n="footer.phoneLabel">Telefon</dt>
            <dd>+37360120220</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd><a href="mailto:rezervari@ecovila.md">rezervari@ecovila.md</a></dd>
          </div>
        </dl>
        <div class="site-footer__social">
          <h2 data-i18n="footer.followUs">Urmăriți-ne</h2>
          <a href="https://www.facebook.com/p/Eco-Vila-100069882319416" target="_blank" rel="noopener">Facebook</a>
          <a href="https://www.instagram.com/ecovila_1/?hl=ro" target="_blank" rel="noopener">Instagram</a>
          <a href="https://www.tiktok.com/@ecovila8" target="_blank" rel="noopener">TikTok</a>
        </div>
        <div class="site-footer__links">
          <h2 data-i18n="footer.useful">Utile</h2>
          <a href="politica-confidentialitate.html" data-i18n="footer.privacy">Politica de Confidențialitate</a>
          <a href="termeni-conditii.html" data-i18n="footer.terms">Termeni și Condiții</a>
          <span data-i18n="footer.copy">© 2026 EcoVila</span>
        </div>
      </div>
    </footer>

    <div class="cookie-banner" id="cookie-banner" hidden>
      <p data-i18n="cookie.text">
        Folosim cookie-uri esențiale pentru funcționarea site-ului. Nu pornim cookie-uri de analiză fără acord.
      </p>
      <div class="cookie-banner__actions">
        <button class="editorial-button" type="button" data-cookie-choice="essential" data-i18n="cookie.refuse">
          Accept doar esențiale
        </button>
        <button class="editorial-button editorial-button--filled" type="button" data-cookie-choice="accepted" data-i18n="cookie.accept">
          Accept
        </button>
      </div>
    </div>

    <script src="js/translations.js"></script>
    <script src="js/main.js"></script>
  </body>
</html>
'''

for source, meta in PAGES.items():
    markdown = (ROOT / source).read_text()
    body = markdown_to_html(markdown)
    (ROOT / meta['output']).write_text(shell(meta, body))
PY
```

- [ ] **Step 2: Run the contract test to verify it passes**

Run:

```bash
node --test docs/tests/legal-pages.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Commit the legal pages**

```bash
git add politica-confidentialitate.html termeni-conditii.html
git commit -m "feat: add public legal pages"
```

## Task 4: Browser Verification

**Files:**
- Read: `politica-confidentialitate.html`
- Read: `termeni-conditii.html`
- Read: `css/legal.css`

- [ ] **Step 1: Run the focused legal-page test again**

```bash
node --test docs/tests/legal-pages.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Start a local static server**

```bash
python3 -m http.server 4173
```

Expected: local server available at `http://localhost:4173`.

- [ ] **Step 3: Open and inspect both pages in the browser**

Visit:

- `http://localhost:4173/politica-confidentialitate.html`
- `http://localhost:4173/termeni-conditii.html`

Confirm:

- the fixed header is readable immediately on the light page
- article width is comfortable on desktop
- the mobile layout has no horizontal scrolling
- language switching changes shared chrome while leaving article text Romanian
- footer links and cookie banner render correctly

- [ ] **Step 4: Run the broader relevant test subset**

```bash
node --test docs/tests/legal-pages.test.mjs docs/tests/checkout.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit any final verification fixes**

```bash
git add css/legal.css politica-confidentialitate.html termeni-conditii.html docs/tests/legal-pages.test.mjs
git commit -m "test: verify legal pages integration"
```

