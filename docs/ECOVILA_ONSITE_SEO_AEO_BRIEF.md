# EcoVila — On-Site SEO / AEO + Conversion Tracking Implementation Brief

**Audience:** Claude Code
**Project:** `ecovila.md` public website (booking platform for a premium all-inclusive villa complex in the Orheiul Vechi area, Moldova)
**Companion document:** a separate market recon (keyword targets, listicle/directory outreach list, competitor gap analysis) will populate the sections marked `⏳ PENDING RECON`. Do not invent these — leave them as TODO placeholders.

---

## 0. Read this first — context and intent

EcoVila is a 25-room all-inclusive villa complex near Orheiul Vechi (villages of Trebujeni / Butuceni, ~50 km from Chișinău). Room inventory: 8 small villas (*căsuță mică*), 7 large villas (*căsuță mare*), 10 hotel rooms (*cameră în hotel*), plus a staff-bookable conference room.

**The site was just rebuilt.** The previous site was a single-page PHP page at the same domain (`ecovila.md`) that ranked well for the usual lodging keywords and produced ~20% of bookings organically. The rest came from Meta ads. The new site is multi-page and on the same domain. Because the domain and root URL are preserved, there is no redirect catastrophe — but **rankings attach to content + URL, not URL alone**, so preserving the old page's ranking content is a first-order task (see §1).

**Strategic goal of this work, in priority order:**
1. **Do not lose existing organic rankings** during the rebuild cutover.
2. **Install conversion measurement** (Meta Pixel + Conversions API; Google Ads conversions) — the business has *never* had a Pixel, so paid spend has run with zero conversion signal. Measurement is the precondition for cutting wasted spend.
3. **Build the on-site foundation for organic + AI-answer visibility** so the business can reduce paid dependence over time.
4. **Support off-season occupancy** (the property is ~100% full June–August and on holiday/school-break spikes, but only ~50–60% the rest of the year) via package/bundle content — *not* via seasonal pricing, which is deliberately out of scope.

