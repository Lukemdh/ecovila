# Site Favicon Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current missing favicon setup with a browser-friendly favicon asset set derived from `assets/logo_small.png`, and wire it into every shipped public and admin HTML page.

**Architecture:** Keep `assets/logo_small.png` as the source artwork, generate a minimal set of raster favicon outputs plus a root-level ICO fallback, then expose the same absolute favicon URLs from every shipped HTML entry point. Add a focused Node regression test so future page additions do not silently omit the favicon contract.

**Tech Stack:** Static HTML, PNG/ICO image assets, Node built-in test runner, macOS `sips`, Python standard library

---

## File map

- Create `tests/favicon.test.mjs` — regression coverage for favicon assets and HTML declarations.
- Create `assets/favicon-16x16.png` — small PNG favicon generated from the source logo.
- Create `assets/favicon-32x32.png` — standard PNG favicon generated from the source logo.
- Create `assets/apple-touch-icon.png` — iOS touch icon generated from the source logo.
- Create `favicon.ico` — root-level ICO fallback containing the 16×16 and 32×32 PNG payloads.
- Modify these shipped HTML entry points to declare the favicon links:
  - `index.html`
  - `site.html`
  - `rezervari.html`
  - `checkout.html`
  - `confirmare.html`
  - `anulare.html`
  - `politica-confidentialitate.html`
  - `termeni-conditii.html`
  - `admin/index.html`
  - `admin/dashboard.html`

### Task 1: Add regression coverage for the favicon contract

**Files:**
- Create: `tests/favicon.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shippedPages = [
  'index.html',
  'site.html',
  'rezervari.html',
  'checkout.html',
  'confirmare.html',
  'anulare.html',
  'politica-confidentialitate.html',
  'termeni-conditii.html',
  'admin/index.html',
  'admin/dashboard.html',
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function pngDimensions(relativePath) {
  const buffer = fs.readFileSync(path.join(root, relativePath));
  assert.equal(buffer.toString('ascii', 1, 4), 'PNG', `${relativePath} should be a PNG file`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

describe('site favicon assets', () => {
  it('exports the required favicon files at the expected sizes', () => {
    for (const file of [
      'favicon.ico',
      'assets/favicon-16x16.png',
      'assets/favicon-32x32.png',
      'assets/apple-touch-icon.png',
    ]) {
      assert.ok(exists(file), `${file} should exist`);
    }

    assert.deepEqual(pngDimensions('assets/favicon-16x16.png'), { width: 16, height: 16 });
    assert.deepEqual(pngDimensions('assets/favicon-32x32.png'), { width: 32, height: 32 });
    assert.deepEqual(pngDimensions('assets/apple-touch-icon.png'), { width: 180, height: 180 });
  });

  it('declares the favicon set on every shipped page', () => {
    for (const page of shippedPages) {
      const html = read(page);

      assert.match(
        html,
        /<link rel="icon" type="image\/png" sizes="32x32" href="\/assets\/favicon-32x32\.png">/,
        `${page} should declare the 32x32 favicon`,
      );
      assert.match(
        html,
        /<link rel="icon" type="image\/png" sizes="16x16" href="\/assets\/favicon-16x16\.png">/,
        `${page} should declare the 16x16 favicon`,
      );
      assert.match(
        html,
        /<link rel="apple-touch-icon" sizes="180x180" href="\/assets\/apple-touch-icon\.png">/,
        `${page} should declare the Apple touch icon`,
      );
    }
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `node --test tests/favicon.test.mjs`

Expected: FAIL because the favicon outputs and favicon `<link>` tags do not exist yet.

- [ ] **Step 3: Commit the red test**

```bash
git add tests/favicon.test.mjs
git commit -m "test: cover site favicon assets"
```

### Task 2: Generate the favicon asset set from `logo_small.png`

**Files:**
- Create: `assets/favicon-16x16.png`
- Create: `assets/favicon-32x32.png`
- Create: `assets/apple-touch-icon.png`
- Create: `favicon.ico`

- [ ] **Step 1: Generate the PNG variants**

Run:

```bash
sips -z 16 16 assets/logo_small.png --out assets/favicon-16x16.png
sips -z 32 32 assets/logo_small.png --out assets/favicon-32x32.png
sips -z 180 180 assets/logo_small.png --out assets/apple-touch-icon.png
```

Expected: three PNG outputs are created from the existing square source artwork.

- [ ] **Step 2: Build the root-level ICO fallback from the generated PNGs**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
import struct

entries = [
    (16, Path('assets/favicon-16x16.png').read_bytes()),
    (32, Path('assets/favicon-32x32.png').read_bytes()),
]

offset = 6 + (16 * len(entries))
with open('favicon.ico', 'wb') as file:
    file.write(struct.pack('<HHH', 0, 1, len(entries)))
    for size, payload in entries:
        file.write(struct.pack('<BBBBHHII', size, size, 0, 0, 1, 32, len(payload), offset))
        offset += len(payload)
    for _, payload in entries:
        file.write(payload)
PY
```

Expected: `favicon.ico` exists at the repository root and contains the 16×16 and 32×32 icon payloads.

- [ ] **Step 3: Run the focused favicon test**

Run: `node --test tests/favicon.test.mjs`

Expected: FAIL because the assets now exist, but the HTML pages still do not declare them.

- [ ] **Step 4: Commit the generated favicon assets**

```bash
git add favicon.ico assets/favicon-16x16.png assets/favicon-32x32.png assets/apple-touch-icon.png
git commit -m "feat: add generated favicon assets"
```

### Task 3: Add favicon links to every shipped HTML page

**Files:**
- Modify: `index.html`
- Modify: `site.html`
- Modify: `rezervari.html`
- Modify: `checkout.html`
- Modify: `confirmare.html`
- Modify: `anulare.html`
- Modify: `politica-confidentialitate.html`
- Modify: `termeni-conditii.html`
- Modify: `admin/index.html`
- Modify: `admin/dashboard.html`

- [ ] **Step 1: Add the shared favicon snippet to each page `<head>`**

Insert this exact block after the page description metadata in every shipped HTML page:

```html
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png">
```

- [ ] **Step 2: Run the focused favicon test**

Run: `node --test tests/favicon.test.mjs`

Expected: PASS.

- [ ] **Step 3: Run the full Node test suite**

Run: `node --test tests/*.test.mjs`

Expected: PASS with 0 failing tests.

- [ ] **Step 4: Commit the HTML wiring**

```bash
git add index.html site.html rezervari.html checkout.html confirmare.html anulare.html politica-confidentialitate.html termeni-conditii.html admin/index.html admin/dashboard.html
git commit -m "feat: wire favicon links across site pages"
```

### Task 4: Verify the favicon routes in a browser-facing flow

**Files:**
- No file changes expected.

- [ ] **Step 1: Start a local static server**

Run: `python3 -m http.server 8000`

Expected: local site available at `http://127.0.0.1:8000/`.

- [ ] **Step 2: Open representative pages and confirm the favicon asset URLs resolve**

Check:
- `http://127.0.0.1:8000/`
- `http://127.0.0.1:8000/admin/`
- `http://127.0.0.1:8000/assets/favicon-32x32.png`
- `http://127.0.0.1:8000/favicon.ico`

Expected: both pages load, and both favicon asset URLs return successfully.

- [ ] **Step 3: Stop the local server after verification**

Run: `Ctrl-C` in the server terminal.
