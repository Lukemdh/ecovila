# Site Favicon Refresh Design

## Goal
Replace the site favicon experience with a browser-friendly favicon set derived from the existing `assets/logo_small.png` artwork, and expose it consistently across all shipped public and admin HTML entry points.

## Scope
### In scope
- Use `assets/logo_small.png` as the sole source artwork.
- Generate the following favicon assets:
  - `/favicon.ico`
  - `/assets/favicon-16x16.png`
  - `/assets/favicon-32x32.png`
  - `/assets/apple-touch-icon.png`
- Add favicon declarations to every shipped HTML page:
  - root pages: `index.html`, `site.html`, `rezervari.html`, `checkout.html`, `confirmare.html`, `anulare.html`, `politica-confidentialitate.html`, `termeni-conditii.html`
  - admin pages: `admin/index.html`, `admin/dashboard.html`

### Out of scope
- Creating a web app manifest or PWA metadata.
- Reworking the logo artwork itself.
- Editing `.superpowers/brainstorm/**` HTML artifacts, which are not shipped site entry points.

## Approach
1. Keep `assets/logo_small.png` as the canonical artwork source.
2. Export a compact favicon set sized for common browser and device needs:
   - 16×16 PNG for small browser chrome
   - 32×32 PNG for standard high-density browser usage
   - 180×180 PNG for Apple touch icons
   - multi-size ICO fallback at the site root
3. Add explicit `<link>` tags in the `<head>` of each shipped HTML page so favicon behavior is deterministic across root and nested routes.

## HTML contract
Each shipped page should declare:

```html
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png">
```

Pages under `/admin` may still use the same absolute asset paths so they resolve consistently regardless of nesting.

## Why this design
- It improves browser compatibility over linking the large source PNG directly.
- It keeps the change small and maintainable by deriving everything from one existing logo asset.
- It gives nested admin routes the same favicon behavior as public pages without introducing page-specific differences.
- It avoids adding a manifest until the site has a real PWA requirement.

## Verification
- Confirm generated assets exist at the expected paths and dimensions.
- Confirm every shipped HTML entry point contains the favicon declarations.
- Open representative root and admin pages and verify the favicon requests resolve successfully.
