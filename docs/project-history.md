# Project History — EcoVila

Reconstructed from git history (`git log`, 2026-05-07 → 2026-06-01), the
implementation roadmap in `docs/ECOVILA_PROJECT_BRIEF.md`, and the per-step records in
`docs/superpowers/plans|specs/`. Dates are commit `author-date` (YYYY-MM-DD). Future
sessions append to the running log at the bottom.

## Timeline of major phases

### Phase 1 — Landing & project setup (2026-05-07)
- `6b5c3b1 Initial commit`
- `7f966d1 Refresh landing page and project brief` — established the vanilla
  HTML/CSS/JS landing and the authoritative project brief.
- Corresponds to brief **Step 1 (landing)**; design recorded in
  `docs/superpowers/specs/2026-05-06-landing-page-design.md`.

### Phase 2 — Booking core & checkout (2026-05-08)
- `b58c7db Add checkout flow and booking availability updates`
- `5982104 Add CRM step 9 design spec` — CRM design captured early.
- Covers brief **Steps 3–5** (booking core, booking page, checkout) and the Supabase
  **foundation** (Step 2) migrations dated 2026-05-06..08.

### Phase 3 — Backup sync, confirmation/cancellation, hero revamp (2026-05-11 → 05-12)
- `51d404b Sync latest codebase from ecovila2 backup` — a bulk import from a separate
  "ecovila2" working copy. (inferred: parallel development was consolidated here.)
- `f62822a Update footer layout and add social links; add confirmation/cancellation pages`
  — brief **Step 6** (`confirmare.html`, `anulare.html`).
- `3606b44 Revamp landing page hero video…` then `88a3314 Switch hero video to H.264 for
  iOS compatibility` — hero media iteration.

### Phase 4 — Legal pages & refund policy (2026-05-16)
- `7d6dab2 / 3e7c205` design + plan, `bd56ba0` contract test, `ca4dfc5 Fix test harness
  paths after docs reorg` (tests moved under `docs/`), `5784fb9 / b4695d6` legal pages,
  `6b7cd29 Align cancellation flow with 7-day refund policy`.
- Brief **Step 8** (legal) plus the cancellation/refund policy migration
  (`20260516120000_cancellation_refund_policy.sql`).

### Phase 5 — Production notifications & delivery tracking (2026-05-17)
- Step-10 design/plan (`7453466`, `23ae1bf`, `08af31f`) then a sequence hardening the
  notification pipeline: `252c2fd track delivery lifecycle`, `3540f8c honest sent
  timestamps`, `f23ee1c reserve events before dispatch`, `2b56ec4 / aa87076` dispatch
  separation/hardening, `6791240 retry policy`, `9d04d8b / 026f4b7` atomic retry claims.
- Also `9a7279f Publish current project state` and `cf9c581` favicon refresh.
- Backed by migrations `…step10_notification_delivery_tracking`, `…office_reservations`.

### Phase 6 — Payments module & rail routing (2026-05-18)
- `6627e6f define payments module boundary`, `046f3ae Add live payments module for Maib
  integration`, `4da4252 / cee69a2 route online payments by phone country`,
  `e904708 payments owner checklist`.
- Establishes Maib integration and the MIA(`+373`)-vs-card rail decision.

### Phase 7 — CRM reception/finance/towels & international guests (2026-05-23 → 05-24)
- `cfbf426 add crm towel and reception workflows`, `e9f259c / eb306e8 crm finance
  reporting tab`.
- Migrations add towel/daily guest counts, `reservation_paid_at` (+ trigger),
  international guest phones, and guest language.

### Phase 8 — Maib hosted Checkout & reservation management (2026-05-26 → 05-31)
- A run of migrations wiring Maib Checkout payments, session-expiry cron, payment
  indexes/policies, unstarted-payment cleanup, and reservation-lookup refunds.
- `4f01517 feat: add maib checkout and reservation management` (HEAD on `main`) — adds
  the `maib-create-payment/-callback/-refund` and `reservation-lookup-*/-manage/-cancel`
  Edge Functions and their tests.

## Current state (2026-06-01)

- Brief Steps 1–11 are implemented in code. Step 12 (tophost deployment) and live
  provider/secret wiring are operational, not verifiable from the repo.