**Architecture constraints (do not violate):**
- Frontend: vanilla HTML / CSS / JS. No frameworks.
- Hosting: `tophost.md`, shared cPanel, **static files only, no Node.js**.
- Backend: Supabase (Postgres, Auth, Realtime).
- All server-side logic: **Supabase Edge Functions (Deno/TypeScript)**.
- SMS: SMS.md · Email: Resend · Card payments: Maib ePay (redirect) — all called from Edge Functions.
- **All secrets (API keys, access tokens) live server-side in Edge Functions as env vars. Never in browser code.**
- Languages: Romanian (default), Russian, English.
- Compliance: Legea 133/2011, Legea 105/2003, and **Legea 195/2024** (Moldova's GDPR-equivalent, in force **23 August 2026**). The site already has a cookie consent banner, privacy policy, and a GDPR checkbox on the booking form.

---

## 1. Protect existing rankings — DO THIS PHASE FIRST, before any other change

1. **Recover and preserve the old page's ranking content.** The single PHP page contained the text that earned the rankings. Retrieve it (ask the user for the source, or pull from the Wayback Machine: `web.archive.org/web/*/ecovila.md`). Inventory the headings, body copy, and any keyword-bearing phrases. Ensure that content survives on the new site — consolidated on the homepage and/or distributed to the relevant new pages. **Do not let the rebuild silently drop the copy that ranked.**
2. **301-redirect any legacy URLs.** If the old entry point was `ecovila.md/index.php` (or similar), 301 it to `ecovila.md/`. Map any other old paths to their closest new equivalent. Configure via `.htaccess` on tophost (Apache).
3. **Google Search Console.** Verify ownership of `ecovila.md` (DNS TXT or HTML file). Submit the XML sitemap. **Capture a baseline of current rankings/impressions before the public cutover** so any post-launch movement is visible.
4. **Guard indexability.** Confirm no stray `noindex`, no `Disallow: /` in robots.txt, no canonical pointing away from the live pages. All primary content must be present in the served HTML (static vanilla HTML already satisfies this — keep it that way; do not move primary content behind client-side rendering).

---

## 2. Technical SEO foundation

### 2.1 Multilingual URLs — REQUIRED CHANGE
If the current i18n approach swaps text via a JS translation object on a **single URL** with `localStorage`, this must change. Search and answer engines need a **distinct, crawlable URL per language**. Implement language subdirectories: `/ro/`, `/ru/`, `/en/` (Romanian default may also live at root — pick one canonical pattern and be consistent). Each page must:
- Serve fully-rendered localized content in the static HTML for that URL (not switched client-side).
- Include reciprocal `hreflang` tags for `ro`, `ru`, `en`, plus `x-default`.
- Have its own localized `<title>`, meta description, Open Graph tags, and canonical.

A JS-only language switcher may remain as a UX convenience, but it must navigate between the real per-language URLs, not mutate text on one URL.

### 2.2 Crawlability
- **robots.txt:** allow standard crawlers and explicitly do **not** block AI crawlers. Allow at minimum: `Googlebot`, `Bingbot`, `YandexBot` (relevant for the RU market), `GPTBot`, `OAI-SearchBot`, `ChatGPT-User`, `ClaudeBot`, `Claude-User`, `Claude-SearchBot`, `PerplexityBot`, `Perplexity-User`, `Google-Extended`, `Applebot`, `Amazonbot`, `CCBot` (Common Crawl — feeds LLM training data). Reference the sitemap.
- **XML sitemap** with `hreflang` annotations for every page in all three languages. Auto-generate or maintain a static `sitemap.xml`.
- **`llms.txt`** at the root: a concise, structured summary of the site (what EcoVila is, key pages, contact, languages) to help AI systems understand the site.

### 2.3 Page-level
- One `<h1>` per page; logical `h2`/`h3` hierarchy, one topic per section.
- Clean, descriptive, lowercase URLs.
- Per-page, per-language `<title>` (≤~60 chars) and meta description (≤~155 chars).
- **Open Graph + Twitter Card tags on every page**, per language (`og:locale` set correctly). This is high priority: the business drives heavy Facebook traffic, and OG tags control how shared/ad links render. Include `og:title`, `og:description`, `og:image` (high-quality, correctly-sized), `og:url`, `og:type`, `og:locale`.
- Semantic HTML5 (`<header>`, `<nav>`, `<main>`, `<article>`, `<footer>`).

### 2.4 Performance / Core Web Vitals (villa sites are image-heavy)
- Serve images as WebP/AVIF with responsive `srcset`/`sizes` and explicit `width`/`height` (prevents layout shift).
- Lazy-load below-the-fold imagery; preload the LCP hero image.
- Defer non-critical JS; inline critical CSS where it helps.
- Target good LCP / CLS / INP. Verify with PageSpeed Insights after build.

---

## 3. Structured data (schema.org, JSON-LD)

Add JSON-LD to the relevant pages:
- **`LodgingBusiness`** (or `Resort`) for the property: legal name, address, `geo` coordinates, `telephone`, `email`, `priceRange`, `currenciesAccepted: "MDL"`, `paymentAccepted` (card via Maib, cash), `availableLanguage` (ro, ru, en), `checkinTime`/`checkoutTime`, `petsAllowed: false`, `amenityFeature` list, `image` gallery, `sameAs` (Facebook/Instagram/Google Business Profile URLs).
- **`HotelRoom`** entries for each of the three accommodation types, with occupancy and bed details.
- **`FAQPage`** on pages carrying FAQ blocks (see §4).
- **`BreadcrumbList`** for navigation.
- **`Organization`** with consistent NAP (name/address/phone) matching the Google Business Profile exactly.
- **`AggregateRating` / `Review`** — only once real reviews exist. The platform's on-site complaint/review capture can feed this later; leave the markup ready but do not fabricate ratings.
- Reference nearby `TouristAttraction` entities (Orheiul Vechi monastery, the cetate, Butuceni ethnographic museum, Răut river) where natural, to reinforce the destination relationship.

NAP must be byte-identical everywhere (site footer, schema, Google Business Profile).

---

## 4. AEO / GEO on-page content

Answer engines extract and cite content that is well-structured, authoritative, and directly answers questions. Implement:

- **Direct-answer-first structure:** each section opens with a one-sentence direct answer, then context. Definition-style lead sentences ("EcoVila is a …").
- **FAQ blocks** (with `FAQPage` schema), in all three languages, answering the real questions guests ask:
  - How far is EcoVila from the Orheiul Vechi monastery / cetate?
  - How do I get there from Chișinău? (≈50 km; driving directions)
  - What does "all-inclusive" include?
  - Are pets allowed? (No — state the no-pets policy plainly)
  - Check-in / check-out times.
  - What languages are spoken?
  - Payment methods (card via Maib ePay, cash).
  - Rules for children (adult = 13+, child = 12 and under).
  - Parking, Wi-Fi, conference room availability.
  - Cancellation policy (the 72-hour rule).
- **Destination-anchored content:** Orheiul Vechi has ~100× the search demand of the brand name. Build a substantive "staying near Orheiul Vechi" page that positions EcoVila as the place to stay, with distances/times to the key landmarks. Ride the destination's demand.
- **Entity clarity & consistency:** exact business name, address, phone, and the cluster of associated topics (Orheiul Vechi, Trebujeni/Butuceni, ecotourism, all-inclusive villa) repeated consistently across pages and matching off-site profiles.
- Scannable formatting; use tables for amenities and the like.

---

## 5. Off-season demand support (content hooks, not pricing)

Seasonal price changes are out of scope by business decision. Support off-season occupancy through **package/value content** instead:
- Dedicated, indexable landing pages for packages: mid-week stays, multi-night stays, holiday/school-break packages, and a corporate/conference package (leveraging the conference room — a strong off-season B2B angle).
- These pages double as SEO targets and as the off-season occupancy lever. Each gets its own per-language URL, schema, and OG tags.

---

## 6. Meta Pixel + Conversions API (consent-gated; Supabase Edge Functions)

**Goal:** give Meta a clean, accurate, unblockable conversion signal so campaigns can be switched to conversion/sales optimization. The anchor event is a **server-side `Purchase`** fired on confirmed booking.

### 6.1 Browser Pixel
- Install the Meta Pixel base code, **gated behind marketing consent** from the existing cookie banner. Pixel does not fire until consent is granted.
- Generate a unique **`event_id`** client-side for each conversion event and reuse it on the matching server event for deduplication.
- Capture `fbp` (Pixel cookie) and `fbc` (from the `fbclid` URL parameter) for match quality.

### 6.2 Conversions API (server-side)
- New Supabase Edge Function (e.g. `meta-capi`) that sends server-side events to Meta. The **Pixel ID and CAPI access token are env vars, never exposed client-side.**
- **Deduplicate** every server event against its browser counterpart using the shared `event_id` + Pixel ID.
- **Advanced matching:** SHA-256 hash the guest's email and phone **server-side** before sending. Lawful basis: performance of the booking contract (the guest provided this data to make the reservation), distinct from cookie-based tracking. Never log raw PII; never put PII in URLs.

### 6.3 Event map
| Event | Where it fires | Notes |
|---|---|---|
| `PageView` | Browser | All pages, post-consent |
| `ViewContent` | Browser | On a room/villa detail view |
| `Search` | Browser | On an availability/date search |
| `InitiateCheckout` | Browser + CAPI | Booking form started |
| `AddPaymentInfo` | Browser | Card path |
| **`Purchase`** | **CAPI (server) + browser, deduped** | **Fired from the payment-confirmation Edge Function** — Maib ePay callback for card, booking-confirmed handler for cash. Include `value` and `currency: "MDL"`. This is the event Meta optimizes against; it must be accurate and must fire even if the guest closed the tab. |
| `Lead` | Browser/CAPI | Optional — conference-room inquiry |

### 6.4 Verification
- Use Meta's Test Events tool to confirm browser+server dedup is working (no double-counting) and match quality is acceptable.

---

## 7. Google Ads conversion tracking (one source of truth)

- Install `gtag.js` with the Google Ads conversion tag, **gated behind the same marketing consent**.
- Enable **Enhanced Conversions** (hashed first-party data) for the booking conversion.
- **Server-side conversion import** from the *same* payment-confirmation Edge Function that fires Meta's `Purchase` (via Google Ads offline conversion import / Measurement Protocol), so Google and Meta optimize on one consistent, accurate conversion source rather than two leaky client-side tags.
- **Campaign structure is operational (Google Ads UI), not code** — included here only so tracking is built to support it: a cheap brand-defense campaign on "ecovila"; a tight phrase/exact generic campaign on destination lodging terms; geo = Moldova + Romania; languages RO + RU; landing on the relevant booking page, never the homepage. Avoid Performance Max at this volume.

---

## 8. Consent & compliance integration

- A **single consent state** (from the cookie banner) drives Pixel, CAPI, and gtag together. Categories: necessary / analytics / marketing.
- No marketing/analytics tags fire before consent; implement a Consent Mode-style gate.
- Align with **Legea 195/2024** (in force 23 Aug 2026): linked privacy policy, clear cookie consent, no tracking without lawful basis. Server-side advanced matching relies on the booking-contract basis and the consent record.
- Privacy policy must disclose Meta and Google data sharing and the use of Conversions API / Enhanced Conversions.

---

## 9. ⏳ PENDING RECON (leave as TODO placeholders — do not invent)

- **Primary keyword targets** per language and per page — TODO from recon.
- **FAQ question set** validated against real search queries — seed with §4 list, expand from recon.
- **Listicle / directory / blog outreach list** (for off-site authority) — TODO from recon.
- **Competitor gap analysis** — TODO from recon.
- **Off-season / diaspora demand angles** — TODO from recon.

---

## 10. Execution order & acceptance criteria

**Order:** §1 (protect rankings) → §2 (technical foundation, incl. multilingual URL change) → §6/§7/§8 (tracking + consent) → §3/§4/§5 (schema + content) → populate §9 when recon lands.

**Acceptance criteria:**
- Old ranking content preserved; legacy URLs 301'd; GSC verified with baseline captured and sitemap submitted.
- Each page reachable at distinct `/ro/`, `/ru/`, `/en/` URLs with correct reciprocal hreflang + x-default; no primary content hidden behind client-side rendering.
- robots.txt allows the listed crawlers; sitemap.xml with hreflang present; llms.txt present.
- Valid JSON-LD (passes Google Rich Results test) for LodgingBusiness, HotelRoom, FAQPage, BreadcrumbList, Organization.
- OG/Twitter tags correct on every page/language; link-share previews render properly.
- Meta Pixel + CAPI live, consent-gated, deduped; server-side `Purchase` confirmed in Test Events with `value`/`MDL`.
- Google Ads conversion + Enhanced Conversions live, consent-gated; server-side import wired to the same Edge Function.
- No secrets in client code. No raw PII in logs or URLs.
- Core Web Vitals in the "good" range on key pages.

**Before destructive or architecture-level changes (esp. the multilingual URL restructure and the 301 map), present a plan and confirm.**
