# Analytics (GA4) — how it works

EcoVila uses **Google Analytics 4** (Measurement ID `G-QWJXK651PP`) for traffic
analytics on the public site. See [ADR-043](decisions.md) for the decision record.

## Where it lives

- **ID / config:** [`js/tracking-config.js`](../js/tracking-config.js) →
  `EcoVilaTrackingConfig.googleMeasurementId`. Change the GA4 property by editing this
  one value (then re-run `npm run prepare:tophost` and re-upload).
- **Loader / logic:** [`js/tracking.js`](../js/tracking.js) (`EcoVilaTracking`). It
  injects `https://www.googletagmanager.com/gtag/js?id=<id>` on demand and fires events.

## Which pages are tracked

GA4 runs on **every public page** because all of them load `tracking-config.js` +
`tracking.js`: `index.html`, `site.html`, `rezervari.html`, `checkout.html`,
`confirmare.html`, `gestionare.html`, `anulare.html`, `intrebari-frecvente.html`,
`politica-confidentialitate.html`, `termeni-conditii.html`, plus `ru/index.html` and
`en/index.html`.

The **admin CRM** (`admin/index.html`, `admin/dashboard.html`) is **not** tracked — those
pages do not load the tracking scripts. No exclusion rule is needed; it is excluded by
construction. (Keep it that way: do not add the tracking scripts to admin pages.)

## Consent gating (important)

The cookie banner has two independent toggles: **analytics** and **marketing**. GA4 is an
analytics product, so it follows the **analytics** toggle:

| Visitor choice            | GA4 (`gtag`) loads? | Meta Pixel / Ads / server CAPI? |
| ------------------------- | ------------------- | ------------------------------- |
| Reject all                | No                  | No                              |
| Analytics only            | **Yes**             | No                              |
| Marketing only            | No                  | Yes                             |
| Accept all                | **Yes**             | Yes                             |

Nothing loads until the visitor makes a choice (privacy by default — stricter than
Consent Mode "default denied"). When GA4 does load, it also sends granular **Google
Consent Mode** signals: `analytics_storage` from the analytics toggle, and
`ad_storage` / `ad_user_data` / `ad_personalization` from the marketing toggle.

`page_view` is sent automatically on load and on every consent change (deduplicated per
URL). Ecommerce events `begin_checkout` and `purchase` are sent from the booking flow;
the Google **Ads** `conversion` event (only when `googleAdsConversionId` is configured)
stays gated on marketing consent.

## Verifying

1. Open a public page, accept analytics cookies.
2. Network tab should show `gtag/js?id=G-QWJXK651PP` (200) and a
   `google-analytics.com/g/collect?…&en=page_view` beacon (204).
3. The GA4 property's **Realtime** report should show the visit within ~30s.