- Branches present: `main` (default working branch here), `codex/crm-step-9`
  (the repo's configured base for PRs), `codex/crm-towels-daily-cards`. No tags.
- Tests green: 176 Node contract tests + 37 Deno tests.
- The public homepage is a maintenance holding page (`index.html`); full landing at
  `site.html`.
- The backend workspace (`supabase/`) and Node tests (`tests/`) now live at the repo
  root. They previously lived under `docs/` after the 2026-05-16 "docs reorg"
  (`ca4dfc5`), and Step 14 moved them back to conventional locations.
- The 2026-06-01 production-readiness audit found green automated checks but open
  production blockers: public security-definer RPC review, plaintext legacy cancellation
  tokens, server-side child-age validation drift, and the Maib `pg_cron` migration
  assumption. The CRM stored-XSS blocker was fixed in Step 15, and the legacy UUID-only
  confirmation-actions blocker was fixed in Step 16.

## Notable decisions reconstructed from history

- **No framework / no build step** — deliberate, dictated by tophost.md static hosting
  (brief "Critical note on hosting").
- **All server logic in Supabase Edge Functions** — same hosting constraint.
- **Notification pipeline hardened for idempotency** — the 2026-05-17 sequence
  introduced event reservation, atomic retry claims, and lifecycle tracking to avoid
  duplicate/lost SMS/email.
- **Payment rail by phone country** — MIA for Moldovan (`+373`) numbers, hosted card
  Checkout otherwise.

---

## Running session log (append below; newest last)

- 2026-05-31 — Phase 0 audit. No application code changed. Created the documentation
  set under `docs/` (AGENTS, README, project-overview, project-structure,
  project-history, security, bugs, plan, decisions, conventions). Verified: 164 Node
  tests pass, 32 Deno tests pass, `deno check` passes, `deno lint` reports 93 problems.
  Next: execute `docs/plan.md` STEP 1.
- 2026-05-31 — OFF-PLAN cancellation policy fix. Changed guest online cancellation to
  require at least 7 calendar days before arrival or the first 2 hours after creation,
  blocked cash online cancellation with office-only reimbursement copy, and routed paid
  Maib CRM cancellations through the Diana-only refund function. No planned cleanup step
  was advanced.
- 2026-05-31 — STEP 1 cleanup. Added the root `.env.example` with blank Supabase,
  cron/site, SMS.md, Resend, and Maib environment-variable names, updated the developer
  README to point deployers at it, and marked security finding S-4 fixed.
- 2026-05-31 — STEP 2 cleanup. Renamed the Deno Edge Function tests from `*-test.ts`
  to `*.test.ts`, updated the Node file-existence contract, and documented that
  `deno task test` now discovers and runs all 32 backend tests.
- 2026-05-31 — STEP 3 cleanup. Added a dependency-free root `package.json` with
  `npm test` / `test:node` / `test:deno`, added a Node contract test for the test
  runner, documented the canonical command, and recorded ADR-009.
- 2026-05-31 — STEP 4 cleanup. Removed unnecessary `async` from the SMS/email provider
  wrappers and reservation hash wrappers so `deno lint` no longer reports
  `require-await`; remaining lint debt is 87 `no-explicit-any` plus 1 import-prefix
  issue.
- 2026-05-31 — STEP 5 cleanup. Added a `std/assert` Deno import-map alias in
  `supabase/functions/deno.json` and `import_map.json`, updated
  `maib.test.ts` to use the bare specifier, and reduced lint debt to 87
  `no-explicit-any` findings.
- 2026-05-31 — STEP 6 cleanup. Reconfirmed that the two root `ecovilavideo*.mp4`
  files and `assets/logo_small.png` have no scoped frontend references, then recorded
  the owner decision to keep them.
- 2026-05-31 — STEP 7 cleanup. Removed fabricated phone defaults from checkout and CRM
  add-reservation flows, kept `+373` only as placeholder copy, and added contract tests
  for empty-phone rejection.
- 2026-05-31 — STEP 8 cleanup. Removed all `_shared/` explicit `any` usage by adding
  shared Supabase client/result aliases plus typed notification, reservation, Maib, and
  reservation-management helper payloads; remaining Deno lint debt is 70
  `no-explicit-any` findings outside `_shared/`.
- 2026-05-31 — STEP 9 cleanup. Removed all explicit `any` usage from the reservation
  lookup, manage-details, and guest cancellation Edge Function entrypoints; remaining
  Deno lint debt is 49 `no-explicit-any` findings outside those files.
- 2026-05-31 — STEP 10 cleanup. Removed all explicit `any` usage from the Maib callback
  and payment-creation Edge Function entrypoints with local payment, reservation,
  session, and query-builder types; remaining Deno lint debt is 21 `no-explicit-any`
  findings in the Step 11 entrypoints.
- 2026-05-31 — STEP 11 cleanup. Removed the final explicit `any` usage from
  `confirm-reservation-payment`, `expire-cash-reservations`, `send-reminders`, and
  `create-reservation`; `deno lint` now passes cleanly across all Edge Function source
  and tests.
- 2026-05-31 — STEP 10/11 plan-status reconciliation. Re-read the Maib and remaining
  type-cleanup files, re-ran the typecheck/lint/Deno tests plus the full `npm test`
  suite, and corrected stale `docs/plan.md` step-block statuses so the next actionable
  cleanup step is Step 12.
- 2026-05-31 — STEP 12 cleanup. Centralized Edge Function CORS in `_shared/cors.ts`,
  added the optional `ECOVILA_ALLOWED_ORIGINS` override, threaded request-aware CORS
  headers through JSON/error responses, and added Deno coverage for allowed, unknown, and
  env-configured origins.
- 2026-06-01 — STEP 13 cleanup. Changed staff-role authorization to validate bearer
  tokens through Supabase Auth before reading `app_metadata.role`, updated staff
  functions to await the async guard, added Deno coverage for forged role-claim
  rejection, and added `SUPABASE_ANON_KEY` to the Edge Function secret template/docs.
- 2026-06-01 — STEP 14 cleanup. Relocated the Supabase workspace and Node contract tests
  to root-level `supabase/` and `tests/`, updated path-sensitive docs/tests/scripts, and
  verified 171 Node tests, 36 Deno tests, `deno check`, `deno lint`, and no stale
  `docs/(tests|supabase)` references.
- 2026-06-01 — Production readiness audit. Performed a docs-only pre-production scan
  after Step 14: verified `npm test`, `deno lint`, `deno check`, `deno fmt --check`,
  local HTML references, local static HEAD checks, a secret-pattern scan, and
  `deno outdated`; `npm audit` could not run without a lockfile. Added
  `docs/production-readiness-audit.md`, opened B-8 through B-13 and S-7 through S-11,
  and extended `docs/plan.md` with Steps 15-18 for the remaining launch blockers.
- 2026-06-01 — STEP 15 cleanup. Added shared CRM HTML escaping via
  `EcoVilaCrmCalendar.escapeHtml`, escaped reservation names/phones/labels in calendar,
  pending-cash, sidebar search, and daily reception cards, rejected public guest names
  containing `<` or `>`, and added XSS regression coverage. Verified 173 Node tests, 36
  Deno tests, `deno check`, and `deno lint`.
- 2026-06-01 — STEP 16 cleanup. Replaced UUID-only confirmation status/extend/cancel
  actions with `id` + `manage` token links, added the `reservation-extend-cash` Edge
  Function, dropped the old anonymous confirmation RPC signatures in a new migration,
  and added regression coverage for bare-ID rejection and manage-token storage.
  Verified 175 Node tests, 37 Deno tests, `deno check`, and `deno lint`.
- 2026-06-02 — OFF-PLAN daily confirmed-only bug documentation (commit: 1a24c8a).
  Investigated `Situația zilnică`, reproduced that `loadDaily` renders paid, pending,
  and cancelled selected-date rows, documented B-14 plus future owner-gated Step 19, and
  updated production-readiness/project-overview status. No application code was changed.
- 2026-06-02 — OFF-PLAN B-14 daily confirmed-only fix (commit: fc5c3d6). Added a
  RED/GREEN daily reception regression for paid, pending, and cancelled selected-date
  rows; filtered `crm-daily.js` arrivals/departures to paid, non-cancelled reservations;
  marked B-14 and Step 19 fixed; verified 176 Node tests, 37 Deno tests, Deno lint, and
  Deno type-check.
- 2026-06-03 — OFF-PLAN SEO/AEO + conversion tracking implementation. Replaced the root
  maintenance homepage with the full Romanian landing page, added static `/ru/` and
  `/en/` homepages with self canonicals and reciprocal hreflang, inventoried the old
  PHP/DB ranking source, added `robots.txt`, `sitemap.xml`, `llms.txt`, `.htaccess`,
  and a Tophost upload-prep script, and drafted the full legacy PHP/query-string
  redirect map for owner confirmation before deployment.
  Upgraded cookie consent to category state, added public tracking config/browser
  tracking, added the JWT-protected `track-event` Edge Function and shared server-side
  tracking helper, stored shared event IDs/match parameters on reservations, and emitted
  server-side Purchase from Maib and staff cash confirmation flows. Also documented the
  out-of-scope SMS URL-query PII issue as B-15/S-12/Step 20. Verified 187 Node tests,
  38 Deno tests, `deno lint`, and Deno type-check.
- 2026-06-03 — OFF-PLAN SEO follow-up and publish prep. Restored the compact native
  language selector on `/`, `/ru/`, and `/en/`; removed public legacy pricing/access
  sections with dated hardcoded prices; kept approved 301 targets valid by moving
  `#despre` to the current intro section and adding a footer `#contact` anchor; added
  regression coverage that every approved redirect target resolves to a shipped page or
  root anchor. Added `docs/old-content-inventory.md`, ignored `Archive.zip` and the raw
  `docs/old php/` hosting backup because the backup contains retired credentials/server
  artifacts, and updated docs to match the owner-approved public content decision.
  Verified 188 Node tests, 38 Deno tests, and Tophost upload packaging.
- 2026-06-03 — OFF-PLAN four owner-reported fixes (no plan step advanced). (1) B-16:
  gated arrival reminders to 10:00 Europe/Chisinau via new `_shared/reminders.ts`
  (`shouldSendArrivalReminders`/`arrivalReminderTargetDate`) so the "see you tomorrow"
  SMS no longer fires at the UTC-midnight rollover (03:00 EEST); cron cadence unchanged.
  (2) B-17: `confirmare.js` now recovers `id`/`manage` from the
  `ecovila_pending_reservation` localStorage record after the Maib redirect, fixing the
  post-card-payment "Rezervarea nu a fost găsită" page without weakening the
  manage-token requirement. (3) B-18: the managed confirmation view shows the cash hold
  panel/timer only while pending, the card/success box only for card, and the cash
  office-only refund note (no MAIB policy or online-cancel) for cash. (4) B-19: wrapped
  the right-column panels in `.cf-panels` to remove the large desktop gap between the
  confirmed and manage panels. Added `_shared/reminders.ts` + `tests/reminders.test.ts`;
  logged ADR-019 (reminder gate) and ADR-020 (redirect recovery). Verified 188 Node +
  41 Deno tests, `deno lint`, `deno check`, `deno fmt --check`, and a live two-column
  preview of the confirmation page.
- 2026-06-03 — OFF-PLAN cookie banner redesign (no plan step advanced). Redesigned the
  consent banner across all 10 public pages (ro/ru/en) as a card with a cookie icon,
  title/subtitle, a full-width "Accept toate" action, and a "Setări cookie-uri | Doar
  esențiale" row; the necessary/analytics/marketing checkboxes + "Salvează opțiunile"
  now sit behind the settings toggle. Consent logic in `main.js` is unchanged — added
  only a `[data-cookie-settings]` reveal handler; rewrote `.cookie-banner*` styles in
  `css/main.css`; added `cookie.title`/`cookie.settings`/`cookie.necessary` keys and
  shortened `cookie.text` in `js/translations.js`. Logged ADR-021. Verified 188 Node +
  41 Deno tests and a live browser preview (collapsed + expanded, ro/ru, desktop +
  mobile) confirming Accept-all/Essential-only/custom save all still work.
- 2026-06-03 — OFF-PLAN footer payment logos (no plan step advanced). Added the
  accepted-payment logos (`assets/maib.png`, `mastercard.png`, `visa.png`) on white
  chips under the footer brand tagline across all 10 public footers, and shortened the
  `footer.tagline` copy from "...Orheiul Vechi, Moldova." to "...Orheiul Vechi." (ro/ru/en
  static defaults + translations). White chips keep each brand logo in its native colours
  and legible on the dark espresso footer; the EcoVila footer logo is unchanged. Added
  `.site-footer__payments`/`.site-footer__payment` CSS. Verified 188 Node + 41 Deno tests
  and a live footer preview (desktop + mobile).
- 2026-06-04 — OFF-PLAN stay-date pricing fix (no plan step advanced). Scheduled prices
  now apply by the night being booked instead of by the booking date. Previously
  `findPricingRow` in `js/pricing.js` selected the tier with `effective_from <= createdOn`
  (today), so a price scheduled for e.g. 2026-10-01 stayed dormant until the calendar
  reached that date — a guest booking in June for an October stay got the old rate.
  Reworked `findPricingRow` to choose the latest tier with `effective_from <= stayDate`
  (the night's own date), falling back to the earliest published tier for nights before
  any schedule (so early stays never error). `calculateStayPrice` now passes each night's
  date as `stayDate`; `admin/js/crm-sidebar.js` `calculateStaffTotal` does the same, so
  staff bookings and stay-extension supplements price per night too. A straddling stay is
  priced night-by-night (September nights old rate, October nights new rate). No DB/schema
  change — existing scheduled price rows apply as soon as the JS is deployed. Updated the
  scheduled-price test and added cases for the June-books-October scenario and the
  pre-schedule fallback in `tests/booking-core.test.mjs`. Verified 194 Node tests pass.
- 2026-06-08 — OFF-PLAN Finance one-day booked-villas detail (no plan step advanced).
  Added a Finance-only created-bookings detail for the case where exactly one day is
  selected and mode is `Încasări`: the revenue metrics still use `paid_at`, while a new
  list shows non-cancelled villas whose reservation rows were created on that selected
  day, including villa number, accommodation type, adult/child party, nights, stay
  dates, total, booked timestamp, and payment state. Added the
  `fetchFinanceBookedReservations` browser helper, kept rendering via DOM
  `textContent`, and added RED/GREEN Node coverage for the hooks and normalization
  behavior. Reviewed README, production-readiness, security, bugs, decisions, and
  conventions with no changes needed; updated overview, structure, the historical
  Finance spec/plan, history, and plan. Verified focused CRM tests, full `npm test`
  (194 Node + 41 Deno), `git diff --check`, and a localhost browser preview of the
  one-day `Încasări` layout.
- 2026-06-08 — OFF-PLAN CRM auth persistence included in publish scope. The same
  working tree also contained CRM auth-storage changes that pass a cookie-backed storage
  adapter into the Supabase browser client for `/admin` sessions, clear CRM auth cookies
  on invalid sessions/sign-out, and add Node coverage for the custom auth storage
  adapter. Included per owner instruction to commit unrelated modified files together.
- 2026-06-08 — OFF-PLAN Finance calendar Apply button fix. Fixed B-21: the Finance range
  calendar now applies a single clicked day by treating the missing draft end as the same
  selected day, so one-day `Încasări` reloads metrics and the booked-villas detail for
  that selected date. Added a click-path CRM regression test for the paid one-day flow.
  Also ran a repo-wide button/data-selector scan: static buttons all had handlers or
  native form/dialog behavior; scanner misses were dynamic controls wired at render time.
- 2026-06-08 — OFF-PLAN CRM delete confirmation and rolling calendar fix (no plan step
  advanced). Replaced the dashboard reservation delete typed-word gate (`sterge`) with
  two Romanian native confirmations. Kept paid card/MAIB CRM cancellation on the
  staff-only refund-first path before cancelling the booking group. Reworked the
  dashboard calendar to render a previous/current/next-month rolling window, extend that
  window near either horizontal scroll edge, update the month/year label from the visible
  scroll position, and restore horizontal scroll after reloads such as deletion. Added
  RED/GREEN CRM regression coverage for double confirmation, MAIB refund-before-cancel,
  second-confirmation abort, buffered calendar dates, visible-month labeling, and scroll
  restoration. Updated project-overview, project-structure, production-readiness, bugs,
  history, and plan; reviewed README, security, decisions, and conventions with no
  changes needed. Verified focused CRM tests, full `npm test` (200 Node + 41 Deno),
  `deno check`, `deno lint`, stale-hook grep, and localhost admin auth-gate browser
  smoke.
- 2026-06-11 — OFF-PLAN pre-launch payment-flow audit, fixes, and production deploy.
  Full-codebase read found three Criticals: B-23 client-controlled reservation price
  (no server recomputation), B-24 direct anon INSERT into `reservations` via RLS
  policy + grant, B-25 MAIB callback confirming bookings without amount
  reconciliation. Added the server-side pricing guard (`_shared/pricingGuard.ts` +
  `_shared/pricing.js`, byte-identical copy of `js/pricing.js` enforced by
  `tests/pricing-guard.test.mjs`), migration
  `20260611120000_revoke_public_reservation_insert.sql`, and callback amount
  verification (`getMaibCallbackAmount`; mismatches stay pending). Also fixed B-26
  (removed `TEST_SOLD_OUT_RANGES` scaffolding from `booking.js`), B-27 (holidays are
  recurring month-day rules — removed the date-range filter from the booking-page
  fetch), B-28 (pricing-load failure now blocks checkout instead of falling back to
  hardcoded prices), B-29 (MAIB session reuse now requires an exact amount match),
  B-30 (`.or()` filter injection in `maib-refund` → sequential `.eq()` lookups), and
  B-31 (CRM auth cookie gains `Secure`). Deployed to production via the Supabase CLI +
  management API: migration applied individually because the local/remote migration
  histories are drifted (ADR-023 — plain `db push` would re-run seed upserts and
  overwrite live prices); `create-reservation`, `maib-callback`, `maib-create-payment`,
  and `maib-refund` redeployed. Verified live: tampered total → 409, direct anon
  insert → 42501, correct total → created (test row deleted), callback rejects unsigned
  payloads. `npm test` → 205 Node + 48 Deno. Updated README, production-readiness,
  security, bugs, decisions, conventions, project-structure, plan, and the root
  `bugs.md` fix log; `dist/tophost/` rebuilt and awaiting upload. Owner still needs to
  rotate the Supabase access token shared during the deploy.
- 2026-06-12 — OFF-PLAN content move: location section landing → FAQ, multilingual FAQ
  schema. Removed the "Unde ne aflăm" (`#locatie`) section from all three landing pages
  (`index.html`, `en/index.html`, `ru/index.html`) at the owner's request — the landing
  retains its core location SEO via the LodgingBusiness schema (address/geo/areaServed),
  title/meta/OG, `intro.title`, `hero.place`, and footer, so impact is low. The unique
  nearby-attractions copy (`location.body2`) was relocated to `intrebari-frecvente.html`
  as a new Q&A `faq.q11`/`faq.a11` (RO/RU/EN added to `js/translations.js`), in both the
  visible `.faq-list` (now 11 items) and the FAQPage JSON-LD. Converted that JSON-LD from
  a single RO `FAQPage` into an `@graph` of three nodes (`#faq-ro`, `#faq-ru`, `#faq-en`),
  each `inLanguage`-tagged with the full 11-question set (ADR-024 — interim on a single
  URL; ideal is a per-language URL split per ADR-016). Removed the now-orphaned
  `location.*` keys (kicker/title/body1/body2/faq) from all three locales. Verified on the
  local static server: landing section order is hero→despre→spa→… with no `#locatie`,
  the new FAQ item renders and translates across RO/EN/RU, the JSON-LD parses to 3
  FAQPage nodes × 11 Q&As, `node --check js/translations.js` passes, and no console
  errors on either page. `dist/tophost/` not yet rebuilt; change still awaits the tophost
  upload to go live. Updated decisions (ADR-024 + open question) and history.
- 2026-06-12 — Responsive/UI fixes: desktop breakpoint, mobile footer, villa-modal CTA.
  Three CSS-only fixes (`css/main.css`, `css/booking.css`), no markup or JS changes.
  (1) Lowered the desktop→mobile collapse breakpoint from `max-width: 1120px` to
  `900px` in `main.css` — 11" laptops (often <1120 CSS px) were dropping to the
  single-column "mobile" layout; verified the intro/showcase/footer grids stay
  two-column at 1024px and still collapse at 880px. (2) Fixed the footer rendering
  off-centre on mobile: `.site-footer__grid` is a `.section-inner` (centred via
  `margin: 0 auto`), but the ≤900px override forced `margin-inline: 0`, left-aligning
  the 343px grid and leaving a ~32px dead gap on the right — changed it to
  `margin-inline: auto` so the footer centres (16px each side) across the 700–900px
  range. (3) Made the villa-details modal "Rezervă acum →" CTA visible: the button
  (already wired to navigate to `rezervari.html` and `position: sticky`) used
  `var(--booking-green)` for background/border, but that custom property is defined only
  under `.booking-page` (the reservations page), not on the landing pages — so on the
  landing modal the declaration was invalid and the button rendered transparent with
  white text (invisible on the white modal). Added a literal fallback
  `var(--booking-green, #5F7A3A)` so it renders solid green everywhere; applies to all
  three landing pages (RO/EN/RU) since they share the markup and load `booking.css`.
  Verified all three fixes in the browser preview at desktop and mobile widths.
  `dist/tophost/` not yet rebuilt; awaits the tophost upload to go live.
- 2026-06-12 — Included-facilities section + reusable detail modal + landing CTAs.
  Added a new "Totul este inclus" section below the villa cards on `rezervari.html`:
  four long, alternating editorial cards — SPA, Mese All-Inclusive, Locație & Natură,
  Distracție pentru copii — each with title/short summary/"Vezi mai mult" CTA and a
  media strip (2 photos on desktop, 1 on mobile). Cards pull published photos from the
  DB by section slug (`spa`, `restaurant-food`, `territory`, `playground`) with local SVG
  fallbacks; added `assets/photos/playground/{slide,swings,sandbox}.svg` placeholders
  since that section had no local art. The "Vezi mai mult" CTA opens a detail modal that
  reuses the existing `booking-modal`/`booking-details-gallery`/`booking-check-list`
  styles (gallery + description + highlights). New module `js/facilities.js` owns the
  cards, modal, i18n and language/photo reactivity; `js/booking.js` now publishes the
  fetched photo library via `window.EcoVilaPhotoLibrary` + a `ecovila:photolibrary`
  event so facilities reuse it with no second fetch. Added `facilities.*` strings
  (RO/RU/EN) to `js/translations.js`. Also on `rezervari.html`: removed the old
  accommodation lead line and changed the no-dates stay-summary to
  "Vezi mai jos facilitățile incluse ↓".
  SPA card carries a warm "all pools heated · min. 30°C*" trust cue in two forms — a
  floating chip on the card media and a compact banner in the detail modal — with the
  asterisk tying to the `*Piscină rece (12°C)` highlight (the deliberate cold-plunge
  exception). Copy for the Locație card (now "10 minutes from Orheiul Vechi", forest,
  wine, all-inclusive/SPA highlights) and the Distracție-copii card (now honest to the
  real offer: a big outdoor playground, an indoor playground, and free play on the
  grounds — dropped the invented kids' menu / activities) was rewritten in all three
  locales. Refactored `js/facilities.js` so the detail modal works standalone (the cards
  list is optional, modal required), exposing `window.EcoVilaFacilities.open(id)` and
  binding any `[data-facility-open]` trigger. Wired the same detail view into the
  landing: `index.html` `#spa` and `#restaurant` sections got CTAs ("Descoperă zona SPA",
  "Vezi ce este inclus") plus the facility modal markup and the `facilities.js` include;
  `js/main.js` now also publishes the photo library + event; `css/main.css` adds CTA
  spacing and a light button treatment scoped to the dark restaurant hero
  (`.image-hero__cta .editorial-button`); `showcase.spa.cta`/`showcase.restaurant.cta`
  added (RO/RU/EN). Hero title tweak: RO dropped "din Moldova" → "Un refugiu
  all-inclusive în inima pădurii"; RU rewritten to "All-Inclusive отдых в глубинке леса";
  EN left untouched. All facility-card layouts, both modals, the heat cue, the landing
  CTAs, and the hero/copy changes were verified in the browser preview across desktop,
  mobile, and RO/RU/EN. Note: the four facility photo sections must be published in the
  CRM (uploads default to `draft`) before real photos replace the placeholders.
  `dist/tophost/` not yet rebuilt; change awaits the tophost upload to go live.
