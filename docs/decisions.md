# Architectural Decision Log — EcoVila

Lightweight log so future sessions don't re-litigate settled choices. Append new
decisions at the bottom with a date. Entries marked **(reconstructed)** were inferred
from code/history during the Phase 0 audit, not from a contemporaneous decision record.

---

### ADR-001 — Vanilla HTML/CSS/JS, no framework, no build step (reconstructed)
- **Date:** project inception (2026-05).
- **Decision:** the public site and CRM are hand-written HTML/CSS/JS with no bundler,
  transpiler, or framework.
- **Why:** the production host is tophost.md, shared cPanel hosting with no Node.js
  runtime; files must deploy as-is (`docs/ECOVILA_PROJECT_BRIEF.md`, "Critical note on
  hosting").
- **Consequence:** shared JS uses a UMD-style wrapper so the same files run in the
  browser and under `node:test`. Any proposal to add a build step must be logged as a
  new ADR and weighed against the hosting constraint.

### ADR-002 — All server-side logic in Supabase Edge Functions (reconstructed)
- **Date:** 2026-05 (Step 7 onward).
- **Decision:** SMS, email, payment callbacks, refunds, cash-expiry, reminders, and all
  privileged writes run in Deno/TypeScript Edge Functions, not on the host.
- **Why:** no server runtime on tophost.md; the browser talks to Supabase directly.
- **Consequence:** the service-role key lives only in Edge Function secrets; the browser
  uses the anon key + RLS.

### ADR-003 — Supabase as the single backend (DB + Auth + Storage + Functions) (reconstructed)
- **Date:** 2026-05 (Step 2).
- **Decision:** Postgres with RLS for data + role-based access (`anon`, `diana`,
  `angela`); Supabase Auth for staff login; Storage for CRM photos.
- **Consequence:** access control is enforced by RLS policies (foundation migration),
  not application code; the anon key is safe to ship.

### ADR-004 — Online payment rail chosen by phone country code (reconstructed)
- **Date:** 2026-05-18.
- **Decision:** Moldovan (`+373`) numbers use Maib **MIA**; all other numbers use Maib
  hosted **card** Checkout (`js/checkout.js:80`).
- **Why:** MIA is a Moldova-local instant-payment rail; international guests need card.

### ADR-005 — Idempotent, lifecycle-tracked notifications (reconstructed)
- **Date:** 2026-05-17.
- **Decision:** notification events are reserved before dispatch, retries use atomic
  claims, and delivery lifecycle (pending/sent/failed/abandoned) is tracked in the DB.
- **Why:** avoid duplicate or lost SMS/email across cron retries and concurrent
  invocations (see the 2026-05-17 commit sequence and Deno tests).

### ADR-006 — Root homepage is the full Romanian landing page
- **Date:** reconstructed 2026-05-17; superseded by owner approval on 2026-06-03.
- **Decision:** `index.html` now serves the full Romanian landing page at `/`. The old
  "în curând" maintenance page must not be live at root. `site.html` remains only as a
  local transition/source artifact and is redirected to `/`.
- **Why:** the old one-page site ranked organically; launch must protect rankings by
  keeping real content at the root canonical URL.
- **Consequence:** tests now assert the full Romanian homepage at `index.html`;
  `scripts/prepare-tophost-upload.mjs` excludes `site.html` from production upload.

### ADR-007 — Documentation-first / contract tests (reconstructed)
- **Date:** throughout.
- **Decision:** many tests assert that files contain specific structures/copy (contract
  tests), alongside true unit tests of `pricing.js` and the Edge Function helpers.
- **Consequence:** moving or renaming files/markup can break tests by design; update
  tests deliberately, and keep `docs/` consistent (the Definition of Done).

### ADR-008 — Guest online cancellation window vs. staff refund authority
- **Date:** 2026-05-31. **Amended 2026-06-13 by ADR-035** (advance window 7 → 20 days).
- **Decision:** guest-facing online cancellation is available only when there are at
  least 7 calendar days before arrival (**now 20 — see ADR-035**), or when the
  reservation was created less than 2
  hours ago. Cash-paid reservations are not cancelled or reimbursed online; they direct
  guests to the EcoVila office. Diana-initiated CRM cancellation of paid Maib bookings
  may refund through the staff-only `maib-refund` function regardless of the public guest
  window.
- **Why:** the public self-service flow should match the current business policy and
  avoid online cash reimbursement, while staff need an override path for operational
  cancellations.
- **Consequence:** the policy is enforced server-side in both `reservation-cancel` and
  the latest `cancel_reservation_by_token` RPC; browser UI only mirrors the rule.

### ADR-009 — Root package manifest is scripts-only
- **Date:** 2026-05-31.
- **Decision:** add a minimal root `package.json` to expose `npm test`,
  `npm run test:node`, and `npm run test:deno`, with no dependencies, dev dependencies,
  build script, or install requirement.
- **Why:** the repository has two test suites in different runtimes; one root command
  lowers onboarding friction while preserving ADR-001's no-build/static-hosting
  constraint.
- **Consequence:** `npm test` is the canonical full local verification command for the
  frontend contract suite plus Deno Edge Function tests. New scripts must remain
  tooling-only unless a future ADR explicitly changes the no-build posture.

### ADR-010 — Keep unreferenced legacy media assets
- **Date:** 2026-05-31.
- **Decision:** keep `ecovilavideo.mp4`, `ecovilavideo-web.mp4`, and
  `assets/logo_small.png` in the repository even though scoped reference checks find no
  current HTML/JS/CSS usage.
- **Why:** owner explicitly declined Step 6 removal.
- **Consequence:** these files are considered owner-retained assets, not active cleanup
  targets. Do not remove them in later sessions unless the owner explicitly reverses
  this decision.

### ADR-011 — Centralize Edge Function CORS allowlist
- **Date:** 2026-05-31.
- **Decision:** all Supabase Edge Function CORS responses use `_shared/cors.ts`, which
  defaults to the known EcoVila origins and can be overridden with comma-separated
  `ECOVILA_ALLOWED_ORIGINS`.
- **Why:** per-function allowlists left most functions on `Access-Control-Allow-Origin:
  *`; a single helper keeps booking, checkout, CRM, cron, and payment responses aligned.
- **Consequence:** preflight and JSON/error responses must receive the request context
  so allowed origins are echoed precisely. Unknown origins receive no permissive CORS
  origin header.

### ADR-012 — Staff role checks verify tokens locally
- **Date:** 2026-06-01.
- **Decision:** `requireStaffRole` validates the bearer token through Supabase Auth
  (`auth.getUser`) before reading `app_metadata.role`, even though staff functions also
  keep `verify_jwt = true` in `supabase/config.toml`.
- **Why:** relying only on the Edge Function gateway made role checks forgeable if a
  future config change accidentally disabled `verify_jwt` on a staff function. Auth
  validation uses the existing Supabase JS dependency and avoids adding a JWT library.
- **Consequence:** staff-only Edge Functions require `SUPABASE_ANON_KEY` in their
  server-side environment in addition to `SUPABASE_URL`; call sites must `await
  requireStaffRole(...)`.

### ADR-013 — Supabase backend and Node tests live at repo root
- **Date:** 2026-06-01.
- **Decision:** move the Supabase workspace to root-level `supabase/` and the Node
  contract suite to root-level `tests/`; keep `docs/` documentation-only.
- **Why:** this matches Supabase CLI conventions, removes the B-6 onboarding surprise,
  and lets root `package.json` scripts point at conventional locations.
- **Consequence:** path-sensitive tests, package scripts, `.claude` command permissions,
  and documentation must use the root-level paths. Historical planning records were
  mechanically updated to the new locations so future grep-based audits do not revive
  the old layout.

### ADR-014 — CRM reservation text is escaped at the shared calendar boundary
- **Date:** 2026-06-01.
- **Decision:** use `EcoVilaCrmCalendar.escapeHtml` as the shared CRM escaping helper for
  reservation text that still renders through string templates, and reject public guest
  names containing raw `<` or `>` before storage.
- **Why:** the CRM has several compact card/list renderers that still use `innerHTML`
  for markup. A single shared helper keeps calendar cards, pending-cash cards, sidebar
  search results, and daily reception cards aligned without introducing a frontend build
  step or a new dependency.
- **Consequence:** new CRM renderers must treat reservation names, phones, labels, dates,
  and data attributes as untrusted. Prefer DOM nodes plus `textContent` when practical;
  otherwise call the shared helper before template insertion.

### ADR-015 — Confirmation actions use immediate manage tokens
- **Date:** 2026-06-01.
- **Decision:** checkout creates a hashed manage-token row at reservation creation time
  and gives the plaintext token only to the guest-facing redirect/payment flow.
  Confirmation URLs use `confirmare.html?id=<reservation_id>&manage=<token>`, and the
  confirmation page rejects bare reservation IDs.
- **Why:** this preserves the existing cash countdown and card-payment polling UX while
  removing the old reservation-UUID-only bearer link. Requiring phone verification before
  every confirmation action would add friction immediately after checkout; separate
  signed action tokens would duplicate the existing hashed manage-token model.
- **Consequence:** all private confirmation-page reads/actions go through token-backed
  Edge Functions (`reservation-manage-details`, `reservation-extend-cash`,
  `reservation-cancel`). Booking lookup by SMS code remains the fallback for guests who
  need a fresh manage token later.

### ADR-016 — Multilingual homepage URLs are static per-language URLs
- **Date:** 2026-06-03.
- **Decision:** Romanian stays canonical at `/`; Russian is `/ru/`; English is `/en/`.
  Do not create a served Romanian `/ro/` duplicate. If `/ro/` ever exists, it should be
  a 301 to `/`, not a canonicalized duplicate.
- **Why:** ranking protection comes first, and the previous single-URL JS i18n model was
  not a clear crawlable language architecture.
- **Consequence:** each localized homepage has a self canonical plus reciprocal
  hreflang cluster (`ro`, `ru`, `en`, `x-default`). Language switcher links Romanian
  directly to `/`.

### ADR-017 — Consent-gated server-side conversion tracking
- **Date:** 2026-06-03.
- **Decision:** consent state is one shared category object
  (`necessary` / `analytics` / `marketing`). Meta Pixel, Meta CAPI, Google tag, and
  Google Ads conversion upload are gated by marketing consent. Purchase is emitted
  server-side from both card (`maib-callback`) and cash
  (`confirm-reservation-payment`) confirmation paths with `currency: MDL`, deduped by
  the same `tracking_event_id` used by the browser event.
- **Why:** secrets cannot live in browser code, and browser/server events need dedupe to
  avoid double-counted conversions.
- **Consequence:** public code only contains public IDs in `js/tracking-config.js`;
  provider tokens stay in Supabase Edge Function env vars. Reservation rows store the
  event ID and browser match parameters needed for server-side dispatch.

### ADR-018 — Raw old hosting backup stays local-only
- **Date:** 2026-06-03.
- **Decision:** ignore `Archive.zip` and `docs/old php/`; commit only the sanitized
  `docs/old-content-inventory.md` summary of former PHP/DB content and URL targets.
- **Why:** the raw backup includes retired database credentials, WordPress salts,
  cPanel/mail/SSL artifacts, and large media folders. Ranking protection needs the
  content inventory and redirect map, not unsanitized server material in Git history.
- **Consequence:** future agents should use the inventory doc for committed context. If
  raw old-source files need to be committed later, they require a separate sanitization
  pass and owner approval.

### ADR-019 — Arrival reminders are gated to 10:00 Europe/Chisinau in-function
- **Date:** 2026-06-03.
- **Decision:** hold the daily "see you tomorrow" arrival reminder until the local
  business hour (Europe/Chisinau) reaches 10:00, enforced inside `send-reminders`
  (`_shared/reminders.ts`), rather than changing the external cron cadence or adding a
  `pg_cron` schedule. The cron keeps running ~every minute; the function returns early
  before 10:00 and `notification_events` dedup keeps the released batch single.
- **Why:** the reminder previously fired at the UTC-date rollover (03:00 EEST). The
  external scheduler is not in the repo, and the cash-expiry warning logic depends on the
  ~1-minute cadence, so the cadence must not change. Gating in-function is the smallest,
  testable, DST-aware fix and keeps the repo the source of truth. Avoids B-11's
  unresolved `pg_cron` assumption.
- **Consequence:** reminders go out at 10:00 local; late-created next-day bookings are
  reminded on the next tick after creation (still daytime). The threshold is a single
  constant (`ARRIVAL_REMINDER_LOCAL_HOUR`).

### ADR-020 — Confirmation page recovers id/manage from localStorage after the Maib redirect
- **Date:** 2026-06-03.
- **Decision:** when the confirmation page URL lacks `id`/`manage` (the maib Checkout
  gateway does not preserve successUrl query params and appends its own
  `checkoutId`/`checkoutStatus`/`orderId`), `confirmare.js` recovers them from the
  `ecovila_pending_reservation` localStorage record that `checkout.js` writes before the
  payment redirect, matching maib's returned `orderId` against the stored
  `bookingGroupId` when present.
- **Why:** the manage-token requirement (ADR-015 / Step 16) must stay intact, so we keep
  requiring a valid token instead of relaxing the guard. The token already exists in the
  same browser's storage from checkout, so recovering it there is safe and needs no
  backend change or weaker auth. Robust to either maib behaviour (preserve or drop our
  params).
- **Consequence:** the URL guard `if (!reservationId || !manageToken)` remains, now with
  a storage fallback ahead of it. A stale confirmation link opened without params in a
  browser that still holds a different pending reservation is guarded by the `orderId`
  match.

### ADR-021 — Cookie banner redesign keeps the consent contract; categories sit behind a settings toggle
- **Date:** 2026-06-03.
- **Decision:** redesigned the cookie banner as a card (icon + title/subtitle, a
  full-width "Accept toate" primary action, and a "Setări cookie-uri | Doar esențiale"
  row). The necessary/analytics/marketing checkboxes + "Salvează opțiunile" are hidden in
  a `.cookie-banner__settings` panel revealed by the `data-cookie-settings` toggle. The
  consent logic in `main.js` is unchanged — the same `[data-cookie-choice]`
  (`accepted`/`essential`/`custom`) buttons and `[data-cookie-category]` checkboxes drive
  `consentFromChoice`/`saveConsent`; only an additive toggle handler was added.
- **Why:** the owner wanted a cleaner, less cluttered banner. Hiding the category
  checkboxes behind a settings affordance keeps the default surface simple while staying
  GDPR-appropriate — accept-all and reject-to-essential are both one click, and granular
  control is one click away (no pre-ticked non-essential categories).
- **Consequence:** the banner markup is duplicated across the 10 public HTML pages and
  must stay in sync; new `cookie.title`/`cookie.settings`/`cookie.necessary` translation
  keys exist and `cookie.text` is now a short subtitle. The settings toggle button must
  never carry `data-cookie-choice` (that attribute saves + closes the banner).

### ADR-022 — Server-side price recomputation rejects mismatches instead of silently correcting them
- **Date:** 2026-06-11.
- **Decision:** `create-reservation` now recomputes the authoritative booking total
  server-side (`_shared/pricingGuard.ts`) from database `rooms`, `pricing_tiers`, and
  `holidays`, using a byte-identical copy of the browser pricing module
  (`_shared/pricing.js` ≡ `js/pricing.js`, enforced by `tests/pricing-guard.test.mjs`).
  A client total that does not match is **rejected with HTTP 409** ("refresh and try
  again") rather than silently overwritten; on match, the per-room split is normalized
  server-side. The direct `anon` INSERT path into `reservations` was closed
  (`20260611120000_revoke_public_reservation_insert.sql`) so the Edge Function is the
  only public booking entry point. The MAIB callback additionally reconciles the captured
  amount against `maib_payments.amount` and leaves mismatched "paid" callbacks pending.
- **Why:** the displayed quote is a contract with the guest. Silently substituting a
  different (correct) total would charge guests an amount they never saw; rejecting
  forces the client to re-quote from fresh data. Duplicating the pricing module (instead
  of importing across the `supabase/functions` boundary) keeps Edge Function bundling
  simple; the byte-identity test makes the duplication safe.
- **Consequence:** any change to `js/pricing.js` must be copied to
  `supabase/functions/_shared/pricing.js` (the Node suite fails otherwise). Pricing data
  loads must include **all** holidays (recurring month-day semantics) — never
  date-range-filtered — or live quotes will 409 against the server. Client and server
  must stay deployed in step: Edge Functions first, static site promptly after.

### ADR-023 — Production migrations are applied individually; plain `supabase db push` is forbidden on this project
- **Date:** 2026-06-11.
- **Decision:** the remote `supabase_migrations.schema_migrations` history uses different
  version IDs than the local `supabase/migrations/` files (earlier changes were applied
  via the dashboard/MCP under their own timestamps). The 2026-06-11 revoke migration was
  therefore applied through the management API query endpoint and recorded manually in
  the remote history under its local version (`20260611120000`).
- **Why:** a plain `supabase db push` would treat all ~26 local files as unapplied and
  re-run them — including the foundation seed upserts, which would **overwrite live
  `pricing_tiers` values and reset `rooms.is_active`**.
- **Consequence:** until someone reconciles the histories with
  `supabase migration repair --status applied <version>` for each local file, new
  migrations must be applied individually (management API or psql) and inserted into
  `supabase_migrations.schema_migrations` by hand. This warning is also recorded in the
  root `bugs.md` deploy notes.

### ADR-024 — FAQ page carries a per-language `FAQPage` `@graph` on one URL (interim, pending split)
- **Date:** 2026-06-12.
- **Decision:** the "Unde ne aflăm" location section was removed from all three landing
  pages (`index.html`, `en/index.html`, `ru/index.html`) and its unique
  nearby-attractions copy relocated to `intrebari-frecvente.html` as a new Q&A
  (`faq.q11`/`faq.a11`, RO/RU/EN). The FAQ page's JSON-LD was converted from a single
  RO `FAQPage` into an `@graph` of three `FAQPage` nodes — `#faq-ro`, `#faq-ru`,
  `#faq-en`, each with its own `inLanguage` and the full 11-question set.
- **Why:** the landing keeps all core location signals (LodgingBusiness address/geo/
  areaServed, title/meta/OG, `intro.title`, `hero.place`, footer), so removing the prose
  section is low-impact; relocating the attractions copy into FAQPage schema is net-
  positive for GEO. A single mixed-language `FAQPage` would have contradicted the page's
  `inLanguage` declaration, so each language gets its own node.
- **Tension with ADR-016:** the homepage uses static per-language URLs (`/`, `/ru/`,
  `/en/`) precisely to avoid single-URL JS i18n. `intrebari-frecvente.html` is still a
  single URL with client-side i18n, so this `@graph` is an **interim** measure, not the
  target state. Google's textbook-ideal is to split the FAQ into per-language URLs with a
  reciprocal hreflang cluster, mirroring the homepage; when that split happens the schema
  should split with it (one `FAQPage` per URL) and the `@graph` collapses back to a
  single node per page.
- **Consequence:** the dead `location.*` i18n keys were removed from all three locales in
  `js/translations.js`. The FAQ page now has three FAQPage nodes on one URL — valid, and
  crawlers typically surface the node matching the user's language, but it is not the
  clean crawlable language architecture ADR-016 established for the homepage. Recorded as
  an open item below.

### ADR-025 — One shared swipeable pop-up carousel (`js/gallery.js`); `full` photo variant is never server-cropped
- **Date:** 2026-06-12.
- **Decision:** all detail pop-up galleries (accommodation modal on the landing pages and
  `rezervari.html`, facility modal everywhere) are rendered by a single new module,
  `js/gallery.js` (`window.EcoVilaGallery.attach(container)`), replacing three
  copy-pasted swap-the-`src` implementations in `main.js`, `booking.js`, and
  `facilities.js`. The carousel is a horizontal CSS scroll-snap track (native touch
  swipe; mouse drag-to-swipe added in JS) with arrows, a "n / N" counter chip (the dots
  were dropped), and a synced thumbnail strip. Photos render `object-fit: contain`
  inside a fixed 3:2 stage (4:3 on mobile) over a blurred `cover` backdrop of the same
  image, so portrait and landscape both display uncropped. Clicking a photo (or the
  expand button) opens a shared photo-only fullscreen lightbox singleton with its own
  swipe track, counter, arrows, and keyboard handling; Escape closes only the lightbox
  (capture-phase listener), and the lightbox position syncs back to the carousel on
  close. The static gallery markup in the five pages collapsed to one
  `<div data-...-gallery></div>` mount node.
- **Decision (transform):** the Supabase `full` photo variant changed from
  `1800×1200 resize:'cover'` to `1800×1800 resize:'contain'` in `js/supabase.js`. The
  other variants (`preview`/`wide`/`card`/`thumbnail`) intentionally keep `cover` — they
  feed fixed-crop boxes (cards, backdrops, thumbs) where filling is correct.
- **Why:** the pop-up photos rendered cropped/zoomed regardless of CSS because the
  storage render API was cropping server-side: every `full` URL returned exactly
  1800×1200, so portrait originals arrived pre-cropped to landscape and smaller photos
  were upscaled. No client-side `object-fit` can undo a server crop; the variant that
  feeds full-photo views must preserve the original aspect ratio.
- **Consequence:** portrait photos now arrive as e.g. 1200×1800 and are letterboxed, not
  cropped. The old cropped renders may persist in browser caches (variant URLs carry
  `cache-control: 31536000`), but the new URLs differ by query string so normal loads
  fetch fresh. `markImageOrientation`/`is-portrait` CSS hooks were removed from the
  modals (booking.js keeps orientation marking for stay-card images only). Two CSS
  gotchas are load-bearing: percentage `max-height` does not resolve inside grid `auto`
  tracks (slides are flex, the lightbox viewport is `position: absolute; inset: 0`), and
  scroll-index syncing uses a `setTimeout` debounce instead of `requestAnimationFrame`
  (rAF is suspended in hidden tabs). New `gallery.*` i18n keys exist in RO/RU/EN.

### ADR-026 — Photos are shrunk to WebP at the source; render transforms become an optimization, not the only line of defence
- **Date:** 2026-06-12.
- **Context:** every CRM photo was uploaded as its raw original — 4–14MB, 6000×4000
  JPEG/PNG phone shots — into the public `ecovila-photos` bucket. The frontend leans on
  Supabase's `/render/image/` endpoint (variant params in `js/supabase.js`
  `PHOTO_VARIANTS`) to resize on the fly, which was assumed unavailable on the project's
  plan. On inspection that endpoint does return `200` and transforms, but it still fetches
  the multi-MB original as its source, and any transform outage/quota would expose those
  originals directly.
- **Decision (upload):** `admin/js/crm-photos.js` now downscales each upload to 2000px on
  the long edge and re-encodes to WebP (q0.82) in the browser (`createImageBitmap` →
  canvas → `toBlob('image/webp')`, EXIF orientation baked in via `imageOrientation:
  'from-image'`) before it reaches storage. Animated GIFs and undecodable files pass
  through untouched. `uploadCrmPhoto` (`js/supabase.js`) forwards the `image/webp`
  content-type. 2000px keeps headroom above the 1800px `full` variant.
- **Decision (backfill):** `scripts/backfill-photos-webp.mjs` (needs `npm i --no-save
  sharp`; run with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) shrank all 83 existing
  objects **in place** — same path, same `.jpg`/`.png` name, bytes overwritten and
  `Content-Type` set to `image/webp`. ~480MB → a few MB. Done 2026-06-12 against the live
  bucket (83 shrunk, 0 failed).
- **Decision (priority):** the gallery's eager (current) carousel slide and lightbox photo
  get `fetchpriority="high"`; offscreen slides and the decorative blurred backdrop get
  `low` so they never outrank the visible photo (`js/gallery.js`).
- **Why in place, not renamed:** `publish_crm_photos()` regenerates published rows from
  drafts by copying `storage_path`, and the frontend builds every URL from
  `storage_path`. Overwriting the bytes leaves the publish flow, the DB rows, and the
  frontend untouched — Supabase serves by stored content-type, so a `.jpg`-named object
  full of WebP bytes renders correctly. The extension "lie" is cosmetic; new admin uploads
  use real `.webp` paths and will replace the legacy names as staff re-upload.
- **Consequence:** transforms now resize a ~150–500KB WebP instead of a 14MB original, and
  if transforms ever go away the originals are already small. The backfill is idempotent
  (already-WebP ≤2000px objects are skipped), so it is safe to re-run. Old big renders may
  persist in browser caches under `cache-control: 31536000`, but the site is still a
  pre-launch placeholder, so no warm cache exists yet. `sharp` is a dev-only, unsaved
  install (`node_modules/` is gitignored).
- **Related:** removed the hardcoded `fallbackPricingTiers` from `js/booking.js` in the
  same change — `state.pricingTiers` now starts empty so no guessed MDL prices can flash
  before the DB load resolves (reinforces ADR-022's "prices are never guessed" stance).

### ADR-027 — Confirmation is a celebration page; management moves to `gestionare.html`
- **Date:** 2026-06-12.
- **Decision:** the old `confirmare.html` mixed "your booking is confirmed" with cash
  timers and cancellation/refund controls. It is now split:
  - `confirmare.html` + `js/confirmare.js` is celebration-only: animated check-mark,
    "Rezervare confirmată!", a days-until-check-in countdown chip, the stay card
    (dates with 13:00/10:00 hours, nights, guests, total paid), the assigned room as a
    key-tag ("Cameră în Hotel #16"), an `.ics` calendar download, a Google Maps
    directions link, and the same included-facilities cards + photo modal as
    `rezervari.html` (reuses `facilities.js`/`gallery.js`/`booking.css`). Card returns
    from MAIB land here, show a processing panel, and the existing 5s status poll flips
    the page to the celebration when the callback marks the group paid; `payment=failed`
    and cancelled reservations get their own states.
  - `gestionare.html` + `js/gestionare.js` owns everything operational with the logic
    carried over unchanged from the old controller: cash hold countdown, one-time
    extension, pending-cash cancellation, online cancellation eligibility + refund
    notes, status badges, and the (previously missing) expired/cancelled overlay markup.
    When a reservation is paid it links back to the celebration page.
- **Routing:** cash checkouts redirect to `gestionare.html` (the booking is not
  confirmed yet); card checkouts and SMS/email "Vezi rezervarea" links keep pointing at
  `confirmare.html`, which redirects pending-cash reservations to `gestionare.html` so
  old links never strand a guest. Phone-lookup results on `rezervari.html` open
  `gestionare.html`. Both pages stay `noindex` and require `id` + `manage` token.
- **Why:** the post-payment moment should sell the anticipation ("can't wait!") and
  re-show everything the guest already paid for, while destructive actions live one
  deliberate click away instead of next to the confetti.

### ADR-028 — The repo is the source of truth for live Supabase; drift is repaired, not tolerated
- **Date:** 2026-06-12.
- **Context:** live checkout was completely broken because the live DB never received
  the `20260603090000_seo_tracking_foundation` migration (`tracking_*` columns), while
  the migration history table held ~26 auto-timestamped entries applied through other
  channels (dashboard/MCP) that didn't match the repo's files. Separately, the deployed
  `reservation-manage-details` Edge Function predated the repo's copy, so the cash
  countdown on the live confirmation page always showed `--:--`, and the
  `notification_events` check constraint was missing `guest_cancellation`, silently
  dropping guest cancellation SMS/emails.
- **Decision:** local migration files are the canonical history. The live history was
  aligned 1:1 via `supabase migration repair` (all local versions marked applied,
  duplicate/transient remote rows removed), the one remote-only migration worth keeping
  was pulled into the repo (`20260510195523_pg_cron_schedules.sql`), and all 15 Edge
  Functions were redeployed from the repo after the Deno suite passed. Targeted SQL goes
  through `supabase db query --linked`; plain `supabase db push` is safe again now that
  histories match and is the expected path for future migrations
  (`20260612160000_notification_guest_cancellation_event.sql` documents the constraint
  fix).
- **Consequence:** after adding a migration, verify it exists on live
  (`supabase migration list --linked`) instead of assuming some other channel applied
  it; Edge Functions deploy separately from DB migrations and must ship together with
  schema they depend on. (Update: the live MAIB cutover to production
  (`api.maibmerchants.md`) was completed 2026-06-13 — see ADR-041.)

### ADR-029 — Card holds expire 5 minutes after the first payment attempt and stay retryable until then
- **Date:** 2026-06-12.
- **Context:** card reservations are created `pending` and the guest is sent to MAIB.
  A declined card, or simply closing the gateway tab, used to be terminal: the
  `maib-callback` cancelled the reservation on a `failed`/`cancelled` result, so there
  was no way back, and the unconfirmed hold otherwise lingered for the old 15-minute
  session window — extended on every retry because each attempt re-stamped a fresh
  `now + 15min` deadline.
- **Decision:** a card hold lasts **5 minutes from the guest's first payment attempt**,
  and the guest can retry freely within that window:
  - **Window length + anchor.** `MAIB_PAYMENT_SESSION_MINUTES` drops 15 → 5
    (`_shared/maib.ts`). `maib-create-payment` reads the reservations' existing
    `payment_session_expires_at`: the first attempt stamps `now + 5min`, every later
    attempt **reuses that earliest deadline** instead of extending it, and a request
    after it has lapsed returns `410` rather than opening a doomed checkout. No new
    column and no cron change — the per-minute `ecovila-expire-maib-sessions` job
    (ADR via `20260527082000`) already cancels in-flight card holds once
    `payment_session_expires_at` passes, so it remains the single authority that
    releases the room.
  - **Retry stays open.** On a `failed`/`cancelled` callback, `maib-callback` marks
    only the `maib_payments` row terminal (which forces a fresh checkout on the next
    attempt, since `findReusablePayment` only reuses `created`/`pending` sessions) and
    **no longer touches the reservation** — it stays `pending` + `payment_in_progress`
    until the cron expires it. A `paid` callback still settles normally.
  - **Frontend.** `confirmare.html`/`js/confirmare.js` show a "Continuă plata" retry
    button on both the processing (closed-gateway) and failed panels; it rebuilds the
    `maib-create-payment` request from the pending-reservation blob, so checkout now
    persists `paymentRail` alongside it. The button is hidden when no matching pending
    context exists; on a lapsed window the status poll flips the page to cancelled.
- **UX:** card checkout no longer flashes "Rezervarea a fost creată. Se deschide pagina
  de plată." — the submit button stays in its "Se procesează…" loading state until the
  browser navigates to the gateway (cash still announces its redirect).
- **Why:** the guest gets the full five minutes to re-try a declined card or reopen a
  gateway they closed, without any single attempt locking the room indefinitely; an
  abandoned hold self-releases on a predictable timer.
- **Consequence:** clicking **Cancel** on the MAIB page no longer frees the room
  instantly — it is held and retryable until the 5-minute mark. Ships as Edge Functions
  only (`maib-create-payment`, `maib-callback`); the static `confirmare.html`/`js/*`
  must be uploaded together so the retry button and loading state match the backend.

### ADR-030 — A captured payment always wins against the expiry cron
- **Date:** 2026-06-12.
- **Context:** the expiry cron and the MAIB `paid` callback race in two directions.
  The cron selected expired holds and then cancelled them **by id only**, so a payment
  confirmed between its SELECT and UPDATE was flipped to cancelled. And a `paid`
  callback that arrived after the cron had already released the hold matched zero
  reservations: the guest was charged, the booking stayed cancelled, and only a
  `console.info` recorded it.
- **Decision:** the guest's money is the source of truth:
  - **Cron side.** Every cancellation UPDATE in `expire-cash-reservations`
    (`cash_expired`, `maib_session_expired`, `maib_payment_not_started`) re-asserts
    `payment_status = 'pending' and cancelled_at is null` inside the statement and
    notifies only the rows that actually flipped, so a mid-run payment can never be
    cancelled or emailed an expiry notice. `confirm-reservation-payment` carries the
    same guard.
  - **Callback side.** The `paid` branch of `maib-callback` updates with
    `.select('id')` and only notifies/tracks reservations that actually settled. If
    the cron already cancelled the hold (`maib_session_expired` /
    `maib_payment_not_started` — never guest or staff cancellations), the callback
    **reinstates** the booking group to `paid`; the `reservations_no_room_overlap`
    exclusion constraint rejects the reinstate if the room was rebooked, in which case
    the callback logs `manual refund required` via `console.error` and answers with
    `requiresManualReview: true`.
  - **Checkout side.** If `maib-create-payment` fails after the reservation rows
    exist, `js/checkout.js` no longer strands the guest on the checkout form (where a
    resubmit would collide with its own pending hold); it redirects to
    `confirmare.html`, whose status poll and ADR-029 retry button own recovery.
- **Why:** a charged card with no booking is the worst outcome the system can produce;
  every race now resolves toward "paid booking stands" with a loud, reviewable trail
  for the one unrecoverable case (room rebooked before the late payment landed).
- **Consequence:** ships as Edge Functions (`maib-callback`,
  `expire-cash-reservations`, `confirm-reservation-payment`) plus static `js/checkout.js`.

### ADR-031 — An in-flight payment attempt earns a one-minute grace before the cron frees the room
- **Date:** 2026-06-12.
- **Context:** ADR-029's hold is 5 minutes from the first attempt and the per-minute
  cron cancels the moment `payment_session_expires_at` passes. But a guest who clicks
  "Continuă plata" near the deadline is sent straight to the MAIB gateway, where card
  entry + 3-D Secure can take longer than the seconds left on the hold. The cron then
  cancels the room mid-payment; if the capture lands afterwards, ADR-030 reinstates it
  only when the room is still free, otherwise the guest is charged with no booking
  (`requiresManualReview`). The frontend retry button cannot prevent this — it navigates
  away to the gateway the instant the checkout session is created, so any button-level
  timer is invisible. The race is the cron's, so the grace has to be the cron's.
- **Decision:** `expire-cash-reservations` will not cancel an in-flight card hold whose
  booking group has a `created`/`pending` `maib_payments` row created within
  `ATTEMPT_GRACE_MINUTES` (1). It derives "recent attempt" from the existing
  `maib_payments.created_at` — **no new column, no migration** (keeps clear of the live
  DB migration drift). The grace is **bounded and un-chainable**: `maib-create-payment`
  already returns `410` for any attempt after the 5-minute hold, so no attempt timestamp
  can ever be newer than the hold deadline; the absolute maximum a room stays held is
  therefore ≈ hold + 1 minute (~6 minutes), after which the last attempt ages out of the
  window and the next cron tick frees it.
- **Why:** a guest actively on the gateway is not an abandoned room. The grace closes
  almost all of the window in which a captured payment can outrace the cron, and ADR-030's
  reinstate covers whatever slips past — together they drive the charged-but-no-room case
  toward zero while still self-releasing abandoned holds on a predictable timer.
- **Consequence:** the retry button keeps its existing on-click disable (it leaves for the
  gateway immediately, so no countdown is shown); the substance is server-side. Ships as a
  single Edge Function: `expire-cash-reservations`.

### ADR-032 — `gestionare.html` is a reservation console, not a reskinned checkout
- **Date:** 2026-06-13.
- **Context:** after ADR-027 split management onto `gestionare.html`, the page borrowed the
  checkout layout wholesale — the two-column `checkout-grid` with a read-only `co-summary`
  on the left and the status/action panels on the right. It worked but read like a payment
  form, not a place to *manage* a stay: the booking facts were buried in a labelled list,
  there was no "what you're getting" reassurance, and the visual hierarchy gave the price
  summary equal weight to the actions.
- **Decision:** rebuild the page body as a single-column **management console** while
  keeping `js/gestionare.js` and its entire data contract untouched. Top to bottom:
  1. a **stay-overview hero card** (`.gm-stay`) — the date range as a large serif headline
     with a "Sejurul tău" eyebrow, a tile grid for nights/guests/accommodation/room
     numbers, and the 13:00 check-in line;
  2. the existing **status/action panels** (cash-hold timer, card confirmation, online
     cancel/refund), unchanged in behaviour, merely rounded to match the console;
  3. **"Inclus în sejur"** — a new all-inclusive amenities grid rendered from the existing
     `accommodation.shared.facilities` translation array via a new `renderIncluded()` in
     `js/gestionare.js` (i18n-aware, re-rendered on language change inside the existing
     `renderManagedReservation` path);
  4. the **price** breakdown + total.
  Styling lives in a new `css/gestionare.css`; one new translation key
  `gestionare.included` is added in RO/RU/EN. Every `data-*` hook and `data-i18n` key the
  controller reads is preserved exactly once, so no JS state-handling changed.
- **Why:** the page's job is to make a guest feel "everything I need to manage this booking
  is right here, and I can see what's included." Leading with the stay facts and surfacing
  the all-inclusive package does that; descriptive prose was deliberately avoided because
  the section titles carry the meaning (only functionally-load-bearing copy — refund
  policy, hold-expiry warning, office hours — was kept).
- **Consequence:** purely presentational. The reused `.co-card` panels are rounded only
  within `.gm-console` scope, so `confirmare.html`/`anulare.html` are unaffected. No
  migration, no Edge Function, no change to the cash/card/refund flows.

---

### ADR-033 — Large villas bill a 4-adult floor, Friday→Saturday is a weekday, and the card is the continue CTA
- **Date:** 2026-06-13.
- **Context:** three booking-rule changes requested by the owner. (1) The large
  ("Căsuță Mare") villa was priced from a 3-adult minimum; it should bill from **4 adults**.
  (2) The premium ("weekend") rate applied to both the Friday→Saturday and Saturday→Sunday
  nights (`DEFAULT_PREMIUM_NEXT_DAYS = [6, 0]`); the Friday→Saturday night should bill as a
  normal weekday. (3) On `rezervari.html` the "De la" teaser could quote a premium night
  whenever the earliest opening landed on a weekend, and a separate bottom-right "Continuă"
  bar sat below the cards.
- **Decision:**
  1. **4-adult floor for large villas** — set `ROOM_TYPES.large.minimumAdults = 4` in
     `js/pricing.js`. The existing `calculateBillableGuests` child-promotion logic then
     fills empty adult slots with the oldest children before charging kid rates, so a party
     of 1–3 adults bills as 4 adults; 3 adults + 1 child and 2 adults + 2 children bill as
     4 adults; 3 adults + 2 children bill as 4 adults + 1 child. The CRM staff total
     (`admin/js/crm-sidebar.js`) reads `minimumAdults` from `ROOM_TYPES`, so a mixed
     small+large group now applies a combined 6-adult floor automatically.
  2. **Friday→Saturday is a weekday** — `DEFAULT_PREMIUM_NEXT_DAYS = [0]`, so a night is
     premium only when the next morning is a Sunday (the Saturday→Sunday night). Manual
     holidays still override regardless of weekday.
  3. **Weekday "De la" + per-card continue** — `calculateStayPrice` gained a `forceDayType`
     option; `js/booking.js` passes `'weekday'` for the pre-dates teaser so the headline
     price never reflects a premium night. Selecting a card flips its primary button to
     **"Continuă →"** (which routes to checkout); the standalone `.booking-continue-bar`
     and its CSS/animation were removed so no blank space is left below the cards.
- **Why:** the 4-adult floor and the Friday weekday rate are pricing-policy calls by the
  owner. Forcing the teaser to a weekday rate keeps the "from" price stable and honest
  (it can only rise with dates, never appear to drop). Folding continue into the card button
  removes a redundant, easy-to-miss control and a layout seam.
- **Consequence:** the server-side pricing guard recomputes totals from the byte-identical
  `supabase/functions/_shared/pricing.js`, so `js/pricing.js` was re-copied there and the
  `create-reservation` Edge Function **redeployed** (project `mckchrviaawdxtsfytut`) in the
  same change — client and server must agree or quotes 409. The static site must be uploaded
  to TopHost (`npm run prepare:tophost`) to close the window where the live front-end still
  quotes the old rules against the new guard. Tests in `tests/booking-core.test.mjs`,
  `tests/booking-page.test.mjs`, and `tests/admin-crm.test.mjs` were updated to the new
  floors/day-types; the node baseline of 11 maintenance-placeholder failures is unchanged.

---

### ADR-034 — Gallery thumbnails wrap under the photo; checkout phone pre-fills a deletable +373 that always keeps its +
- **Date:** 2026-06-13.
- **Context:** two owner-requested UX changes. (1) In every detail pop-up (accommodation
  and facility), the thumbnail strip under the main photo was a single horizontal row that
  scrolled left↔right (`overflow-x: auto`), so most photos were off-screen and hard to reach.
  The owner wanted all thumbnails visible at once, **under** the photo, like a booking site.
  (2) On `checkout.html` the phone field only carried `+373` as a placeholder; the owner
  wanted `+373` pre-written (but deletable), with a rule that the number always starts with `+`.
- **Decision:**
  1. **Wrapping thumbnail grid** — in `css/booking.css`, `.ev-gallery__thumbs` switched from
     `display: flex; overflow-x: auto` to `display: grid;
     grid-template-columns: repeat(auto-fill, minmax(76px, 1fr))` (64px on mobile). Every
     thumbnail stays visible, wrapping into as many rows as needed with no horizontal or
     vertical scroll. `.ev-gallery` reverted to its stacked grid (stage above, thumbs below).
     No JS change — clicking a thumb still jumps the carousel and the active one keeps its
     green border. Because `js/gallery.js` + `booking.css` are the one shared gallery
     component, the change is site-wide (`rezervari.html`, `site.html`, `confirmare.html`,
     `en/`, `ru/`).
  2. **Deletable +373 with enforced leading +** — `checkout.html` gained `value="+373"` on the
     phone input (placeholder kept). `js/checkout.js` added `enforcePhonePlus(phoneInput)`,
     run on every `input`: it strips any `+` and re-adds a single leading one
     (`rest ? '+'+rest : ''`), so the field can be cleared to empty (deletable) yet any typed
     content always begins with `+`; caret is kept at the end when editing there.
- **Why:** the wrapping grid matches the familiar booking-site pattern and makes every photo
  one tap away. Pre-filling `+373` saves the most common country code while staying editable;
  the leading-`+` rule keeps phones in the E.164 shape the `INTERNATIONAL_PHONE_PATTERN`
  validator and the MIA/card rail detection (`getPaymentRail`) already expect.
- **Consequence:** pre-filling `+373` means the default online payment rail now resolves to
  **MIA** instead of card on first load (it was `card` for an empty field), updating to the
  correct rail as soon as the guest types their real number. The prior test
  "keeps the checkout phone prefix as a placeholder instead of a submitted default" encoded
  the opposite decision and was rewritten in `tests/checkout.test.mjs` to assert the
  pre-filled value and the enforcement helper. Pure front-end change — no Edge Function or
  pricing-guard impact; the static site still needs a TopHost upload
  (`npm run prepare:tophost`) to go live. The node baseline of 11 maintenance-placeholder
  failures is unchanged.

### ADR-035 — Online cancellation advance window raised from 7 to 20 calendar days
- **Date:** 2026-06-13.
- **Context:** owner asked to lengthen the minimum free-cancellation lead time site-wide.
  ADR-008 set the guest online-cancellation advance window at **7** calendar days (with a
  2-hour post-booking grace). The number was hard-coded in three independent layers (client
  JS, the Edge Function shared module, and the `cancel_reservation_by_token` RPC) plus
  copy in three languages.
- **Decision:** the advance window is now **20** calendar days. The 2-hour creation-grace
  window and the cash-office rule (ADR-008) are unchanged.
  - **Server (source of truth):** `supabase/functions/_shared/reservationManage.ts` now
    exports `REFUND_ADVANCE_DAYS = 20` and uses it in `isRefundEligible` /
    `refundEligibilityReason`; `reservation-cancel/index.ts` mirrors the wording. A new
    migration `20260613090000_cancellation_advance_window_20_days.sql` redefines
    `cancel_reservation_by_token` with `v_days_until_arrival >= 20`. Per ADR-028 the prior
    applied migration (`20260531083527`) was left untouched and superseded by a new one.
  - **Client mirror:** `js/anulare.js` (`>= 20`) and all refund-policy copy in
    `js/translations.js` (RO/RU/EN), `anulare.html`, `termeni-conditii.html`,
    `gestionare.html`, and the confirmation email line in `_shared/notifications.ts`
    (`Anulare 20 zile+`).
  - **New checkout reassurance note:** `checkout.html` gained a subtle, muted, centered
    line under the submit button (`checkout.cancellationNote`, class `.co-policy-note`)
    phrased as a *benefit* — "Flexible plans: free online cancellation if at least 20 days
    remain before your arrival date" — so the longer window reads as flexibility rather
    than a restriction.
- **Why:** business policy change requested by the owner; surfacing it positively at
  checkout sets expectations up front without depressing conversion.
- **Consequence:** only two Edge Functions actually exercise the changed behaviour —
  `reservation-cancel` (eligibility guard) and `confirm-reservation-payment` (the
  confirmation email) — and both were redeployed via the CLI; the migration was pushed with
  `supabase db push`. Other importers of the shared module use unrelated exports and were
  left as-is. Tests were rebased to 20-day fixtures (`reservation-manage.test.ts`,
  `reservations.test.ts`, `anulare.test.mjs`, `legal-pages.test.mjs`); the Deno suite is
  48/48 green and the node baseline of 11 maintenance-placeholder failures is unchanged.
  The static front-end still needs a TopHost upload (`npm run prepare:tophost`) to go live;
  the backend (DB + functions) is already deployed.

### ADR-036 — Booking-confirmation SMS: parenthesized stay window, full-letter months, RU as 2 segments
- **Date:** 2026-06-13.
- **Context:** owner supplied a target layout for the confirmation SMS — the check-in/out
  hours should sit in parentheses next to each date (`27 Septembrie 2026 (13.00) - 28
  Septembrie 2026 (10.00)`) rather than as trailing `, 13.00`/`, 10.00`. The Romanian
  message was the reference; English shared the same long structure, and Russian had been
  deliberately squeezed into one UCS-2 segment using abbreviated months (`сен`).
- **Decision:** all three languages in `bookingConfirmationSms()`
  (`supabase/functions/_shared/notifications.ts`) now use the `{date} (13.00) - {date}
  (10.00)` layout with **full-letter month names**. Russian was allowed to grow to **two
  SMS segments** so it can carry the full sentence (`Ваша бронь подтверждена: … Доступ на
  территорию: после 13.00. Ждём вас!`, ~121 UCS-2 chars), dropping the abbreviated-month
  path for confirmations. RO/EN stay within a single GSM-7 segment (≤135 chars). The
  abbreviated-month helper is retained because the **cancellation** SMS still uses it.
- **Why:** owner-requested copy/format change for clarity and brand voice.
- **Consequence:** test assertions in `reservations.test.ts` were rebased to the new
  strings (RU `maxLength` raised to 140). Four importers of the shared module
  (`confirm-reservation-payment`, `send-reminders`, `expire-cash-reservations`,
  `reservation-cancel`) were redeployed via the CLI.

### ADR-037 — Card-payment confirmation SMS was a stale inline duplicate
- **Date:** 2026-06-13.
- **Context:** after ADR-036 a real card booking still produced the **old** SMS. Root
  cause: `maib-callback/index.ts` (the maib payment callback, the path card-payers take —
  *not* `confirm-reservation-payment`) carried its **own** `confirmationSms()` copy with the
  pre-ADR-036 comma layout, and it injected **raw ISO dates** (`2026-09-27`) because it
  never called the shared date formatter.
- **Decision:** delete the inline `confirmationSms()` and call the now-exported canonical
  `bookingConfirmationSms()` from `_shared/notifications.ts`, so the cash and card paths
  share one template and date formatter.
- **Why:** a single source of truth prevents the two confirmation paths from drifting; the
  duplicate is exactly what made ADR-036 look like it had no effect.
- **Consequence:** `bookingConfirmationSms` is now `export`ed (no behaviour change for the
  four functions already redeployed under ADR-036). `maib-callback` was redeployed via the
  CLI. A genuine end-to-end test still requires a real card booking on ecovila.md (or a
  staff-authenticated `send-sms` call) — the SMS provider token and staff JWT are not
  available outside the deployed environment.

### ADR-038 — Automated email sends from noreply@, replies routed to rezervari@ via Reply-To
- **Date:** 2026-06-13.
- **Context:** the `ecovila.md` domain was being verified on Resend so transactional mail
  (booking confirmations, cash-expiry reminders, cancellations) sends authenticated. With
  25 villas the owner did not want to lose a hand-written reply in a flood of automated
  mail, so automated mail should carry a distinct `noreply@` identity while guest replies
  still land in the monitored `rezervari@ecovila.md` inbox.
- **Decision:**
  - `RESEND_FROM_EMAIL` set to `noreply@ecovila.md` (rendered as `EcoVila <noreply@…>` by
    `sendEmail`). Any `@ecovila.md` address works once the domain is verified — Resend
    verifies the domain, not the mailbox.
  - `sendEmail` (`_shared/providers.ts`) now adds a `reply_to` field when the new optional
    `RESEND_REPLY_TO` secret is set; it is set to `rezervari@ecovila.md`. Reply-To is used
    instead of relying on inbound forwarding because it routes replies directly from the
    guest's mail client regardless of MX/forwarder state.
  - A cPanel forwarder `noreply@ecovila.md → rezervari@ecovila.md` is configured as a
    belt-and-suspenders for mail manually addressed to noreply@.
- **Why:** keeps the sending identity clearly automated without orphaning replies; Reply-To
  is more robust than inbound forwarding and needs no inbound mail plumbing.
- **Consequence:** six email-sending functions were redeployed (`confirm-reservation-payment`,
  `send-reminders`, `expire-cash-reservations`, `reservation-cancel`, `maib-callback`,
  `send-email`). Secret value changes alone don't need a redeploy, but the `reply_to` code
  change did. `.env.example` documents `RESEND_REPLY_TO`. Tests unchanged (25/25 Deno green);
  the email-payload test does not assert on reply_to.

### ADR-039 — Confirmation & cancellation emails: premium card layout, fully localized, re-book CTA
- **Date:** 2026-06-13.
- **Context:** booking-confirmation and cancellation emails were raw `<!doctype><h1>+<table>`
  bodies (`reservationEmailHtml`) with Romanian-only copy, raw ISO dates, unformatted prices,
  and lowercase guest names — well below the hospitality bar the SMS already met. A ChatGPT
  brief proposed a branded card layout; it was used as direction only (its `tel:+373060120220`
  had a stray leading zero, its `#2f5f38` greens were guesses, and its tagline "Natură.
  Relaxare. Voi." was off-brand).
- **Decision:**
  - New shared, table-based, inline-styled premium renderer `renderReservationEmail` plus
    `buildConfirmationEmail` / `buildCancellationEmail` in `_shared/notifications.ts`, exported
    so the real cancel path (`reservation-cancel/index.ts`, which owns a *separate inline*
    `composeCancellationConfirmation` — same duplication shape as ADR-037) reuses them.
  - Both emails are localized ro/ru/en off `guest_language` (subjects, headings, labels,
    arrival card, closing, and CTAs), matching the SMS approach. Dates render human-readable
    (`20 iunie 2026`, `20 июня 2026`, `20 June 2026`), nights use correct plurals (incl. the
    Russian 1/2-4/5+ rule), prices group thousands with a space (`3 600 MDL`), and guest names
    are title-cased.
  - Confirmation keeps a green ✓ badge, primary `Vezi rezervarea` button → `confirmare.html`,
    secondary `Anulează rezervarea` text link, and an arrival-info card (access after 13:00,
    check-in 13:00, check-out 10:00, phone `+373 60 120 220` → `tel:+37360120220`).
  - Cancellation gets a cocoa ✕ badge and a primary **`Rezervează din nou` / `Забронировать
    снова` / `Book again`** CTA → `${siteUrl}/rezervari.html`. Brand palette pulled from the
    site (`--booking-green #5F7A3A`/`#4B6529`, paper `#F7F4EF`, cocoa `#8B7564`); logo is the
    absolute `${siteUrl}/assets/logo.png`.
  - Plain-text fallbacks regenerated per language (the ro confirmation text keeps the
    `Anulare 20 zile+:` label the test asserts on). The legacy `reservationEmailHtml` stays
    for the three unchanged reminder/expiry emails.
  - **Card-payment confirmation unified (the primary online flow):** `maib-callback`'s own
    inline `composePaymentConfirmation` (old `<!doctype><h1>+<table>` layout — the same
    ADR-037 duplication trap) now delegates its email to `buildConfirmationEmail`, so
    card-paying guests get the identical premium email as the staff/cash path. Its dead
    `subjectLine`/`greeting`/`label`/`row`/`escapeHtml`/`escapeAttribute` helpers were removed.
  - **Email footer trimmed:** the footer line is now just `EcoVila` (the
    `str. Aerodromului 3, Orheiul Vechi` address was dropped from every email/language).
  - **Cancellation SMS localized + reworded** (was Romanian-only inline copy in
    `reservation-cancel`): the exported `cancellationConfirmationSms({checkIn, checkOut,
    language})` is now the single source for both the notifications.ts and reservation-cancel
    paths. Copy is `Rezervarea dvs este anulata: 20 Septembrie 2026 - 21 Septembrie 2026.
    Speram sa ne mai vedem in curand!` (ro, GSM-7, 1 segment / ~103 chars), localized to ru
    (`Ваша бронь отменена: … Надеемся снова увидеть вас!` — UCS-2, 2 segments / ~85 chars,
    within the 140-char budget the owner approved) and en (1 segment). Full-letter capitalized
    months per ADR-036; `reservation-cancel`'s duplicate `formatSmsPeriod`/`formatSmsDate`/
    `smsMonthName` removed.
- **Why:** confirmations and cancellations are the two guest-facing transactional emails;
  premium, on-brand, localized rendering matches the SMS quality and the all-inclusive
  positioning. Sharing one renderer/SMS helper avoids the stale-duplicate trap ADR-037
  documented — and the card flow is what most guests actually hit.
- **Consequence:** deployed `maib-callback`, `confirm-reservation-payment`, and
  `reservation-cancel` via `supabase functions deploy` (project `mckchrviaawdxtsfytut`,
  versions 11 / 19 / 8, all ACTIVE 2026-06-13). All three import the new builders/SMS helper
  via `_shared/notifications.ts`. The cancellation-SMS test now covers ro/ru/en with segment
  budgets; 48/48 Deno tests green.

---

### ADR-040 — CRM Prețuri gains a read-only "Program" sub-view showing price timeframes
- **Date:** 2026-06-13.
- **Context:** `pricing_tiers` rows carry only an `effective_from`; each save snapshots all six
  tier/day-type rows at one date and the newest row effective on/before a booking's creation
  date wins (see project-overview "Pricing effective dates"). Staff could edit and see the
  *currently active* tariffs (`activePricingRows` = newest set with `effective_from <= today`)
  but had no way to see **when** a scheduled future change takes over from the current one, or
  the date ranges any set of prices is in force. The dashboard markup even carried an unused
  `data-upcoming-prices` stub for this.
- **Decision:**
  - The Prețuri panel now has a two-button segmented toggle (`data-price-view` → `edit` /
    `schedule`) that swaps between the existing editor+holidays grid (`data-price-view-panel="edit"`)
    and a new read-only **Program** view (`data-price-view-panel="schedule"`). "Tab" within a
    panel, not a new top-level CRM tab — it lives "under" Prețuri as the owner asked.
  - New pure helper `pricingSchedule(rows)` in `admin/js/crm-pricing.js`: it collects the
    distinct `effective_from` dates as boundaries, resolves the active price set as-of each
    boundary (shared `resolveActiveRows(rows, asOf)`, factored out of `activePricingRows`),
    and emits ordered segments `{from, until, prices, isCurrent/isFuture/isPast}`. `until` is
    the day before the next boundary (`dayBeforeISO`, UTC) and `null` (= "în continuare") for
    the open-ended last segment. Consecutive segments with identical prices are collapsed.
  - `renderPricingSchedule` lists each timeframe as a card titled `DD.MM.YYYY – DD.MM.YYYY`
    (`formatScheduleDate`) with a read-only copy of the six-row price table; the current period
    gets a green highlight + `Activ acum` badge, future periods a `Programat` badge.
  - No schema, RPC, or data-layer change — it reuses `fetchPricingTiers` (which already selects
    `effective_from, created_at`). Purely additive client rendering; existing reservations are
    still never retro-repriced.
- **Why:** the owner schedules seasonal price changes ahead of time and needs to see the exact
  window each tariff is in force before the next change overwrites it. The active-prices table
  alone hid the timeline.
- **Consequence:** `admin/dashboard.html` (toggle + schedule container, removed the dead
  `data-upcoming-prices` stub), `admin/js/crm-pricing.js`, and `css/crm.css` updated. Five new
  Node contract tests in `tests/admin-crm.test.mjs` (timeframe split, identical-price collapse,
  date helpers, markup contract); full Node suite green (58 tests in `admin-crm.test.mjs`).

### ADR-041 — Production launch: MAIB live cutover + homepage swap off the maintenance placeholder
- **Date:** 2026-06-13.
- **Context:** the owner received production MAIB credentials. Until now `MAIB_BASE_URL`
  + credentials pointed at the sandbox (ADR-028), and the root `index.html` was the
  noindex "în lucru" maintenance placeholder (commit `2fd661c`) while the real landing
  was staged on `site.html`.
- **Decision — MAIB:** the production credentials were set as Supabase Edge Function
  secrets by the owner (not committed). `MAIB_BASE_URL` was set to
  **`https://api.maibmerchants.md`** — the maib e-Commerce Checkout API production host
  (our `_shared/maib.ts` appends `/v2/auth/token`, `/v2/checkouts`,
  `/v2/payments/{id}/refund`; sandbox host is `sandbox.maibmerchants.md`, confirmed
  against the official `maib-ecomm` SDK). `maib-create-payment`, `maib-callback`, and
  `maib-refund` were redeployed so they cold-start on the new secret. Host/path validated
  with an unauthenticated probe returning a structured maib `401` (`Invalid credentials`),
  the exact error shape `formatMaibError` parses. The live end-to-end card payment +
  refund remains the owner's smoke test (only the owner holds the credentials).
- **Decision — homepage:** the maintenance placeholder was removed by promoting the full
  Romanian landing to `index.html` (absolute `/js/…` + `/rezervari.html` links, canonical
  `https://ecovila.md/`, indexable). `site.html` was restored to its last-good relative-link
  form (commit `8427717`) — `2fd661c` had accidentally overwritten it with the absolute
  index copy, which is why the landing/SEO/legal/consent/wiring suites stayed red. The
  `maintenance-page.test.mjs` "approved launch homepage" contract now passes for both files
  (root absolute; `site.html` relative + `^site\.html$ → /` 301).
- **Decision — stale-test/cleanup:** the managed-cancellation SMS test was rewritten to the
  ADR-039 contract (copy now lives in `_shared/notifications.ts` `cancellationConfirmationSms`,
  not inline in `reservation-cancel`). The obsolete `booking-accommodation-lead` test (the
  element was removed in ADR-033 when availability moved to per-card `data-card-availability`)
  was deleted along with its orphaned `css/booking.css` rule. `deno.json` now excludes
  `_shared/pricing.js` and `tests/pricingGuard.test.ts` from `deno fmt` — the former MUST stay
  byte-identical to `js/pricing.js` (ADR pricing guard), so excluding it from fmt protects that
  invariant from a future `deno fmt` silently breaking server-side pricing.
- **Consequence:** full suite green (216 Node + 48 Deno), typecheck/lint/fmt clean,
  `js/pricing.js` ≡ `_shared/pricing.js` verified. The static bundle still needs the manual
  TopHost upload (`npm run prepare:tophost` → `dist/tophost/`); the live site was last
  uploaded before this swap, so until the owner uploads, prod `/` still shows the old state.

### ADR-042 — Keep the admin CRM out of search indexes (`noindex` on admin pages)
- **Date:** 2026-06-15.
- **Context:** a pre-launch review found the CRM pages indexable. `robots.txt` disallows
  `/admin/` only under the wildcard `User-agent: *` group; the explicit per-bot groups
  (`Googlebot`, `Bingbot`, `YandexBot`, …) repeat just `Allow: /`. Per the robots.txt
  precedence rule a crawler obeys only its most specific matching group, so those named
  bots never see the `/admin/` disallow and were free to crawl — and, with no page-level
  directive, index — `admin/index.html` (the CRM login) and `admin/dashboard.html`. Not a
  data-exposure risk (CRM data is RLS-protected and unreadable by `anon`), but the login
  page could surface in search results.
- **Decision:** add `<meta name="robots" content="noindex, nofollow">` to the `<head>` of
  both admin pages (right after the viewport meta). A page-level `noindex` is the robust
  fix here because the named bots *do* crawl `/admin/` and will therefore read and obey it;
  it keeps working regardless of which `robots.txt` group a crawler picks. `robots.txt`
  was left unchanged.
- **Why:** the CRM is staff-only and should never appear in public search; `noindex` is the
  authoritative signal and closes the per-bot-group gap without restructuring `robots.txt`.
- **Consequence:** [admin/index.html](../admin/index.html) and
  [admin/dashboard.html](../admin/dashboard.html) updated; a new contract test in
  `tests/admin-crm.test.mjs` ("keeps the admin CRM out of search indexes") asserts the
  `noindex` meta on both pages. Re-run `npm run prepare:tophost` so the bundle ships it.

---

### ADR-043 — GA4 analytics on all public pages via the existing consent-gated tracking module
- **Date:** 2026-06-16.
- **Context:** the owner wants Google Analytics 4 (Measurement ID `G-QWJXK651PP`) on
  every public page but not on the admin CRM. The site already ships a consent-aware
  tracking module ([js/tracking.js](../js/tracking.js), `EcoVilaTracking`) that is loaded
  on all 12 public pages (RO root pages + `ru/` + `en/`) together with
  [js/tracking-config.js](../js/tracking-config.js); the admin pages
  (`admin/index.html`, `admin/dashboard.html`) load neither, so they are already excluded
  by construction. The module auto-loads `gtag.js` and fires `page_view` whenever
  `googleMeasurementId` is set — the field was an empty placeholder waiting for the ID.
  The cookie banner (ADR for consent v2) exposes distinct **analytics** and **marketing**
  toggles, but the module gated the Google tag on **marketing**, which is wrong for an
  analytics product: a visitor who accepts analytics-only cookies would not be measured.
- **Decision:** (1) set `googleMeasurementId: 'G-QWJXK651PP'` in `tracking-config.js`
  rather than hard-coding the raw `gtag` snippet into each page — this reuses the one
  loader, avoids double-counting `page_view`, and keeps admin excluded for free.
  (2) Gate the GA4 tag on the **analytics** consent category (new
  `consentAllowsAnalytics()`), keep the Meta Pixel + server CAPI + Google Ads `conversion`
  events on **marketing**, and split `trackPageView()` so each channel fires under its own
  consent with its own dedupe set. (3) Send granular Google Consent Mode signals
  (`analytics_storage` from the analytics toggle; `ad_storage`/`ad_user_data`/
  `ad_personalization` from marketing) instead of granting everything.
- **Why:** consent-gating an analytics tool to the analytics toggle is the legally correct
  and user-expected behaviour for a Moldova/EU-facing site with a CMP; the raw unconditional
  snippet would have bypassed the banner and duplicated the existing loader.
- **Consequence:** [js/tracking-config.js](../js/tracking-config.js) and
  [js/tracking.js](../js/tracking.js) updated; behaviour documented in
  [docs/ANALYTICS.md](ANALYTICS.md). Verified in-browser: under analytics-only consent
  `gtag.js?id=G-QWJXK651PP` loads and a `page_view` hit reaches GA4
  (`/g/collect … en=page_view`, Consent Mode `gcs=G101`, `npa=1`), while the Meta Pixel
  stays off. All 218 node tests pass. Re-run `npm run prepare:tophost` so the bundle ships
  the new ID, and confirm realtime traffic in the GA4 property after upload.

---

### ADR-044 — Booking "Vreau așa căsuță" calendar parity, details-modal Select fix, and a no-cache dev server
- **Date:** 2026-06-16.
- **Context:** on [rezervari.html](../rezervari.html) the "Vreau așa căsuță" (sold-out /
  "want this type") flow opened a `[data-soldout-modal]` whose calendar was a flat vertical
  list of full-date chips ("15 iun.", "16 iun."…), visually unlike the main check-in/check-out
  picker, which is a Monday-aligned month grid. Three follow-ups surfaced: (a) a selected date
  in that modal rendered **white** instead of the picker's green, because the `--booking-green`
  palette was scoped to `.booking-page` while the modals live at `body` level and could not
  resolve the variable; (b) the modal close control was a literal brown "ÎNCHIDE" text button;
  (c) clicking **Selectează** in the villa **details** modal reloaded the page instead of
  selecting the villa.
- **Decision:** (1) rebuild `renderSoldoutCalendar` ([js/booking.js](../js/booking.js)) as the
  same 42-cell month grid as `renderCalendar`, with prev/next nav (`soldoutMonth` state, prev
  disabled in the current month) and the picker's day-cell classes; the modal markup reuses the
  `.calendar` structure with a new `.calendar--modal` modifier ([css/booking.css](../css/booking.css))
  that renders it inline (static, no dropdown frame). (2) Move `--booking-green` /
  `--booking-green-dark` / `--booking-soft` from `.booking-page` onto `body.page-booking` so the
  body-level modals inherit them (fixes the white selected cell). (3) Convert the brown
  `.booking-modal__close` text buttons to square "×" icon buttons, keeping the brown background.
  (4) Make the details-modal reserve button two-state (`syncDetailsReserve`): first click selects
  the type and flips the label to "Continuă" with the modal staying open, second click runs
  `reserveType` → checkout. (5) **Root cause of the reset:** [js/main.js](../js/main.js)
  `initializeAccommodationModal()` runs on every page and bound a *second* click handler to
  `[data-booking-modal-reserve]` doing `window.location.href = 'rezervari.html'` — intended for the
  landing-page preview modal (index/site), but it also fired on the booking page and reloaded it.
  Gate that initializer to return early on `body.page-booking`, where booking.js owns the modal.
  (6) Replace the local dev server `python -m http.server` with [scripts/dev-server.py](../scripts/dev-server.py),
  which sends `Cache-Control: no-store`.
- **Why:** a single consistent month-grid picker beats two different date UIs; CSS custom
  properties must be in scope for the elements that consume them; and the duplicate landing-page
  handler was silently hijacking the booking page. The reset only reproduced on a *real* click —
  the navigation is async, so a synthetic `.click()` reads state before it fires, which is why it
  was initially missed. The bare static server only sent `Last-Modified`, so browsers
  heuristically cached JS/CSS and served stale code after every edit.
- **Consequence:** [rezervari.html](../rezervari.html), [css/booking.css](../css/booking.css),
  [js/booking.js](../js/booking.js), [js/main.js](../js/main.js) updated;
  [scripts/dev-server.py](../scripts/dev-server.py) added (`.claude/launch.json`, gitignored,
  points at it). Verified in-browser with real clicks via the Navigation API: the details-modal
  Select now selects + flips to "Continuă" without navigating, and a second click with dates goes
  to `checkout.html`; the soldout calendar matches the main picker with green selection and an "×"
  close. Re-run `npm run prepare:tophost` before the next TopHost upload.

---

### ADR-045 — Checkout payment options: unified "Plată online" label + cash 30-minute confirmation modal
- **Date:** 2026-06-16.
- **Context:** the checkout payment picker ([checkout.html](../checkout.html)) showed one
  online-payment button whose label switched between "Plată online prin MIA" (for `+373` numbers,
  routed to the MIA rail) and "Plată cu cardul" (international, card rail) via
  `getOnlinePaymentCopy` / `getPaymentRail` in [js/checkout.js](../js/checkout.js). Surfacing the
  rail name to guests was needless implementation detail. Separately, the **cash** option only
  showed a passive inline disclaimer *after* selection, so a guest could choose cash without
  registering that the hold expires in 30 minutes — the most common no-show / expired-reservation
  pitfall.
- **Decision:** (1) Relabel both online-payment i18n keys (`checkout.payMia`, `checkout.payCard`)
  to a single neutral "Plată online" / "Онлайн-оплата" / "Pay online" across all three languages
  ([js/translations.js](../js/translations.js)); the rail-selection logic is left untouched, so the
  correct processor (MIA vs card) is still chosen behind the scenes by phone prefix — only the
  visible label changed. (2) Add a light-red confirmation modal that intercepts the **cash**
  selection: clicking "Plată cash" now opens a `[data-cash-modal]` dialog
  ([checkout.html](../checkout.html)) that reuses the existing `checkout.cashDisclaimer` wording
  verbatim and requires "Am înțeles, continui" before cash is actually selected; "Anulează", the
  scrim, or Esc cancel and leave the previously selected method in place. New keys
  `checkout.cashModalTitle` / `cashModalCancel` / `cashModalConfirm` (RO/RU/EN). Styling lives in
  [css/checkout.css](../css/checkout.css) (`.co-cash-modal*`): light-red panel `#FDECEA` with a
  `#C0392B` accent border/icon, blurred scrim, `body.co-modal-open` scroll-lock, single-column
  buttons under 480px, and a reduced-motion fallback.
- **Why:** the rail name ("MIA" / "card") is an implementation detail guests do not need, and one
  "Plată online" label reads cleaner while the backend still routes correctly. The cash hold needs
  an explicit acknowledgement rather than a note that is easy to miss, which should cut expired and
  abandoned cash reservations. The modal reuses the exact on-site disclaimer text so the 30-minute
  rule has a single source of truth.
- **Consequence:** [checkout.html](../checkout.html), [css/checkout.css](../css/checkout.css),
  [js/checkout.js](../js/checkout.js), [js/translations.js](../js/translations.js) updated. Verified
  in-browser (desktop + mobile): the online options render "Plată online"; selecting cash opens the
  modal, Confirm selects cash and reveals the inline disclaimer, Cancel/Esc/scrim keep online
  payment, and re-clicking cash when already selected does not re-prompt. Re-run
  `npm run prepare:tophost` before the next TopHost upload.

---

### ADR-046 — CRM finance day-list groups villas by reservation; dashboard cards show booking total instead of guest name
- **Date:** 2026-06-16.
- **Context:** two owner-facing CRM views split multi-villa bookings into per-villa rows.
  (a) The Finance tab's "Vile rezervate în ziua selectată" list
  ([admin/js/crm-finance.js](../admin/js/crm-finance.js)) rendered one card per villa row, so a
  single booking that reserved villas #7/#8/#17 showed as three separate cards with split prices —
  it read as three reservations, and the count badge counted villas, not bookings.
  (b) The main dashboard calendar ([admin/js/crm-dashboard.js](../admin/js/crm-dashboard.js)) titled
  every reservation block with the guest name/surname, surfacing no financial figure.
  Key data-model facts (from [js/checkout.js](../js/checkout.js)): for a multi-villa booking,
  `total_price` is **split** across the villa rows (sum = booking total), while `adults`/`kids_ages`
  store the **whole-booking party repeated on every row**, and `check_in`/`check_out`/nights are
  identical across the group.
- **Decision:** (1) Finance day-list — carry `booking_group_id` on normalized rows and add
  `groupBookedDayRows()` that collapses rows by `booking_group_id` (falling back to `id`). It
  **sums** `total_price` for the shared booking total but reads party/nights/dates **once** (not
  summed) to respect the data model. `renderBookedDayRows` now renders one card per *reservation*:
  single-villa bookings keep the original one-row grid (no regression); multi-villa bookings render
  a summary row (`N vile · party · nights · stay · shared total · booked-at · status`) plus a
  per-villa breakdown (villa #, room type, per-villa price) under a dashed divider. The count badge
  now counts reservations; heading/empty copy changed from "Vile rezervate" to "Rezervări create".
  Shared grid styles + `.crm-finance-booked-card--group` / `__summary` / `__villas` added to
  [css/crm.css](../css/crm.css). (2) Dashboard calendar — `reservationCard(context, block)` now
  titles each block with the booking total (`block.reservations` summed `total_price`, via
  `context.formatMDL`) instead of the guest name; the adults·copii and phone lines are unchanged.
- **Why:** a booking that reserves several villas is **one** reservation with one total; the old
  per-villa split misrepresented both the reservation count and the money. Because the party is
  stored per-booking (repeated) it must be read once, and because the price is split it must be
  summed — getting this backwards would double-count guests or under-count revenue. On the calendar,
  the amount paid is the figure the owner scans for; the guest is still identifiable by phone and via
  the edit dialog.
- **Consequence:** [admin/js/crm-finance.js](../admin/js/crm-finance.js),
  [admin/js/crm-dashboard.js](../admin/js/crm-dashboard.js), [admin/dashboard.html](../admin/dashboard.html),
  [css/crm.css](../css/crm.css), and [tests/admin-crm.test.mjs](../tests/admin-crm.test.mjs) updated
  (new grouping test; normalize-shape test gains `bookingGroupId`; calendar-card XSS test asserts the
  total renders and the name does not). Guest names are unchanged in the pending-cash sidebar, the
  daily reception view, sidebar search results, and the edit-reservation dialog. Verified in-browser
  with throwaway harnesses that load the real modules + `css/crm.css` against mock grouped data: the
  Finance day-list collapses 7 villa rows into 4 reservations with summed totals (20.000 / 16.300 MDL)
  and per-villa breakdowns; the calendar cards show booking totals (single and summed multi-villa,
  e.g. rooms 11–13 → 15.000 MDL) with no guest names. Re-run `npm run prepare:tophost` before the next
  TopHost upload.

---

### ADR-047 — Dashboard calendar colour-codes scattered (non-adjacent) multi-villa bookings
- **Date:** 2026-06-16.
- **Context:** `buildReservationBlocks` ([admin/js/crm-calendar.js](../admin/js/crm-calendar.js))
  merges a booking group's **contiguous** villas into one spanning box, so a booking on rooms
  3–5 reads clearly as a single reservation. But a group on **non-adjacent** villas (e.g. 3, 6, 8)
  splits into separate one-cell blocks that look like independent bookings — there is no visual cue
  tying them together, and the same is true for a group whose villas have split date ranges.
- **Decision:** add a booking-group accent-colour layer in [admin/js/crm-dashboard.js](../admin/js/crm-dashboard.js).
  New `assignGroupColors(blocks)` buckets the rendered blocks by `booking_group_id` and colours only
  groups that render as **2+ blocks** (single-villa bookings and contiguous "big box" groups keep
  their normal status fill — colour is strictly the fallback for "cannot unify by spanning"). Colour
  choice is a greedy interval-colouring sorted by stay start: each group takes the colour least used
  by groups whose stay **overlaps in time**, which keeps every group distinct *within a day* while
  letting colours repeat freely across non-overlapping days. With ≤5 simultaneously-overlapping
  groups this is always collision-free; beyond 5 it degrades to the least-used colour instead of
  failing. `reservationCard(context, block, groupColorClass)` applies the group colour over the
  status fill, **except cancelled cards**, which stay grey (cancelled is operationally important and
  only shown via the show-cancelled toggle). Five new unused palette vars
  (`--crm-group-1..5`: orange / teal / blue / magenta / brown) in [css/crm.css](../css/crm.css),
  chosen to be mutually distinct and distinct from the existing paid-card/paid-cash/pending/cancelled
  colours; white text on all five. The group rules are ordered after the status fills so the accent
  overrides paid/pending backgrounds (cancelled keeps precedence because the class is simply not
  applied to cancelled cards).
- **Why:** colour is the natural analogue of the spanning box for the case where spanning is
  impossible — same colour within a day means same reservation. The per-day-distinct / cross-day-reuse
  rule keeps a busy day legible without needing an unbounded palette. Cash holds still show their
  in-card countdown and cancelled stays stay grey, so no operational state is lost by recolouring.
- **Consequence:** [admin/js/crm-dashboard.js](../admin/js/crm-dashboard.js),
  [css/crm.css](../css/crm.css), and [tests/admin-crm.test.mjs](../tests/admin-crm.test.mjs) updated
  (two new tests: scattered villas 3/6/8 share one colour while a single-villa booking gets none; and
  overlapping groups stay distinct while a non-overlapping group reuses a colour). Verified in-browser
  with a harness loading the real modules + `css/crm.css`: three overlapping non-adjacent bookings
  rendered orange / teal / blue (distinct same-day), a contiguous 6–8 booking stayed one green box,
  and a later non-overlapping booking reused orange — white text legible throughout, no console
  errors. Re-run `npm run prepare:tophost` before the next TopHost upload.

---

### ADR-048 — Admin CRM persists the active tab in the URL hash so a refresh stays on the same view
- **Date:** 2026-06-16.
- **Context:** the admin CRM ([admin/dashboard.html](../admin/dashboard.html)) is a single-page
  tabbed shell (Dashboard / Finance / Situația zilnică / Ștergare / Poze / Prețuri) whose active tab
  was pure in-memory DOM state. [admin/js/crm-app.js](../admin/js/crm-app.js)'s `init()` ended with an
  **unconditional** `setActiveTab('dashboard')`, so any page refresh (or returning to a still-open tab)
  snapped back to the Dashboard/calendar regardless of which view the user was on — losing their place.
- **Decision:** drive the active tab from the URL hash, entirely within
  [admin/js/crm-app.js](../admin/js/crm-app.js). A `TAB_NAMES` whitelist gates everything.
  `resolveTabFromHash()` reads + validates `location.hash`; `syncTabHash(name)` mirrors the active tab
  back to the hash via `history.replaceState` (deliberately **not** `location.hash =`) — replaceState
  keeps tab switches out of the browser history (so Back **leaves** the CRM rather than cycling through
  tabs) and never fires `hashchange` (so the listener below can't re-enter). The default Dashboard tab
  is kept on a **clean URL**: its hash is stripped rather than written, so a fresh visit isn't rewritten
  to `…#dashboard`. `setActiveTab` now calls `syncTabHash`; `init()` resolves the initial tab from the
  hash (falling back to the DOM `is-active` tab, then `'dashboard'`) in **both** places it activates a
  tab — pre-auth (so the tab still restores if Supabase/auth fails locally, preserving the existing
  "tabs usable in no-config dashboard" behavior) and post-module-init (so the restored tab's
  data-loading side effect — `EcoVilaCrmFinance.showCurrentMonth` / `EcoVilaCrmDaily`+`EcoVilaCrmTowels`
  `.showToday` — runs *after* the owning module is initialized). Those side effects are already guarded
  by `activeFinance`/`activeDaily`/`activeTowels`, so the earlier pre-auth restore is a safe no-op for
  them. A single guarded `wireHashNavigation()` adds one `hashchange` listener so direct `#tab` links or
  a manual hash edit mid-session also switch tabs.
- **Why:** hash persistence makes a refresh land on the same view and makes the deeper tabs
  bookmarkable/shareable, with no extra storage and the smallest possible change (one file, no
  HTML/CSS). `replaceState` is the right primitive because the tab is view state, not a navigation
  step — pushing history entries would hijack the Back button. Keeping Dashboard hash-free avoids an
  ugly `#dashboard` appended to every clean load while still being correct on refresh (no hash ⇒
  Dashboard). Restoring deeper in-tab state (e.g. the exact finance month or daily day) was deliberately
  **out of scope** — restoring the tab re-runs each tab's normal default load (current month / today),
  which is the established behavior of `setActiveTab`.
- **Consequence:** only [admin/js/crm-app.js](../admin/js/crm-app.js) changed; no markup, CSS, or test
  changes were required (the existing crm-app text-assertions — `wireTabs();` before
  `auth.requireSession`, and the `EcoVilaCrmFinance` init/`showCurrentMonth` hooks — still hold, and all
  221 node tests pass). Verified in-browser via the no-cache dev server (ADR-044) with a throwaway
  harness that loads the **real** `crm-app.js` against the real tab markup with `requireSession` stubbed
  to `null` (the dashboard otherwise redirects to the login page without a Supabase session): fresh load
  → clean URL + Dashboard; Finance/Pricing clicks → `#finance` / `#pricing` with the panel switching;
  Dashboard click strips the hash back to a clean URL; a direct load of `…#daily` (the refresh case)
  restores the Daily tab; an invalid `#bogus` falls back to Dashboard and cleans the hash; an in-session
  `#towels` change fires the listener and switches tabs — all with no console errors. Re-run
  `npm run prepare:tophost` before the next TopHost upload.

---

### ADR-049 — CRM Finance tab opens on TODAY (single-day range) instead of the current month
- **Date:** 2026-06-16.
- **Context:** the Finance tab ([admin/js/crm-finance.js](../admin/js/crm-finance.js)) opened to the
  **current full month** — its `init()` seeded `[firstOfMonth(today), nextMonth)` and
  `setActiveTab('finance')` ([admin/js/crm-app.js](../admin/js/crm-app.js)) called `showCurrentMonth()`,
  which re-applied that month range. The owner wanted the tab to land on **today** by default so the
  current day's figures are the first thing visible (the Daily/Ștergare tabs already open on today via
  their own `showToday`).
- **Decision:** rename `showCurrentMonth` → `showToday` and set the default range to the single day
  `[today, addDays(today, 1))`; `init()`'s seed state was changed to the same single-day range (mode
  unchanged — still `nights` / "Nopți în perioadă"), and `setActiveTab('finance')` now calls
  `showToday()`. This reuses the **exact** single-day range the manual calendar pick already produces
  (ADR-046's booked-day path), so everything downstream behaves as the already-tested single-day case:
  the range label renders `DD lun. YYYY - DD lun. YYYY`, the length-aware `shiftRange` makes Înapoi/
  Înainte step by **one day** (not one month) from a single-day range, and the "Rezervări create în ziua
  selectată" list stays hidden in the default `nights` view (it requires Încasări + a one-day range).
  The static Finance subtitle dropped the now-misleading word "lunar" (→ "Raport pentru venituri,
  încasări și performanță.").
- **Why:** today's numbers are what the owner scans for; defaulting to the whole month buried them and
  made the tab inconsistent with Daily/Ștergare. Renaming the function (rather than keeping the
  misleading `showCurrentMonth` name for code that now shows a day) keeps the API honest and matches the
  `showToday` naming the other two daily tabs use. Reusing the existing single-day plumbing means no new
  range/label/navigation code and no new edge cases. Changing the default **mode**, or persisting a
  previously-chosen Finance range across visits, were deliberately left out of scope — the owner can
  still widen to a month or any span via the calendar, and Înainte/Înapoi.
- **Consequence:** [admin/js/crm-finance.js](../admin/js/crm-finance.js) (`showToday` + single-day
  `init` seed), [admin/js/crm-app.js](../admin/js/crm-app.js) (Finance tab side-effect),
  [admin/dashboard.html](../admin/dashboard.html) (subtitle), and
  [tests/admin-crm.test.mjs](../tests/admin-crm.test.mjs) updated — the crm-app hook assertion now
  expects `showToday`, plus a new test asserting `init()` immediately loads `[2026-06-16, 2026-06-17)`
  in `nights` mode. 222 node tests pass. (ADR-048's prose still references the old `showCurrentMonth`
  name, which was accurate when written; this ADR supersedes it.) Verified in-browser via the no-cache
  dev server (ADR-044) with a throwaway harness loading the real `crm-finance.js` + `css/crm.css` with
  `todayISO`/Supabase stubbed: the Finance panel opens on "16 iun. 2026 - 16 iun. 2026" in Nopți mode,
  the summary computes today's figures (one overlapping night of a 3-night stay → 2.000 MDL
  commercial/online, 1 occupied night, 1 paid booking, 2.000 MDL Căsuță mică), and Înainte/Înapoi step
  to 17 iun. / 15 iun. — no console errors. Re-run `npm run prepare:tophost` before the next TopHost
  upload.

---

### ADR-050 — Finance "today" default opens in Încasări (paid) mode so the booked-day list shows
- **Date:** 2026-06-16.
- **Context:** follow-up to ADR-049, which made the Finance tab open on today but kept the default
  reporting mode as `nights` ("Nopți în perioadă"). In that mode the "Rezervări create în ziua
  selectată" list stays hidden — it only renders for `paid` mode on a one-day range
  (`renderBookedDayRows` / `loadFinance` in [admin/js/crm-finance.js](../admin/js/crm-finance.js)). The
  owner confirmed they want the daily default to be the **Încasări** view, surfacing both today's
  collections and the list of reservations created today.
- **Decision:** change `init()`'s seed `mode` from `MODE_NIGHTS` to `MODE_PAID` in
  [admin/js/crm-finance.js](../admin/js/crm-finance.js). Combined with the single-day "today" range from
  ADR-049, this makes `loadFinance` fetch the booked-day rows (`shouldLoadBookedDay = paid && one-day`)
  and `renderBookedDayRows` un-hide the section on first paint. `showToday()` still only resets the
  *range* (not the mode), so a within-session switch to "Nopți" is respected until the page reloads —
  "default" means the starting state, not a forced reset on every tab re-entry. The static mode toggle
  in [admin/dashboard.html](../admin/dashboard.html) had its `is-active` / `aria-pressed="true"` moved
  from the Nopți button to the Încasări button so the pre-JS markup matches the JS default (no flash);
  `syncControls` would override it on load regardless.
- **Why:** Încasări + today is the single most useful daily snapshot for the owner — money actually
  collected today plus the reservations booked today (grouped per reservation via ADR-046) — and it was
  the explicit ask. Keeping `showToday` range-only preserves the sticky-mode behavior already in place
  for the rest of the session.
- **Consequence:** [admin/js/crm-finance.js](../admin/js/crm-finance.js) (seed mode),
  [admin/dashboard.html](../admin/dashboard.html) (active toggle), and
  [tests/admin-crm.test.mjs](../tests/admin-crm.test.mjs) (today-default test now asserts
  `mode === 'paid'`) updated; 222 node tests pass. Verified in-browser via the no-cache dev server with
  a throwaway harness loading the real `crm-finance.js` + `css/crm.css` (today/Supabase stubbed, the
  booked-day fetch returning one single-villa booking + one two-villa group created today): the Finance
  panel opens on "16 iun. 2026 - 16 iun. 2026" with **Încasări** active, the paid-mode summary shows
  3.800 MDL commercial/online · 1 paid booking, and the "Rezervări create în ziua selectată" section is
  visible with count 2 — a single card (Vila #3 · 3.800 MDL · online plătit) and a grouped card
  (2 vile · 10.867 MDL · din oficiu) — no console errors. Re-run `npm run prepare:tophost` before the
  next TopHost upload.

### ADR-051 — MIA QR direct payment for +373 guests (own QR page, no signature key)
- **Date:** 2026-06-17.
- **Decision:** `+373` guests now pay via a dedicated, MIA-only QR page on our own domain
  (`plata-mia.html`) instead of the maib multi-option hosted checkout. On checkout,
  `maib-create-payment` (MIA rail) creates a **dynamic, fixed-amount, 5-minute QR** via
  `POST /v2/mia/qr` (`createMaibMiaQr` in `_shared/maib.ts`) and returns its `url`; the page
  renders the QR (vendored `js/vendor/qrcode.js`) plus a "pay from phone" deeplink and polls
  `maib-mia-status` until paid, then redirects to `confirmare.html`. Card guests are unchanged.
  This implements the MIA leg that ADR-004 chose but deferred.
- **How / trust model:** payment is confirmed by **re-reading MAIB's authoritative state**
  (`GET /v2/mia/payments?orderId=…` with our OAuth token), never by trusting the callback —
  so the MIA **signature key is not required**. The public `maib-mia-callback`
  (`verify_jwt=false`) only names the order to re-check; `maib-mia-status` (`verify_jwt=true`)
  is the browser poll. Both funnel through `_shared/miaReconcile.ts` → `_shared/bookingSettlement.ts`,
  a settlement core **extracted from the card callback** so both rails confirm bookings
  identically (mark paid, reinstate cron-released holds, notify + track once, amount-mismatch
  guard). No DB migration: for MIA rows `pay_id`=qrId, `provider_payment_id`=executed payId
  (so the existing refund flow works), `checkout_url`=QR url.
- **Why:** MIA is the only rail offered to Moldovan guests, so a single pre-selected option is
  clearer than the maib chooser; MIA commission ≈ 0.7% (vs card) ; and the existing
  `MAIB_CLIENT_ID/SECRET` are already entitled to the MIA QR API (probe-verified 2026-06-17),
  with `terminalId` defaulted by the account.
- **Security:** no high-confidence vulns (reviewed 2026-06-17). A forged callback cannot
  confirm an unpaid booking (re-verified against MAIB); amounts are server-authoritative;
  settlement is idempotent; `maib-mia-status` is keyed by the unguessable `bookingGroupId`
  UUID and returns **no guest PII** (PII stays behind the manage token). MIA QR creation sends
  no payer PII to MAIB. Vendored `qrcode.js` verified byte-identical to npm
  `qrcode-generator@1.4.4` (provenance + SHA-256 in `js/vendor/README.md`).
- **Consequence — deploy ordering is mandatory:** the frontend (TopHost, manual upload;
  `plata-mia.html` added to the `prepare:tophost` allowlist) **must go live before** the four
  edge functions (`maib-create-payment`, `maib-callback`, `maib-mia-callback`, `maib-mia-status`),
  or `+373` checkout breaks. A `payUrl` → `plata-mia.html` fallback in the MIA response protects
  browsers running cached pre-MIA `checkout.js`. No new env var (the MIA callback URL derives
  from `SUPABASE_URL`). Built + verified (225 node + 53 deno tests pass); committed on branch
  `mia`, not yet deployed.
- **Optional later hardening:** rate-limit / early-reject the unauthenticated `maib-mia-callback`;
  a cron that re-checks pending MIA payments before the expiry cron cancels them.
- **Update (2026-06-17):** deployed to prod (`maib-create-payment` v14, `maib-callback` v17,
  `maib-mia-callback`/`maib-mia-status` v1). A real `+373` booking paid 38 MDL via QR MIA and
  reconciled (paid_at stamped), then refunded cleanly — full money path verified on a device.
  Follow-up fixes on `mia`: the Finance "Rezervări create în ziua selectată" list now uses the
  Moldova (Europe/Chisinau) calendar day for `created_at` (was UTC-shifted, hiding bookings made
  just after local midnight) and shows paid-then-cancelled bookings as "anulată" instead of
  dropping them; never-paid abandoned holds stay excluded. The MIA page CTA was renamed to
  "Click aici pentru a plăti" and restyled (depth gradient, hover lift, forward-arrow, subtle
  light sweep; reduced-motion safe). The pay-card title was shortened from "Scanează codul QR
  pentru a plăti" to just "Scanează codul QR" (all three locales), and a
  **"Denumirea comerciantului: S.C. PROELECTROCOMPLEX S.R.L"** line was added directly below the
  pay button so guests recognise the abbreviated `S c P` beneficiary name their banking app shows
  for the MIA transfer — that displayed name is set on the MAIB merchant account, not in our QR
  payload (`buildMaibMiaQrPayload` sends no merchant name), so this is a label-only clarification.
  Branch `mia` is kept separate for a few days of prod testing before merging to `main`.

### ADR-052 — Guest notifications are one per booking group, not one per villa
- **Date:** 2026-06-17.
- **Decision:** every guest-facing notification — booking/payment confirmation, cash-expiry
  cancellation, guest/staff cancellation, the cash-expiry "expiră în curând" reminder, and the
  24h arrival reminder — is sent **once per `booking_group_id`**, regardless of how many villas
  the booking holds. The lowest reservation id in the group is the "owner": it sends one SMS and
  one email whose body lists **every** villa in the booking (e.g. "Căsuța #3, Căsuța #5") and sums
  the per-villa split prices back to the full booking total; the other reservations in the group
  send nothing. Separately, the standalone "Rezervarea dvs. expiră în 5 minute" **SMS was dropped
  entirely** — guests already see the deadline at booking time — while the equivalent reminder
  **email is kept** (now also one per booking). Implemented with `mapNotificationOwners` +
  `aggregateRoomLabel`/`aggregateTotalPrice` in `supabase/functions/_shared/notifications.ts`,
  applied in `send-reminders`, `expire-cash-reservations`, `confirm-reservation-payment`,
  `reservation-cancel`, and `_shared/bookingSettlement.ts` (used by `maib-callback` and
  `maib-mia-callback`).
- **Why:** a multi-villa booking is stored as one reservation row per villa sharing a
  `booking_group_id`, phone, and dates (`js/checkout.js`). The per-reservation notify loops were
  deduped only on `reservation_id`, so the guest was texted/emailed once **per villa** — e.g. a
  3-villa cash booking got 3 "expiră în 5 minute" texts at once and 3 cancellation texts, and 3
  confirmation emails that each showed only a 1/N price split. That reads as spam and the split
  totals were misleading.
- **Consequence:** the owner is deterministic (lowest id) and each cron run / settlement processes
  a whole group together, so dispatch stays exactly-once across retries even though non-owner
  reservations no longer get their own `notification_events` row — notifications are now audited
  under the owner reservation only. Any future per-booking guest notification must route through
  `mapNotificationOwners`. Builds on ADR-005 (idempotent lifecycle notifications); the email
  redesign from ADR-039 is unchanged apart from the aggregated room/total lines.

### ADR-053 — CRM staff cancellations notify the guest
- **Date:** 2026-06-17.
- **Decision:** when staff cancel a booking from the CRM ("Șterge rezervarea"), the guest now
  receives the same localized cancellation SMS + email that guest self-service cancellations
  already send (ADR-052 grouping applies). A new staff-gated Edge Function
  `reservation-cancel-notify` (`verify_jwt = true`, `requireStaffRole(['diana', 'angela'])`) loads
  the cancelled booking group and dispatches **one** notification per `booking_group_id` via
  `mapNotificationOwners`, recorded under the `reservation_cancelled` notification event type —
  deliberately distinct from guest self-cancellation's `guest_cancellation`. The CRM
  `deleteReservation` calls it **best-effort** after the cancellation update (frontend helper
  `notifyReservationCancellation` in `js/supabase.js`): a notification failure never undoes the
  cancel, it only surfaces a soft staff notice. Staff use `['diana', 'angela']` rather than the
  `['diana']`-only gate of the refund/SMS functions because both staff accounts cancel non-card
  bookings from the CRM and should be able to notify.
- **Why:** the CRM delete path only refunded (when card+paid) and flipped the rows to `cancelled`;
  it sent the guest nothing. So a staff cancellation looked, from the guest's side, like a silent
  refund with no explanation. This surfaced when a paid MIA booking (Zamineagri Valentin,
  2026-06-17) was cancelled from the CRM, auto-refunded, and the guest was never told — the
  cancellation appeared to "happen on its own". `reservation_cancelled` was already declared in the
  `notification_events` event-type check (ADR added in `20260612160000`) but had never been used.
- **Consequence:** `reservation_cancelled` is now the staff-cancellation dedup key; the
  per-`(reservation_id, event_type)` unique constraint keeps it exactly-once even if the delete is
  retried, and it cannot collide with a guest self-cancel (terminal state, different event type).
  Deployed to prod 2026-06-17 (`reservation-cancel-notify` v1); the frontend helper + CRM wiring
  ship with the next TopHost upload. Builds on ADR-052; the auth gate diverges from the
  `['diana']`-only convention by design.

### ADR-054 — Server-side, anti-fragmentation room auto-assignment
- **Date:** 2026-06-17.
- **Decision:** when a guest books a villa **type** without picking a specific unit
  (`room_explicitly_selected = false`), the **server** now assigns the room, using a
  **tightest-free-window** heuristic: among the rooms of that type free for the stay, pick the one
  whose contiguous free window — the gap before the stay + the stay + the gap after, capped at 60
  days per side — is the **smallest**. Filling the most-constrained room first preserves longer
  contiguous gaps on the other rooms for future multi-night stays. Ties fall back to the existing
  per-type room-number direction (`small` descending, `large`/`hotel` ascending) so the common
  no-pressure case is unchanged. Implemented as a pure, unit-tested core
  (`orderRoomsByTightestWindow` / `freeWindowDays`) plus a thin `assignAutomaticRooms` orchestrator
  in `supabase/functions/_shared/roomAssignment.ts`, wired through a new optional `assignRooms`
  hook in `createReservationsWithTokens` that runs **before** the price guard (price depends only on
  the villa type, which assignment never changes, so the order is safe). It is **best-effort**: any
  error, or no available candidate, falls back to the client-supplied `room_id`, and the DB
  `reservations_no_room_overlap` exclusion constraint stays the final backstop.
- **Why:** the browser auto-assigned by room number only (`orderRoomsForAssignment` in
  `js/calendar.js`), blind to the bookings around the requested dates. A 1-night booking could grab
  a room sitting in the middle of a long free gap and fragment it — e.g. small villas, booking
  11–12 Jul: #3 is free 10–13 Jul and #7 is free only 11–12 Jul; the old logic took #3 and
  destroyed the 3-night gap, when #7 was the perfect tight fit. Moving the decision server-side
  also makes it **authoritative** (no stale-/old-client divergence), **race-safe** (availability is
  re-read at insert time, after the guest finishes paying — a freed/taken room is reflected), and
  deployable **without a TopHost upload**.
- **Consequence:** the browser still sends a candidate `room_id` and still renders availability +
  the explicit room picker, but the server **overrides** the candidate for auto rows — so **no
  client change and no TopHost upload were needed**, only the `create-reservation` redeploy. The
  guest never sees a specific number pre-booking (`getRoomsCopy` in `js/checkout.js` gates on
  `roomExplicitlySelected`) and the confirmation/email read the real room from the DB, so the
  override is invisible. Cost is one small indexed `reservations` read + a `rooms` read per booking
  that has an auto row — negligible at 25 rooms / boutique volume, and edge-function invocations are
  unchanged. Explicit guest picks (`room_explicitly_selected = true`) and CRM staff bookings
  (`buildStaffReservationRows`, always explicit, separate direct-insert path) are untouched.
  Deployed to prod 2026-06-17 (`create-reservation`).

### ADR-055 — Date-only values render in UTC; "today" is the Europe/Chisinau business day
- **Date:** 2026-06-18.
- **Decision:** every formatter that displays a **date-only** value (`YYYY-MM-DD`, which
  `parseISODate` anchors to UTC midnight) now passes `timeZone: 'UTC'` to
  `Intl.DateTimeFormat`, on both the guest site (`formatDate`/`formatMonth` in `js/booking.js`,
  `js/gestionare.js`, `js/anulare.js`, `js/checkout.js`, `js/confirmare.js`) and the CRM
  (`admin/js/crm-app.js`, `crm-dashboard.js`, `crm-sidebar.js`, `crm-finance.js`). The CRM's
  `formatCreatedAt` — a real timestamp, not a date-only value — is instead pinned to
  `timeZone: 'Europe/Chisinau'` so created-at always reads in business time. Separately,
  "today" is now a single source of truth: `pricing.todayISO()` computes the **Europe/Chisinau**
  calendar day via `Intl.DateTimeFormat(...).formatToParts` and is exported; the three other
  copies (`js/booking.js`, `admin/js/crm-pricing.js`, `admin/js/crm-calendar.js`) delegate to it
  with their previous local-time logic kept only as a no-tz-data fallback. The shared edge copy
  `supabase/functions/_shared/pricing.js` is kept byte-identical (pricing guard, ADR-pricing).
- **Why:** an on-site workstation (Angela's) had its timezone/locale set behind UTC; the CRM
  rendered 20 Jun reservations as 19 Jun. `Intl.DateTimeFormat().format()` of a UTC-midnight
  instant uses the **machine's** timezone unless told otherwise, so on any behind-UTC machine the
  day rolled back. The four divergent `todayISO()` implementations (two local-time, one UTC, one
  using local getters) compounded it: "today" itself differed by machine and by module. Anchoring
  both display and "today" to a fixed business timezone makes the calendar correct regardless of
  how a viewer's computer is configured. Verified by reproducing the off-by-one under
  `TZ=America/*` and confirming UTC output is stable across `America/*`, `Europe/Chisinau`, and
  `Asia/Tokyo`.
- **Consequence:** date-only displays are now machine-independent; a misconfigured workstation can
  no longer shift them. The native `<input type="date">` controls in the CRM are a **separate,
  unfixable-in-page** case: an empirical probe proved Chromium ignores the `lang` attribute for
  date inputs (explicit `lang="ro"` and `lang="en-GB"` still rendered `mm/dd/yyyy`) and formats
  purely by the **browser's language preference** (`navigator.languages[0]`), which the OS *region*
  (Moldova) does not override. So mm/dd/yyyy in the CRM is fixed per-machine by putting Romanian at
  the top of the browser's language list — no code change, and **no custom pickers** were built (a
  deliberate decision to avoid the risk for marginal benefit). Ships with the next TopHost upload;
  no edge redeploy required (the `_shared/pricing.js` change is behaviourally identical server-side,
  where the runtime is already UTC).

### ADR-056 — Angela CRM least-privilege: read-only dashboard, daily + towels only, enforced in RLS
- **Date:** 2026-06-18.
- **Decision:** the `angela` role now sees only three CRM tabs — Dashboard (read-only),
  Situația zilnică and Ștergare — with finance, photos and pricing hidden. In `admin/js/crm-app.js`
  a `ROLE_TABS` map drives tab visibility, clamps `setActiveTab`/`resolveTabFromHash` so a stale
  `#finance` hash cannot surface a hidden tab, and skips initialising the hidden modules. A
  `context.permissions.dashboardReadOnly` flag (true for Angela) makes the dashboard view-only:
  the add-reservation tool is hidden and unwired (`crm-sidebar.js`), the cash "mark paid" button is
  omitted, reservation cards are non-draggable with cell drop wiring skipped, and the reservation
  dialog opens with disabled fields and no save/cancel/SMS actions (`crm-dashboard.js`). Search stays
  available — it only reads. **Server-side**, migration `20260618150000` replaces the both-roles
  "CRM staff can manage reservations" policy with `Diana can manage` (ALL) + `Angela can read`
  (SELECT) + `Angela can update daily reservation fields` (UPDATE), and a `before update` trigger
  `enforce_angela_reservation_columns()` restricts Angela's UPDATEs to the daily-tab allowlist
  (`towel_cards_issued, adults, check_out, kids_ages, total_price`). Angela has no INSERT/DELETE
  policy, so add and hard-delete are denied outright.
- **Why:** UI hiding alone is cosmetic — a determined session could still write directly to the
  `reservations` table, which the old shared policy permitted. The dashboard's financial actions
  (mark paid, refund, confirmation SMS/email) already run through `requireStaffRole(['diana'])` edge
  functions, but add/room-swap/cancel are **direct** table writes that needed RLS. A blanket
  read-only policy was impossible because Situația zilnică legitimately writes five `reservations`
  columns (check-in towel cards + the guest-count/stay-extension edit), so a column-level trigger is
  the only way to keep those while blocking everything else (RLS cannot compare OLD vs NEW per
  column). Diana and the service role return early from the trigger and are unrestricted. Verified
  against the linked DB by simulating each role's JWT in rolled-back transactions: Angela's room
  swap, cancel and insert are rejected; her towel-card write succeeds; Diana passes the guard.
- **Consequence:** the boundary is now defense-in-depth (UI + RLS). Angela retains write access to
  the five daily-tab columns on any reservation — including `total_price` — because the guest-edit
  recomputes price; that is the intended daily capability, not a new one. **Deliberately scoped to
  reservations:** the owner chose (2026-06-18) to leave the hidden Prețuri/Poze tabs UI-only —
  `pricing_tiers`, `holidays`, `rooms`, `crm_photos` and the photo storage bucket keep their
  both-roles "manage" policies, so Angela could still write them via a crafted API call (she keeps
  the SELECT she needs for daily supplements). `reservation-cancel-notify` likewise still allows
  `angela` (notification only, no state change). If that risk appetite changes, the same
  Diana-manage/Angela-read split applies cleanly to those tables. Frontend changes ship with the
  next TopHost upload; the RLS migration is already live (applied via `db query --linked` +
  `migration repair`, per the migration-drift workflow).

### ADR-057 — Guest-initiated "add people" to a paid booking, paying only the price difference
- **Date:** 2026-06-18.
- **Decision:** a guest with a confirmed online-paid booking can add adults/children on
  `gestionare.html` (within the capacity of the villas they already booked) and pay only the price
  **difference** for the extra guests — via MIA QR for `+373` numbers or card Checkout otherwise,
  matching the booking rail rule (ADR-041/MIA). Each request is a row in a new
  **`public.reservation_changes`** ledger — deliberately **not** on `maib_payments`, whose every
  reconcile/refund/callback path keys off the *latest* row per booking group and would be hijacked
  by a difference payment. The MAIB **order id is the change id**, so callbacks route a difference
  to its ledger row and never to the booking's original payment. Capacity and the difference are
  **recomputed server-side** (`reservationChanges.ts`); the browser quote is advisory. The
  difference is `price(newParty) − price(oldParty)` at **current** tariffs, isolating the added
  guests so a tariff change since booking never leaks in. On payment the party (`adults`,
  `kids_ages`) is applied to the booking's rows **once** (claims `applied_at` atomically), the base
  `total_price` is **left immutable**, and a short localized SMS + email confirm the update. A zero
  difference (only free 1–2-year-olds) is applied instantly with no payment. New edge functions
  `reservation-change-create` + `reservation-change-status`; `maib-callback` (card, signature-
  verified) and `maib-mia-callback` (MIA, re-reads MAIB authoritatively) gained a change branch.
  **Finance CRM** surfaces each paid difference as its own dated **"online plătit diferență"** line
  in the Încasări tab and folds it into the online/commercial totals (paid-mode only). On self-serve
  (`reservation-cancel`) **and** CRM full-refund (`maib-refund`) cancellation, every paid difference
  is **auto-refunded** as its own MAIB transaction (idempotent; partial CRM refunds are excluded).
- **Why:** the booking total stays the originally-charged amount (read in many places — nights
  revenue, refunds, emails, exports), so a separate append-only ledger is both safer and the exact
  shape the owner wanted for the finance "difference" line. Keeping differences off `maib_payments`
  preserves all existing single-payment-per-group invariants. Server-side recompute prevents a
  tampered party/price from reaching MAIB, mirroring the booking price guard (ADR pricing-guard).
- **Consequence / hardening:** a pre-ship audit fixed four issues — (1) `applyBookingChange` wrote a
  non-existent `reservations.updated_at` (would have failed every apply; the table has only
  `created_at`); (2) a forged oversized `adults` could DoS `getUnitsNeeded`'s linear scan, now bounded
  to physical capacity first; (3) a superseded **card** checkout (uncancelable at MAIB) could be paid
  late and overwrite the party with a stale snapshot — a paid callback now applies only a still-
  `pending` change, plus a partial unique index enforces one open change per booking; (4) the MIA QR
  validity was cut 15→5 min to stay inside the `plata-mia` poll window. Known rare edges (logged for
  manual review): paying a difference at the instant of cancellation, or deliberately paying an
  abandoned/superseded card checkout — captured but not auto-applied/refunded. Mid-stay additions are
  priced over the full stay (a deliberate policy choice, not pro-rated). **Deploy:** migration
  `20260618160000_reservation_changes.sql` + functions `reservation-change-create`,
  `reservation-change-status`, `maib-callback`, `maib-mia-callback`, `reservation-cancel`,
  `maib-refund`; frontend ships with the next TopHost upload.
- **Post-ship audit + deploy (2026-06-18):** a second full review before deploy found and fixed three
  more issues — (1) self-serve `reservation-cancel` refunded the original booking payment *before* the
  add-guests differences, so a mid-way difference-refund failure stranded the booking active with the
  original already refunded and a retry blocked by the "payment not ready for refund" guard; the order
  is now **differences-first** (both `refundPaidChanges` and `createRefund` are idempotent, so a retry
  re-runs cleanly); (2) a concurrent double-submit tripped the one-open-change partial unique index as
  a raw 500 — `insertChangeRow` now maps `23505` to a retryable **409**; (3) added
  `supabase/functions/tests/reservationChanges.test.ts` (13 tests) covering the price-difference math,
  the capacity/DoS bounds, the add-only/superset rules, the once-only apply, and the 409 mapping (the
  module previously had none). **Deployed to prod 2026-06-18:** migration applied via `supabase db push
  --linked` (recorded in remote history; verified live — table + RLS + 1 staff-read policy + 6 indexes
  + realtime publication, no new security advisories), and all six edge functions deployed via
  `supabase functions deploy … --use-api` and smoke-tested (verify_jwt correct per function, new table
  queryable). The guest-facing UI goes live with the pending TopHost frontend upload.

### ADR-058 — Payment confirmation is exactly-once per booking group, not per reservation

A multi-villa booking is one `booking_group_id` with one reservation row per villa, and the
confirmation SMS/email is meant to go out once for the whole group. Some guests booking two villas
still received **two** texts. Production `notification_events` showed the signature unambiguously: two
`payment_confirmation` rows for the **same booking group**, different `reservation_id`s, sent <1s
apart, always on the **MIA QR** rail (e.g. group `9ee7b54d…` and `2d5f3375…`, one row from
`maib-mia-status`, one from `maib-mia-callback`). It was never CSS or a stale/cached frontend bundle —
the frontend grouped the booking correctly (single group, single `maib_payments` row).

**Root cause:** both MIA rails call `reconcileMiaBookingGroup` — the MAIB push callback
(`maib-mia-callback`) and the browser status poll (`maib-mia-status`). There is a time-of-check/
time-of-use gap between reading `maib_payments.status = 'pending'` and writing `'paid'`, spanning an
awaited authoritative MAIB lookup. Two calls inside that window both run `settleBookingGroupAsPaid`,
and each call's `paidReservations` can be a different subset of the group. The notification "owner" was
chosen from that per-call subset while the idempotency index is `unique(reservation_id, event_type)` —
so two settlements that owned different villas inserted two different rows and both texted the guest.
The reservation flip, the hold reinstate, and purchase tracking (`tracking_events`, keyed on the
group-stable `tracking_event_id`) are all already idempotent per group; only the notification leaked.

**Fix (correct-by-construction; no migration, no rail serialization):** the confirmation is now claimed
on a **booking-group-stable owner** — the lowest reservation id in the *whole* group, re-read inside
`notifyPaidReservations` rather than taken from the settled subset — so concurrent settlements compute
the identical key and the existing `unique(reservation_id, event_type)` index admits exactly one
confirmation; the loser collides (`23505`) and skips. The email aggregates the group's authoritative
paid villas. Serializing the rail with an atomic `maib_payments` claim was **rejected**: it adds a
crash-stranding window (mark paid → crash before settle → the poll's `status='paid'` early-return means
the booking never settles and no SMS is ever sent), and it is unnecessary once the side-effect is
itself idempotent — the same philosophy as the existing guarded UPDATEs and `tracking_events` dedup.
Regression test `supabase/functions/tests/bookingSettlement.test.ts` drives two racing settlements over
one group (the second seeing only a subset — the exact prod interleaving) and asserts a single
SMS + email keyed on the group owner. **Deployed to prod 2026-06-18:** shared module
`_shared/bookingSettlement.ts` rebundled into edge functions `maib-callback` (v20),
`maib-mia-callback` (v4), `maib-mia-status` (v2) via `supabase functions deploy … --use-api` (all
ACTIVE, `verify_jwt` preserved per `config.toml`: callbacks false, status true). No migration, no
frontend change — no TopHost upload required.

---

### ADR-059 — Per-country phone length validation (+373/+40/+380) and a lookup that tells guests when no reservation matches

Two guest-facing phone problems shipped together. (1) The phone field accepted any E.164-shaped
number (`/^\+\d{8,15}$/`), so a Moldovan (+373), Romanian (+40), or Ukrainian (+380) guest could
submit a number with the wrong digit count — a transposed, missing, or extra digit still passed —
landing a wrong contact number on the booking (and, for +373, on the MIA payment/SMS rail per
ADR-051). (2) The "Ai deja o rezervare?" SMS lookup always advanced to the "enter the 4-digit code"
step even when the phone had no active reservation: the backend silently sent no SMS (privacy-
preserving by design) while the UI told the guest a code was on its way, stranding them.

**Part 1 — country-specific length.** Moldova national numbers are 8 digits, Romania and Ukraine 9.
A single `isValidGuestPhone` helper enforces `^\+373\d{8}$` / `^\+40\d{9}$` / `^\+380\d{9}$` and falls
back to the generic `^\+\d{8,15}$` for every other country, so foreign guests are not over-restricted.
The three prefixes are mutually exclusive (order is irrelevant), and input is coerced with
`String(phone || '')` so the helper never throws on null/undefined. The guard is duplicated at all
guest entry points — checkout, the cancellation confirmation, and the lookup modal — and
authoritatively on the server in `_shared/reservations.ts` (`hasValidPhoneLength`, on the
`create-reservation` → `buildReservationRows` path), mirroring the codebase's existing "duplicate the
small validator" idiom (cf. `normalizeInternationalPhone`). The DB `guest_phone` CHECK
(`^\+[0-9]{8,15}$`) is deliberately kept as the broader backstop — every number the app now accepts is
a strict subset — so **no migration is needed** and no legacy row is invalidated.

**Part 2 — lookup honesty.** `reservation-lookup-start` already computed whether the phone has an
active reservation (to decide whether to send the SMS); it now returns that boolean as
`hasReservations`. The browser stops on the phone step with "Nu am găsit rezervări active pentru acest
număr." when `hasReservations === false`, and also handles the previously-unhandled `rateLimited`
response (which used to advance to a code step that could never verify) with a dedicated message. The
check is `=== false`, not `!result.hasReservations`, as a rollout-safety choice: a missing field — e.g.
the old function during the deploy window — falls through to the normal flow instead of falsely
erroring on every lookup. This is why **the backend is deployed before the frontend**.

**Tradeoff accepted by the owner:** surfacing "no reservation for this number" reveals whether a phone
has a booking, which enables enumeration. The existing rate limit is per-phone (5/10 min) and so does
not constrain probing across different numbers; an IP-based limit is the noted future hardening. This
was an explicit product request, made knowingly.

**Out of scope.** The staff CRM (`admin/js/crm-sidebar.js`, `payment_type:'office'`, direct insert)
keeps the loose generic rule — staff take phone bookings from any country and must not be
over-restricted, and that path never traverses the public `create-reservation` validator anyway. The
server `assertValidPhone` used to *match* existing reservations (lookup/cancel) also stays loose, so a
guest whose stored number predates this rule is never locked out of managing it.

**Tests:** per-country plus non-string cases in `tests/checkout.test.mjs` and `tests/anulare.test.mjs`,
a new Deno `supabase/functions/tests/reservationPhoneLength.test.ts`, and the
`hasReservations`/`rateLimited` wiring in `tests/reservation-lookup-refunds.test.mjs`. Full suite green
(234 Node + 81 Deno).

**Deployed to prod 2026-06-19:** edge functions `reservation-lookup-start` and `create-reservation`
redeployed via `supabase functions deploy` (linked project `mckchrviaawdxtsfytut`; `verify_jwt`
preserved per `config.toml`). Live smoke confirmed a non-matching number returns
`hasReservations:false` with no SMS, and a wrong-length +373 is rejected with "Guest phone must use a
valid international format." before any DB write. No migration. The frontend (`js/checkout.js`,
`js/anulare.js`, `js/booking.js`, `js/translations.js`) ships via the TopHost upload.

---

### ADR-060 — Site-wide rate limiting for the public Edge Functions

ADR-059 left an explicit gap: the SMS lookup is an enumeration oracle, and its only throttle was
per-phone (5/10min), which an attacker defeats by rotating the phone number on each request. More
broadly, almost every guest-facing Edge Function runs with `verify_jwt = true` but is called with the
public anon key — so "JWT-gated" really means "reachable by anyone with the key baked into the
frontend". The booking flow had no defence against a single source spamming SMS, holding inventory
with pending reservations, brute-forcing lookup codes, or driving outbound MAIB / tracking calls.

**One shared, DB-backed limiter.** A generic sliding window in `public.rate_limit_events (bucket, key,
created_at)` backs every endpoint. Edge isolates do not share memory, so the database is the only
correct shared counter (the same reason the existing per-phone limit counts DB rows). The decision is
taken inside a `SECURITY DEFINER` Postgres function `rate_limit_hit(bucket, key, limit, window)` in one
DB round trip. The count-then-insert is intentionally **lock-free**: under burst concurrency a handful
of requests may slip one over the limit, which is irrelevant for abuse protection and avoids
serializing every caller of a hot `global` bucket (the pre-existing per-phone limiter is racy for the
same reason). A blocked request is **not** recorded, so a flood already over the limit cannot keep
extending its own window or growing the table. The function is `revoke`d from `anon`/`authenticated`
and then **explicitly `grant`ed to `service_role`** — the Edge runtime calls it as the service role, and
revoking from `PUBLIC` strips the inherited grant, which would make every call error and (by the
fail-open rule below) silently disable rate limiting. Two `pg_cron` jobs prune: `rate_limit_events`
every 30 min (longest window is 10 min), and — for the first time — `reservation_lookup_codes`, which
had no cleanup and is read on the lookup path.

**Layered keys — and deliberately NO global bucket.** Each endpoint composes `ip` (best-effort
per-caller) and, where one exists, a per-resource key (`phone`, booking-group, change). An earlier
draft added a spoof-proof `global` ceiling to every endpoint as a backstop for empty/spoofed IPs; the
owner **rejected it**: a single site-wide cap is a circuit breaker that, when it trips (one attacker, or
one legitimate spike/marketing push), denies booking to *every* guest at once — unacceptable collateral
for a business whose revenue is bookings. The accepted trade-off is explicit: an attacker on rotating
IPs is not fully stopped by the rate limiter, and the cryptographic controls (manage tokens, MAIB
signature, reconcile-against-MAIB) remain the integrity guarantees. All limits live in one tunable
`RATE_LIMITS` map in `_shared/rateLimit.ts`.

**Per-endpoint policy (window in minutes):**

| Function | Keys (limit/window) | Why |
|---|---|---|
| `reservation-lookup-start` | phone 5/10 (ADR-059), ip 20/10 | SMS + enumeration oracle |
| `reservation-lookup-verify` | ip 40/10 | code brute force (per-lookupId already capped at 5) |
| `create-reservation` | ip 10/10, phone 6/10 | pending rows hold inventory (denial vector) |
| `track-event` | ip 120/1 | outbound analytics fan-out |
| `maib-mia-status` | ip 150/1, group 40/1 | poll re-confirms vs MAIB; legit ~17/min/booking; unknown id = cheap not_found |
| `reservation-change-status` | ip 150/1, change 40/1 | same, difference-payment poll |
| `maib-mia-callback` | ip 60/1 | unsigned; each valid id → outbound reconcile. IP cap sits far above MAIB's real volume; a dropped callback is non-fatal (browser poll reconciles) |
| `maib-callback` | **none** | gated by the MAIB HMAC signature; a per-IP cap could throttle the provider, so it is left to the signature |
| `maib-create-payment` | ip 30/10, group 12/10 | mints a MAIB session (now token-validated, see below) |
| `reservation-change-create` | ip 20/10 | token-gated but mints a MAIB session |
| `reservation-cancel` / `-extend-cash` / `-manage-details` | ip 60/10 | token-gated; cap vs token-guessing / DB probes |

**Closed the `maib-create-payment` auth hole.** It previously minted a MAIB payment session from
`bookingGroupId` alone — a server UUID, but a *capability* anyone holding it could spend. It now
validates the manage token (`validateManageTokenPhone`, the same helper `reservation-change-create`
uses) and asserts the token's phone owns every reservation in the group (`assertBookingBelongsToPhone`),
so a leaked or guessed group id can no longer drive the provider on a stranger's booking. The token TTL
(30 min) always outlives the payment session (5 min), so no legitimate retry/reload regresses; all
callers (checkout, the confirmation retry, the MIA page) already pass the token.

**Deliberately not limited:** the staff functions (`confirm-reservation-payment`, `maib-refund`,
`send-sms`, `send-email`, `reservation-cancel-notify`) are gated by `requireStaffRole`, and the cron
functions (`expire-cash-reservations`, `send-reminders`) by `requireSharedSecret` — adding a limiter
would be redundant and could throttle legitimate back-office bursts.

**Fail-open by design.** A missing key (stripped IP header) or any limiter error returns *allowed* and
logs — keeping the booking flow available beats strict enforcement. Blocked guests on
`reservation-lookup-start` reuse the existing `{ ok: true, rateLimited: true }` shape the browser
already handles (ADR-059); every other limited endpoint returns HTTP 429.

**Customer-facing message.** A 429 surfaces in the UI as a localized "Sorry — our systems flagged your
requests. Please try again in a few minutes." (`common.rateLimited`, ro/ru/en). `js/supabase.js` exposes
`isRateLimited(error)` which reads the status off the supabase-js `FunctionsHttpError.context` (the raw
Response), and the customer surfaces — checkout, the confirmation payment-retry (new `[data-retry-status]`
line), the manage page (cancel / extend / add-guests), and the SMS-code step — show that string instead
of their generic error. Background status polls stay silent: they self-heal by retrying, and legit
polling sits below the per-key budget anyway.

**Client IP, honestly.** On Supabase Edge Functions the client IP is the *first* `x-forwarded-for` hop
(Supabase's gateway sets it; their documented pattern reads `[0]`), so a caller-supplied header does not
become `[0]`; `rateLimitIp` additionally prefers a single-value vendor header (`cf-connecting-ip` etc.)
when present. Two realities keep IP imperfect: the header is empty on a meaningful share of requests
(then the limiter fails open for that call), and the trustworthy XFF position is platform-specific. With
no global backstop (by the decision above), this is mitigation that raises cost and bounds spend/abuse,
not a wall — an attacker on rotating IPs/proxies gets past the IP buckets. Limit values are a starting
point, tunable in one map, and may need adjustment once prod logs show real traffic.

**Tests:** Deno unit tests for the helper (`supabase/functions/tests/rateLimit.test.ts`: IP resolution,
fail-open on missing key / limiter error, explicit-false-only blocking, 429 mapping, RATE_LIMITS
well-formedness) and a Node wiring guard (`tests/rate-limiting.test.mjs`) that asserts the migration
shape (incl. the `service_role` grant), that every public function routes through the limiter, that **no
global/`'all'` bucket remains**, that `maib-callback` stays signature-gated with no limiter, that
`maib-create-payment` validates the token, and that the customer message is wired in all three languages
— plus a catch-all that forces any *new* Edge Function to be classified, so an unprotected endpoint
cannot ship silently. Full suite green (256 Node + 89 Deno).

**Deployed to prod 2026-06-19.** Order: (1) applied migration `20260619140000_rate_limiting.sql` (table
+ `rate_limit_hit` + `service_role` grant + 2 crons; idempotent), then (2) redeployed all 13 touched
Edge Functions (`verify_jwt` preserved per `config.toml`), then (3) the frontend (`js/supabase.js`,
`js/translations.js`, `js/checkout.js`, `js/confirmare.js`, `confirmare.html`, `js/gestionare.js`,
`js/booking.js`) via the TopHost upload. The frontend only adds a friendlier message, so the backend
went first without breaking it.

### ADR-061 — Cash pay-office wayfinding on the manage page + one canonical office address site-wide

**Date:** 2026-06-19.

**Problem.** A guest who picks *cash* lands on the manage page (`gestionare.html`,
`[data-cash-panel]`) with a countdown but no way to actually find the office: the only
address anywhere was a bare street ("str. Aerodromului 3") in the checkout disclaimer and the
Terms page, and the cash-hold panel showed no address at all. The owner asked for help to find
and reach the office.

**Decision.** Add a three-part location block inside the existing cash-hold panel: an address
card, a "Cum ajungi" directions button deep-linking to Google Maps, and a tappable phone card
(`tel:+37360120220`). It sits inside `[data-cash-panel]`, so it inherits that panel's
visibility (pending cash only) — **no new JS, no new visibility logic**. The directions link
targets the **office** coordinates `47.038340170580554,28.858273527875323` (the Chișinău pay
office), which is deliberately a *different* location from the resort/check-in directions link
on the confirmation celebration panel (`maps.google.com/?q=EcoVila+Orheiul+Vechi`, ADR/`MAPS_URL`).

**One canonical address string, kept literal in all three languages.** The full address is
`Str. Aerodromului 3, Wine Hotel, et.3, cab.301`, used verbatim everywhere it appears — the
manage-page card, the checkout cash disclaimer (modal + inline, ro/ru/en), and the Terms page
(`termeni-conditii.html` + its `docs/` source). It is **not** localized: the street was already
kept untranslated inside the RU/EN disclaimers, so a single literal string both matches that
convention and keeps wayfinding (the room "cab.301" a guest reads off the page) identical to the
physical signage. Implemented by repurposing the previously-dead `confirmare.officeAddress` key
to hold the full address (one source of truth, reused by the card); the card's label and the
directions button reuse the existing localized keys `confirmare.officeLabel` and
`confirmare.directions`. New CSS is a small `.cf-office*` family in `css/confirmation.css` that
reuses the existing `cf-` card/button tokens.

**Deliberately NOT changed — and why it stays frontend-only.** *(Superseded by ADR-062: the owner
later clarified the resort is in Old Orhei with no street address, so this email's address line was
removed entirely — making it a backend follow-up.)* The arrival-reminder email
(`_shared/notifications.ts`, `composeArrivalReminder`) still reads "Adresa: str. Aerodromului 3".
That line is the **check-in/arrival address for the stay**, a distinct concept from the cash pay
office — appending an office room number ("cab.301") there would misdirect a guest arriving to
check in. Leaving it untouched also keeps this change purely client-side: **no Edge Function
redeploy, no migration.** If the owner later wants the email address standardized too, that is a
separate function deploy.

**Scope.** `gestionare.html`, `css/confirmation.css`, `js/translations.js`, `checkout.html`,
`termeni-conditii.html`, `docs/termeni-conditii.md`. Verified in the static preview (address,
maps deep-link, `tel:` href, and all three localizations resolve). Ships via the TopHost upload.

### ADR-062 — Arrival-reminder email drops the address line entirely (resort is in Old Orhei, no street address)

**Date:** 2026-06-19.

ADR-061 left the arrival-reminder email (`_shared/notifications.ts`, `composeArrivalReminder`)
reading "...pe teritoriul complexului. Adresa: str. Aerodromului 3.", treating it as the check-in
address. The owner clarified the resort sits in **Old Orhei (Orheiul Vechi) and has no street
address there** — "str. Aerodromului 3" is the Chișinău pay office only, so naming it as the
arrival/check-in location was simply wrong.

**Decision.** Remove the address sentence from the email body; keep the no-pets notice
("...nu este permis pe teritoriul complexului."). The arrival **SMS** (`arrivalReminderSms`) never
carried an address, so the reminder is now address-free in every channel. No test asserted the body
(the existing test checks only the SMS), so none needed changing; the full Deno suite stays green
(89 passed).

**Deploy.** Backend change to one shared module, so it ships as an **Edge Function deploy of
`send-reminders`** — *not* a TopHost upload. Per the owner it is bundled with a separate pending
change and was deliberately left uncommitted/undeployed in this session.

---

### ADR-063 — Guest headline count is read from one booking-group row, never summed across rooms

**Date:** 2026-06-19.

A guest who booked **two hotel rooms** for a family of **3 adults + 4 children** (ages 7, 11,
11, 11) saw their confirmation page report **"6 adulți · 8 copii"** — exactly double. The admin
edit modal, the price (7.950 MDL) and the payment were all correct; only the headline guest count
on the guest-facing pages was wrong, and the doubling factor equalled the room count.

**Root cause.** The data model replicates the **full party on every room row** of a booking group
and *partitions* only the price. The server guarantees this: `pricingGuard.verifyReservationGroupPricing`
rejects any booking whose rows differ from the first in `adults`/`kids_ages`, computes the price
once from the first row with `units = rows.length`, then `splitTotal` divides the total across
rooms; `reservationChanges.applyBookingChange` rewrites **every** row in the group with identical
`new_adults`/`new_kids_ages`. So the correct reads are: **sum `total_price` across rows** (price is
split) but **take the party from a single row** (party is replicated).

`confirmare.js#formatGuests` and `gestionare.js#formatManagedGuests` instead did
`rows.reduce((s, r) => s + r.adults, 0)` and `rows.flatMap(r => r.kids_ages)`, summing the
replicated party across rooms. One room → correct; N rooms → party ×N. Everywhere else already read
a single row: `anulare.js` (`reservation.adults`), the manage edit modal and add-guests flow
(`reservations[0]`/`rows[0]` as the primary), the admin CRM (per-room `reservation.adults`), and the
confirmation email/SMS (which carry no party count at all). Those were never affected.

**Decision.** Both formatters now read the party from the primary row (`rows[0]`) — `adults =
Number(primary.adults || 0)`, `kids = primary.kids_ages` — instead of aggregating. Price totals are
untouched (still summed, which is correct). A scope sweep (`reduce`/`flatMap`/`forEach` over
`adults`/`kids_ages` across all of `js/` and `admin/js/`) confirmed these were the only two sites
that collapsed a booking group into a single headline party count; no other bug of this kind exists.

**Admin towels — deliberately NOT changed.** `admin/js/crm-daily.js#guestCount` returns the full
per-room party and feeds the daily towel-card count (`towelCardsFor`). For a multi-room booking each
room card therefore suggests towels for the whole family, with a manual `towel_cards_issued`
override. Whether that is over-issuance or intended per-room provisioning is a staff-workflow
question, not a guest-facing display bug, so it is left for the owner to decide rather than silently
altered.

**Tests.** New `tests/guest-party-display.test.mjs` exercises both exported formatters against the
exact 2-room report scenario and asserts the result is independent of room count and never the
doubled output (8 cases). The two modules now export `formatGuests` / `formatManagedGuests` for this
(matching how `anulare.js` exports its helpers). Full suite green: Node 264 passed, Deno 89 passed.
Also verified in-browser on the running static server — both pages render "3 adulți · 4 copii".

**Deploy.** Frontend-only (two `.js` files); ships as a **TopHost upload** of `js/confirmare.js` and
`js/gestionare.js` — no migration, no Edge Function deploy. The test file is repo-only.

---

### ADR-064 — Low-stock urgency cue on the booking cards ("only N left for your dates")

**Context.** The accommodation cards showed price and availability but nothing to convey scarcity. A
genuine low-stock signal nudges guests to book while staying truthful — the resort really does sell
out of a given type on popular dates.

**Decision.** Each card surfaces a low-stock cue once live availability for the *chosen* range drops
to **3 units or fewer** (`SCARCITY_THRESHOLD`) for a type the party can actually book. The trigger is
a pure, unit-tested helper `calendar.getScarcityState({ availableCount, neededUnits, isAvailable,
threshold })` → `{ active, count, isLastOne }`. `booking.js` calls it only in the dates-selected
branch of `getCardInfo`; the preview (no dates) and party-unavailable branches carry an inert
`INACTIVE_SCARCITY`, so the cue can never appear before real dates are chosen.

**Presentation — deliberately plain, not a badge.** The cue is rendered *inline on the card's own
availability line* (`data-card-availability`), reusing the slot and typography that shows "first free
date" while browsing, instead of a separate pill. It is warm-amber plain text (`--scarcity-ink
#99490F`, from the existing `.facility-heat-banner` "heat" family — not alarm-red) with a small
breathing status dot (`::before`, `@keyframes scarcityBreathe`, disabled under
`prefers-reduced-motion`). Exactly one unit left escalates to terracotta (`#8A3A12`) with singular
copy. Copy is localised in ro/ru/en with singular/plural forms (`booking.scarcityLast` /
`booking.scarcityFew`); the wording is gender-correct without per-type strings because the RO
accommodation nouns are all feminine (*căsuță/cameră* → "disponibilă/disponibile") and the RU ones
all masculine (*домик/номер* → "последний" / neuter "осталось").

**Tests.** `tests/booking-core.test.mjs` exercises `getScarcityState` across the threshold edges
(>3 inert, 3 active, 1 → `isLastOne`, sold-out/party-unavailable inert, derived availability,
configurable threshold). `tests/booking-page.test.mjs` asserts the cue rides the availability line
(no pill element or styles), is plain warm text with a breathing dot, is motion-safe, and is
localised in every public language. Full suite green: Node 266 passed. Also verified in-browser on
the running static server — no cue without dates; amber base / terracotta last-one.

**Deploy.** Frontend-only — no migration, no Edge Function. Ships as a TopHost upload of
`css/booking.css`, `js/booking.js`, `js/calendar.js`, and `js/translations.js` (`rezervari.html` is
unchanged — the cue reuses an existing element). Test files are repo-only.

---

### ADR-065 — Email is optional for staff (office) reservations; the public path still requires it

**Context.** The CRM "Adaugă rezervare" form already let staff submit without an email, but a blank
field was silently stored as the company inbox `rezervari@ecovila.md`, because
`reservations.guest_email` was `NOT NULL` with a check requiring an `@`. Walk-ins often have no
email, and fabricating one contradicts the deliberate no-stand-in stance taken for `guest_phone`
(ADR-059) — and the UI gave no hint the field was optional.

**Decision.** Make email genuinely optional for staff bookings. The migration only **drops the
`NOT NULL`** on `guest_email`: the existing `reservations_guest_email_check
( position('@' in guest_email) > 1 )` already permits `NULL` — a CHECK constraint passes when its
expression evaluates to `NULL`, not just `TRUE` — so a `NULL` email is accepted while malformed
non-null values (`''`, `'foo'`) stay rejected. The CRM row builder
(`admin/js/crm-sidebar.js`) stores `null` when the field is blank instead of the stand-in address,
and the form label reads **"Email (opțional)"** (`admin/dashboard.html`, `.crm-field-optional`).

**The public path is unchanged.** `create-reservation` still hard-requires a valid email
(`_shared/reservations.ts`, `EMAIL_PATTERN`), so only staff-added `office` reservations can be
emailless — guest bookings always carry one.

**Senders are null-safe at one chokepoint.** `_shared/providers.ts` `sendEmail` now no-ops (returns
`{ skipped: true }`) when there is no recipient, *before* reading any `RESEND_*` env — mirroring the
`skipped` shape the SMS path already returns. That single guard protects every sender (arrival
reminders, cancellations, change confirmations) from a Resend 422 on an emailless office
reservation, while the SMS still dispatches independently (`dispatchNotification` and the cancel
flows use `Promise.allSettled`; `reservationChanges` already guarded `if (emailTo)`). The functions
that send to `guest_email` for reservations that can now be emailless — `send-reminders`,
`reservation-cancel`, `reservation-cancel-notify` — were redeployed; payment/settlement functions
never touch `office` reservations.

**Tests.** `tests/admin-crm.test.mjs` asserts a blank email stores `null` (not a stand-in) and that
the field is labelled optional and never `required`. A new `supabase/functions/tests/providers.test.ts`
asserts empty/whitespace/array recipients skip the provider call (no env needed) while a real
recipient still posts. Full suite green: Node 268, Deno 91.

**Deploy.** Migration `20260619160000_optional_guest_email.sql` applied to prod via
`supabase db query --linked` + `migration repair` (the drift-aware path — see the migration-drift
note); `send-reminders` / `reservation-cancel` / `reservation-cancel-notify` redeployed with
`verify_jwt` preserved from `config.toml`. The frontend (`admin/dashboard.html`,
`admin/js/crm-sidebar.js`, `css/crm.css`) ships as a TopHost upload — pending.

---

### ADR-066 — Children require a per-type adult-supervision minimum on the booking page

**Context.** `rezervari.html` let a party add children with far too few adults. The availability
gate `pricing.isTypeAvailableForParty` only required **one adult per room for every type**
(`adults >= neededUnits`), and because children also spill into a room's empty adult slots (a
deliberate billing detail), a single adult could pull in a pile of children — e.g. **1 adult + 5
children in a large villa** read as bookable.

**Decision.** Introduce a per-type child-supervision minimum, enforced **per room** and only when
children are present: **1 adult per room for hotel rooms and small villas, 2 adults per room for
large villas**. Each `ROOM_TYPES` entry gains a `minAdultsForChildren` field (small 1, large 2,
hotel 1) and the predicate becomes
`adults >= neededUnits * (kids > 0 ? minAdultsForChildren : 1)`. When a party exceeds the limit the
card flips to the existing **"Indisponibil / Недоступно / Unavailable"** badge
(`booking.unavailableForParty`) and hides the reserve button — no new copy needed. Adults-only stays
are unaffected (a lone adult can still book a large villa with no kids).

**Billing is untouched.** `isTypeAvailableForParty` is an availability predicate only — it is never
called by `calculateStayPrice`, `getUnitsNeeded`, or `calculateBillableGuests`, and the billing floor
(`minimumAdults`) is unchanged. The new gate is strictly *stricter* than before, so anything still
bookable was already valid at checkout. Both `pricing.js` copies (`js/` and
`supabase/functions/_shared/`) were kept byte-identical to avoid drift; the server copy is inert (no
Edge Function calls the predicate), so **no function deploy is required**.

**Tests/verify.** 14 hand-checked party cases (large 1A+1K → unavailable; large 2A+2K → available;
hotel/small 1A+2K → available; large 1A+5K → unavailable). Live in-browser DOM confirmed
1A+1K → large `Indisponibil` with small/hotel available, and 2A+1K → large available. Full suite
green.

**Deploy.** Frontend `js/pricing.js` ships in this TopHost upload. `_shared/pricing.js` synced
in-repo only.

---

### ADR-067 — Site-wide asset cache-busting via a shared `?v=` version stamp

**Context.** Every page referenced its CSS/JS with no version query, and `.htaccess` sets no cache
policy, so returning visitors could keep running stale CSS/JS from heuristic browser caching after a
deploy — including the admin CRM.

**Decision.** Stamp a single shared `?v=<version>` token onto **every local stylesheet and script
reference across all shipped HTML** (root pages + `en/` + `ru/` + `admin/`). A single global token
(not per-file content hashes) is intentional: bumping it refetches *every* asset at once, which is
the "everyone sees the new build" behaviour the owner asked for. The mechanism is a reusable script
`scripts/stamp-asset-versions.mjs` (`npm run bump:assets [version]`, default `YYYYMMDD`) that walks
the TopHost deploy entries, rewrites local `.css`/`.js` `href`/`src`, **replaces** an existing `?v=`
in place (re-runnable, never stacked), and skips external / protocol-relative / `data:` URLs (Google
Fonts, the Supabase CDN, etc.). First bump: **`?v=20260619` across 15 HTML files, 146 references.**

**Why HTML-level stamping is sufficient.** There are no CSS `@import`s, no `type="module"`/dynamic
JS imports, and no runtime-loaded local scripts, so every css/js asset is reachable from an HTML
tag. For the new token to be seen the HTML itself must be refetched; since `.htaccess` sets no
long-cache and a freshly re-uploaded HTML file has ~0 heuristic freshness, browsers revalidate it
promptly. (Optional future hardening — explicit `Cache-Control`: HTML `no-cache` + versioned assets
`immutable` — was left out to stay in scope.)

**Tests.** `tests/asset-versioning.test.mjs` unit-tests the stamper (adds/replaces the token across
all path styles, skips external/data URLs, leaves html-page links and images alone, `YYYYMMDD`
default) and adds a **regression guard** that no shipped HTML page contains an unversioned local
css/js reference. The exact-URL assertions in `booking-page`, `checkout`, `legal-pages`, and
`supabase-wiring` tests were relaxed to tolerate the `?v=` token. Full suite green: Node 276.

**Deploy.** Frontend-only — a TopHost upload of all HTML (plus the unchanged css/js they reference).
Re-run `npm run bump:assets <version>` on any future deploy that changes CSS/JS.

---

### ADR-068 — Guest complaints page + admin "Probleme" tab + check-in welcome SMS

**Context.** Guests had no channel to flag problems with their stay, and staff had no triage surface
for such reports. The owner asked for a public `ecovila.md/complaints` page (phone-OTP login, even
for long-past stays), an admin tab visible to both Diana and Angela, and a localized welcome SMS
linking the page when a guest checks in.

**Decision — guest flow.** A new `complaints.html` reuses the existing phone-OTP pattern. Three
public edge functions (`complaint-login-start`, `complaint-login-verify`, `complaint-submit`,
`verify_jwt=true`, all rate-limited per ADR-060) back it. The login-code SMS (`composeLookupCodeSms`)
is now **localized RO/RU/EN** from the caller's page language, which also localizes the existing
reservation-lookup OTP (`reservation-lookup-start` passes the browser language). Login storage
**reuses `reservation_lookup_codes`**; the login-code hash uses a distinct `complaint_login_code` prefix so a
complaint code can never satisfy `reservation-lookup-verify` (cross-redeem is unit-tested). Verify
mints a 30-minute `complaint_sessions` token — a dedicated store, deliberately **isolated** from the
reservation-management manage-token so a complaint login grants no booking-management capability.
Eligibility = the phone has ≥1 **paid** reservation (any date). The "Vreau anonim" toggle is **fully
anonymous**: anonymous rows persist no phone/name/reservation (DB `complaints_anonymous_identity_check`
constraint), so they are unlinkable rather than merely hidden.

**Decision — admin.** A `probleme` tab (added to `TAB_NAMES` and `ROLE_TABS.angela`) with a
current/archive switch and per-row "Mark as solved". A **per-staff** unread badge counts complaints
created after that user's own `complaint_read_state.last_seen_at`, cleared when they open the tab.
The list/badge update live via realtime on `public.complaints`. Complaint text renders via
`textContent` only (no innerHTML) so a description cannot inject markup. Inserts are service-role only
(no insert RLS policy); both roles get read + update (mark-solved).

**Decision — welcome SMS.** Fires from the existing CRM check-in action (`saveCheckIn` →
`send-checkin-welcome`, staff-gated), not a date cron, so it lands on real arrival. It is SMS-only
(empty email recipient → `sendEmail` no-ops) and deduped via `notification_events`
(`checkin_welcome`, keyed on the booking-group owner) so multi-villa bookings / re-toggled check-ins
send exactly once. Copy is localized RO/RU/EN within one segment (RO/EN ≤160, RU ≤140) and the
lengths are asserted in tests.

**Tests.** `tests/complaints.test.mjs` (wiring: migration, functions, page, admin, htaccess, i18n)
and `supabase/functions/tests/complaints.test.ts` (category/description/hash helpers, cross-redeem
safety, welcome-SMS localization + length bounds). Full suite green: Node 302 + Deno 96.

**Deploy.** Apply `20260619170000_complaints.sql`; deploy the 4 new functions **plus the changed
`reservation-lookup-start`** (OTP localization); TopHost-upload the frontend (`complaints.html`,
css/js, admin, `.htaccess`). The clean `/complaints` URL is served by an `.htaccess` rewrite.

---

### ADR-069 — Admin "Probleme" card redesign: uniform tiles + click-to-expand detail modal

**Context.** The ADR-068 "Probleme" tab shipped functional but visually weak: one full-width card
per row, ragged heights (a one-word report sat as tall as a paragraph), no category cues, and no way
to read a long complaint without the card growing unbounded. The owner asked for a better-looking
page where **cards are always the same size**, long text is cropped unless expanded, and the same
treatment applies to the active (current) tab — as the last step before the ADR-068 frontend goes to
prod.

**Decision — layout.** The list is a responsive grid (`repeat(auto-fill, minmax(360px, 1fr))`) of
fixed-dimension tiles. Uniform height is *deterministic*, not `align-items`-dependent: the
description is locked to a 3-line box (`height: 4.5em` + `-webkit-line-clamp: 3` + `overflow:hidden`)
and the footer is forced onto a single line (`flex-wrap: nowrap`; the guest name truncates with
ellipsis while the phone link and action stay `flex: none`). So `head + clamped-text + 1-line-footer`
sums to the same height for every card regardless of content — verified at 192px across long, short,
and one-word descriptions in 1/2/3-column layouts. Cards are colour-accented per category (moss /
clay / teal / sage via a `--accent` custom property driving the left strip, dot, and chip tint), the
tabs became a segmented control, and a live result count sits beside them.

**Decision — detail modal.** Clicking a card (mouse, or Enter/Space when focused) opens a centered
dialog with the **full, unclamped** description, the guest identity, and the same resolve action.
Clicks on the in-card phone link or resolve button are excluded via `event.target.closest('a, button')`
so they keep their own behaviour. The modal is a lazily-created singleton appended to `<body>`
(`z-index: 1000`, above all CRM chrome at ≤60, and outside any transformed ancestor so `position:
fixed` is viewport-anchored); it closes on the ✕ button, backdrop click, or Escape, locks body scroll
while open (`.crm-modal-open`), and restores focus to the opener on close. The card uses a short
"Rezolvă" label to protect the single-line footer; the modal shows the full "Marchează rezolvată".

**Safety.** Unchanged from ADR-068 — every guest-supplied value (description, name, phone) is still
written with `textContent`; only the fixed feather-style icon set uses `innerHTML`, from trusted
module constants that never touch complaint data. The public module API (`init`, `showPanel`,
`setView`, `renderList`, `buildCard`) is unchanged, so `crm-app.js` wiring is untouched.

**Tests.** No new tests — this is a presentational change to the admin card builder/CSS with no new
data paths; the existing `tests/complaints.test.mjs` wiring assertions still pass (Node 303). Verified
in a local dev server: identical 192px heights, ellipsis crop, modal open/close (current → resolve
button, archive → "Rezolvată" pill), body-scroll lock, mobile single-column with no footer overflow,
and a clean console.

**Deploy.** Frontend-only; no migration, no functions. Ships with the still-pending ADR-068 TopHost
upload under the existing unserved `?v=2026061901` token (bumped in 7a35de7 for this deploy), so
caches bust naturally — no asset re-bump. Files: `admin/dashboard.html`, `admin/js/crm-complaints.js`,
`css/crm.css`.

---

### ADR-070 — SPA & dining facility modals on the `en/`/`ru/` homepages (parity with RO)

**Context.** The Romanian homepage (`index.html`) has an interactive **facility detail modal**: a
"Descoperă zona SPA" CTA in the SPA section and a "Vezi ce este inclus" CTA in the restaurant section,
each opening a `[data-facility-modal]` dialog (photo gallery + localized title/body/highlights, plus a
"all pools heated" heat banner for SPA), driven by `js/facilities.js`. The localized homepages
`en/index.html` and `ru/index.html` were forked without any of it — the two CTAs, the modal markup, and
the `facilities.js` script tag were all absent, so EN/RU visitors got static SPA/restaurant sections with
no way to open the gallery+detail view their RO counterparts have.

**Decision.** Port the feature verbatim into both localized pages, mirroring the RO markup but with
localized fallback text (the live text is supplied by `data-i18n` either way):

- SPA section gains `<div class="showcase__cta"><button … data-facility-open="spa" data-i18n="showcase.spa.cta">`.
- Restaurant section gains `<div class="image-hero__cta"><button … data-facility-open="dining" data-i18n="showcase.restaurant.cta">`.
- The full `[data-facility-modal]` dialog is added before the script block (close `aria-label` localized
  to "Close"/"Закрыть"; `data-facility-highlights-label` fallback "What awaits you:"/"Что вас ждёт:").
- `<script src="/js/facilities.js?v=2026061901">` is added after `main.js`.

No JS, CSS, or translation changes were needed: every `data-i18n` key the feature uses
(`showcase.spa.cta`, `showcase.restaurant.cta`, `facilities.highlightsLabel`, the full `facilities.*`
content set) already exists in all three locales in `js/translations.js`, and `facilities.js` already
guards `if (!modal) return` and treats the cards-list as optional, so it runs correctly on a
CTA-only homepage. After the change the `data-i18n` key set and local `<script>` set on all three
homepages are identical (verified by diff); only human-readable text and the per-locale meta/schema
differ.

**Tests.** No new automated tests — frontend-only static-HTML parity change with no new data paths.
Verified in a local dev server: EN SPA modal opens with English content ("SPA & Relaxation", "What
awaits you:", 10 highlights, gallery), RU dining modal opens with Russian content ("Питание
All-Inclusive", 10-photo gallery), and a clean console on both.

**Deploy.** Frontend-only; no migration, no functions. Ships with the still-pending ADR-068 TopHost
upload under the existing unserved `?v=2026061901` token, so caches bust naturally — no asset re-bump.
Files: `en/index.html`, `ru/index.html`.

---

### ADR-071 — Localize the i18n strings that bypassed the translation system (aria-labels, conference labels, reserve button)

**Context.** An audit of every `data-i18n` key (243 distinct, all resolving; `ro`/`ru`/`en` at
parity) confirmed the data layer was complete — but several user-facing strings bypassed the i18n
system entirely and stayed Romanian for EN/RU visitors:

- Button **aria-labels** were never translated: `applyLanguage()` in `js/main.js` only set
  `textContent`, never attributes. Affected the guest counter ± buttons ("Scade/Adaugă adulți/copii"),
  calendar nav ("Luna precedentă/următoare"), modal close buttons ("Închide"), `.guest-picker`
  ("Persoane"), `.booking-amenities` ("Facilități incluse") and `.photo-stack` ("Zona SPA").
- The conference **"Telefon:" / "E-mail:"** labels and the booking-detail modal **"Rezervă acum →"**
  button were hardcoded with no `data-i18n`.
- The static `en/`/`ru/` homepages — which do **not** run `applyLanguage` (they use the per-folder
  `data-static-lang-select` switcher) — had those same strings hardcoded in Romanian.

**Decision.**

- Extend `applyLanguage()` to also translate attributes: `data-i18n-aria-label`→`aria-label`,
  `data-i18n-placeholder`→`placeholder`, `data-i18n-title`→`title`. The literal attribute is kept as a
  no-JS / RO fallback. This runs on every dynamic interior page that loads `main.js`.
- Add 13 keys × 3 locales to `js/translations.js`: `conference.phoneLabel`, `conference.emailLabel`,
  `booking.reserveNow`, and `aria.{close,guests,spaZone,decreaseAdults,increaseAdults,decreaseChildren,increaseChildren,prevMonth,nextMonth,facilitiesIncluded}`.
- Wire the dynamic pages (`rezervari.html`, `site.html`, `confirmare.html`) via `data-i18n` /
  `data-i18n-aria-label`. The `rezervari.html` reserve button already carried `data-i18n="booking.select"`
  (owned by `booking.js`) and was left untouched.
- Hardcode the correct per-locale text on the static homepages (`en/index.html`, `ru/index.html`);
  `index.html` (RO) was already correct.

**Intentionally left RO.** The legal pages (`termeni-conditii.html`, `politica-confidentialitate.html`)
declare "Textul juridic este afișat în limba română"; `admin/` is a RO-only staff tool; brand terms
(EcoVila, the "All-Inclusive" badge), emails/address, and interior-page `<title>` tags (canonical RO for
SEO — one URL serves all languages) are deliberately not translated.

**Tests.** No new automated tests — frontend-only, no new data paths. Verified on a local dev server
across RO/EN/RU: `rezervari.html` aria-labels switch language live (EN "Decrease adults" /
"Previous month" / "Included facilities" / "Close"; RU equivalents), `site.html` conference labels +
reserve button localize, and the `en/`/`ru/` homepages render their hardcoded labels/button. Clean
console on all.

**Deploy.** Frontend-only; no migration, no functions. Because this changes `js/main.js` and
`js/translations.js`, the shared cache-bust token is bumped `2026061901 → 2026062001` (ADR-067), so this
upload also carries the still-pending ADR-068 and ADR-070 frontend. Files: `js/main.js`,
`js/translations.js`, `rezervari.html`, `site.html`, `confirmare.html`, `en/index.html`,
`ru/index.html`, plus the site-wide `?v=` bump on all shipped HTML.

---

### ADR-072 — Transactional SMS: drop the redundant "EcoVila:" body prefix and Romanian diacritics

**Context.** Every transactional SMS body (lookup-code OTP, expired-cash cancellation, booking-change
confirmation) opened with a literal `EcoVila:` prefix, and the Romanian copy carried diacritics
(`ă/â/î/ș/ț` — "anulată", "Puteți", "actualizată"). Two costs: (1) the SMS.md sender is already the
alphanumeric originator `SMSMD_FROM` = "EcoVila", so the handset shows "EcoVila" as the sender and the
in-body prefix merely duplicated it; (2) any non-GSM-7 character (the diacritics) forces the whole
message into UCS-2 encoding, which drops the per-segment limit from 160 to 70 chars and can split a
one-segment SMS into two billable parts.

**Decision.** Remove the `EcoVila:` prefix from all three locales of `composeLookupCodeSms`
(`reservationManage.ts`) and of `expiredCashCancellationSms` / `bookingChangeSms` (`notifications.ts`),
and strip diacritics from the Romanian variants ("anulata", "Puteti", "actualizata"). Russian keeps
Cyrillic (unavoidably UCS-2); English was already plain ASCII. Email copy is untouched — this is only
about SMS, where length and encoding are billed.

**Tests.** `reservation-manage.test.ts` asserted `ru.includes('код')`; the RU body now starts with a
capital "Код", so the check was relaxed to `.toLowerCase().includes('код')` (still proves the RU SMS is
translated). Full `deno task test` suite green (97 passed).

**Deploy.** Backend-only; no migration. Takes effect only when the functions importing these shared
composers are redeployed (lookup/OTP, cash-expiry cancellation, booking-change). **Not yet deployed —
pending owner sign-off.** Files: `supabase/functions/_shared/notifications.ts`,
`supabase/functions/_shared/reservationManage.ts`,
`supabase/functions/tests/reservation-manage.test.ts`.

---

### ADR-073 — Off-platform daily database backups to Google Drive + OneDrive

**Context.** Booking data lived only inside Supabase. We wanted an independent, owner-controlled copy
that survives a Supabase account/project loss, without standing up new infrastructure or a paid service.

**Decision.** A scheduled GitHub Actions workflow (`.github/workflows/backup.yml`, 02:30 UTC daily +
manual `workflow_dispatch`) runs `scripts/backup-supabase.sh`, which dumps roles/schema/data plus a
`public.reservations` CSV into a dated tarball and `rclone copyto`s both the tarball and a standalone
CSV to two remotes (`gdrive`, `onedrive`), then prunes copies older than 90 days. Configuration travels
as two GitHub secrets: `SUPABASE_DB_URL` (the Session Pooler / IPv4 connection string) and
`RCLONE_CONF_BASE64` (base64 of the local `rclone.conf`). Full runbook in `docs/BACKUP_SETUP.md`.

**Unencrypted by choice.** The tarball and CSV contain guest PII and are stored unencrypted so restore
is dead-simple (double-click the CSV). The mitigation is access control — both Drive folders stay
private. The script is crypt-ready: wrapping the remotes in an `rclone crypt` layer later needs no
script change.

**Status.** Code committed, but the pipeline is inert until the owner does the one-time setup —
authorize the two rclone remotes locally and add the two GitHub secrets. Until then each scheduled run
fails harmlessly (missing secrets, no side effects). No application code, migration, or edge function is
affected. Files: `.github/workflows/backup.yml`, `scripts/backup-supabase.sh`, `docs/BACKUP_SETUP.md`.

---

### ADR-074 — 1080p homepage hero video with progressive (play-as-it-buffers) playback

**Context.** The homepage hero served a soft 720p file (`assets/videos/ecovila-hero.mp4`,
1280×720, ~1 Mbps, 3.8 MB). Two unused 1080p masters already lived in the repo root:
`ecovilavideo.mp4` (HEVC — Safari-only support) and `ecovilavideo-web.mp4` (H.264). We wanted
real 1080p without making visitors download the whole clip before it starts.

**Decision.** Re-encoded `ecovilavideo-web.mp4` into two web-tuned, faststart 1080p sources with
audio stripped (the hero is muted): `assets/videos/ecovila-hero-1080.webm` (VP9, ~7.9 MB) and
`assets/videos/ecovila-hero-1080.mp4` (H.264 high, +faststart, ~10 MB), both 1920×1080 at
~2.3–2.8 Mbps. The `<video>` in `index.html`, `en/index.html`, `ru/index.html` now lists the WebM
first (Chrome/Firefox/Android) with the MP4 as the universal fallback (Safari), and
`preload="metadata"` → `preload="auto"`. The old 720p file is deleted.

**"YouTube-like" buffering is progressive download, not adaptive streaming.** HLS/DASH would be
overkill for a 28 s muted loop on shared hosting. Two ingredients deliver play-as-it-buffers: the
`moov` atom at the **front** of the MP4 (`-movflags +faststart`) and Apache serving the file with
`Accept-Ranges: bytes`, which TopHost does by default for static files. `.htaccess` now also pins
`video/mp4`/`video/webm` MIME types and a 1-year cache (the version is in the file name, so a
re-encode is a new URL — safe to cache hard).

**Encode recipe** (re-run when the master changes):

```
ffmpeg -i ecovilavideo-web.mp4 -an -c:v libx264 -profile:v high -crf 27 \
  -maxrate 3500k -bufsize 7000k -preset slow -pix_fmt yuv420p \
  -movflags +faststart assets/videos/ecovila-hero-1080.mp4
ffmpeg -i ecovilavideo-web.mp4 -an -c:v libvpx-vp9 -crf 36 -b:v 2000k \
  -row-mt 1 -pix_fmt yuv420p assets/videos/ecovila-hero-1080.webm
```

**Status.** Code committed and pushed to `main`; `dist/tophost` rebuilt via
`npm run prepare:tophost`. Goes live once the folder is uploaded to TopHost — no backend,
migration, or edge function involved. The root master `ecovilavideo-web.mp4` is intentionally
retained as the re-encode source; it is root-level and not in the upload manifest, so it is never
deployed. Files: `assets/videos/ecovila-hero-1080.{mp4,webm}`, `index.html`, `en/index.html`,
`ru/index.html`, `.htaccess`.

---

### ADR-075 — Pre-production audit sweep: two fixes (hero parity + robots /admin/)

**Context.** Before a production push, ran a full-codebase audit: node + deno test suites
(303 + 97 green), JS parse / TS type-check, pricing client↔server parity, XSS surfaces
(dynamic data uses `textContent`, only developer translation strings reach `innerHTML`), CORS
allowlisting, tabnabbing, `parseInt` radix, duplicate element IDs, broken local links/assets,
`<img>` alt coverage, translation-key parity (425 keys identical across ro/ru/en, no undefined
referenced keys), canonical/hreflang/sitemap/og:image/JSON-LD validity, guarded `JSON.parse`
(frontend + edge functions), `noindex` scope, and merge-conflict markers. The codebase was clean;
the audit surfaced two issues.

**Fix 1 — hero video parity (`site.html`).** ADR-074 swapped the homepage trio to the 1080p
hero sources and deleted the old 720p `ecovila-hero.mp4`, but the legacy `site.html` landing
(still in the TopHost upload manifest and asserted by `tests/landing.test.mjs`) was missed and
left pointing at the deleted file — a broken reference that also failed the asset-existence test.
Updated its `<video>` to the same WebM-first + MP4-fallback sources and `preload="auto"`.

**Fix 2 — `robots.txt` admin exclusion.** robots.txt groups do not inherit, so the named
crawler groups (Googlebot, Bingbot, the AI bots, etc.) carried only `Allow: /` and were not
covered by the `Disallow: /admin/` that lived solely in the `*` group — i.e. a named search bot
was technically permitted to crawl `/admin/`. Practical risk was already nil (admin pages are
`noindex` and auth-gated), but added `Disallow: /admin/` to every named group as defense-in-depth.

**Status.** Both fixes committed and pushed to `main`; `dist/tophost` rebuilt via
`npm run prepare:tophost`. Frontend-only, ships with the ADR-074 upload — live on next TopHost
upload. Files: `site.html`, `robots.txt`.

---

### ADR-076 — Localized FAQ pages (`/ru/voprosy.html`, `/en/faq.html`) + i18n cross-language link fixes + Cyrillic brand schema

**Context.** The homepage trio (ADR-016) has distinct per-language URLs with hreflang, but
every interior page was single-URL with client-side JS translation — so the RU/EN FAQ had no
crawlable URL, no hreflang, and was invisible to search in those languages (the interim
three-language `@graph` of FAQPage entities on the one RO URL, ADR-024, was non-standard).
Separately, a reserve button on the `en/`/`ru/` homepages 404'd, and the brand was spelled in
Latin everywhere (`EcoVila`/`Eco Vila`), giving no relevance signal for the common Cyrillic
query "эко вилла". Resolves the FAQ-split open question carried since ADR-024.

**Localized FAQ pages.** Added static, fully-translated `/ru/voprosy.html` and `/en/faq.html`
(homepage-trio model: hardcoded per-language copy, `data-static-lang-select`, absolute
asset/link paths). Each carries a self-canonical, a reciprocal hreflang cluster
(ro/ru/en/x-default → RO), localized title/description/og, and ONE `FAQPage` JSON-LD in its own
language. The RO `intrebari-frecvente.html` was converted dynamic→static and its `@graph`
trimmed to a single RO FAQPage (the RU/EN FAQPage moved to their own URLs). `sitemap.xml` gained
the two URLs plus a hreflang cluster on all three FAQ entries. Homepage FAQ CTAs now point at the
per-language URL.

**main.js static-switcher generalized.** `<option data-lang="…">` lets static pages whose slug
isn't `/ru/` or `/en/` (e.g. `/ru/voprosy.html`) select and navigate correctly; homepages omit
it and keep the legacy `/`,`/ru/`,`/en/` value mapping (backward compatible). Static pages now
persist their page language to `localStorage` on load, so a visitor landing straight on `/ru/…`
makes downstream dynamic pages (booking, legal) inherit RU instead of defaulting to RO.
`localizeInteriorLinks()` rewrites any `intrebari-frecvente.html` link to the visitor's localized
FAQ (future-proofing; today only `index.html` and the RO FAQ self-link match — interior pages
have no FAQ link).

**Reserve-button 404 fix.** The accommodation-modal reserve handler used a relative
`window.location.href = 'rezervari.html'`, which under `/ru/`,`/en/` resolved to the
non-existent `/ru/rezervari.html`. Made it absolute `/rezervari.html`.

**Cyrillic brand schema.** Homepage `alternateName` on both the `LodgingBusiness` and
`Organization` nodes is now `["Eco Vila", "Эко Вилла", "Эковила"]` across all three homepages,
so the entity carries the Cyrillic brand form (was Latin-only).

**FAQ content refresh.** Two stale answers corrected to match the current site: a4 (booking) —
online-first on the booking page, pay online by card (Maib) or instant MIA QR, or cash at the
office, phone as alternative (previously read as "call only"); a7 (cancel/change) — self-service
online via the confirmation link (status / extend deadline / cancel) with the ≥20-days-before-
arrival (or <2h-since-booking) card-refund rule (ADR-057). Updated in all three FAQ pages
(visible + JSON-LD) and the now-unused `translations.js` `faq.a4`/`faq.a7`.

**Status.** Committed and pushed to `main`; asset token bumped to `?v=2026062002`
(`npm run bump:assets`) and `dist/tophost` rebuilt (`npm run prepare:tophost`) — live on next
TopHost upload. Frontend-only (no migration/functions). Files: `index.html`, `ru/index.html`,
`en/index.html`, `ru/voprosy.html` (new), `en/faq.html` (new), `intrebari-frecvente.html`,
`js/main.js`, `js/translations.js`, `sitemap.xml`.

---

### ADR-077 — Unify the guest "Cum ajungi" directions link to the resort's Google Maps share URL + add it to the confirmation/reminder emails

**Context.** The post-booking "Cum ajungi" button pointed at a fuzzy text query
(`maps.google.com/?q=EcoVila+Orheiul+Vechi`), which doesn't resolve to the actual entrance —
guests would land on the wrong pin. The owner supplied a precise Maps share link
(plus-code `7WX6+M8 Indicator spre EcoVila, Ivancea` with `ftid`/`entry=gps`). Goal: make every
directions touchpoint a guest sees use that exact link, while NOT touching the separate
cash/office payment-location button (that intentionally points at the Chișinău office, ADR-061).

**Confirmation page.** Repointed the celebration-screen directions button: both the static
`href` in `confirmare.html` and `MAPS_URL` in `js/confirmare.js` (the runtime value actually
wins — `directions.href = MAPS_URL` on render).

**Emails (new buttons).** Neither the confirmation nor the arrival-reminder email had a
directions button before. Added a shared `EMAIL_MAPS_URL` + localized labels
(`EMAIL_DIRECTIONS_LABEL`: `Cum ajungi`/`Как добраться`/`Get directions`) in
`notifications.ts`. The premium reservation-email renderer gained an optional `directions`
slot rendered as an outlined "📍" pill between the primary CTA and the cancel link; wired into
`buildConfirmationEmail` (HTML + plaintext, localized RO/RU/EN). The simpler arrival-reminder
email (`composeArrivalReminder`, body is hardcoded RO per ADR-062) gained a localized directions
CTA + plaintext line keyed on the guest's language.

**Explicitly NOT changed.** The cash/office directions button in `gestionare.html` (Chișinău
office); the FAQ "Cum ajungi…" answers (text-only, owner chose to leave them); the homepage
`hasMap` JSON-LD (structured data, not a guest-facing button) — all left as-is per the owner's
decisions.

**Status.** Committed and pushed to `main`; asset token bumped to `?v=2026062003`
(`npm run bump:assets`) and `dist/tophost` rebuilt (`npm run prepare:tophost`) — live on next
TopHost upload. **Backend deployed to prod 2026-06-20**: `supabase functions deploy` redeployed
all 24 edge functions (notably `confirm-reservation-payment` v26 for the confirmation email and
`send-reminders` v23 for the reminder email); the same redeploy also shipped the previously
undeployed ADR-072 SMS trim (`send-sms` v17). Verified: `deno check` clean, 31 email/reminder
tests pass, all three
languages render the correct localized label + exact URL in HTML and plaintext, and the
confirmation page button carries the new href with no console errors. Files: `confirmare.html`,
`js/confirmare.js`, `supabase/functions/_shared/notifications.ts` (+ the `?v=` re-stamp across
shipped HTML).

---

### ADR-078 — Premium, localized arrival-reminder email (informal "Te" in RO)

**Context.** The "see you tomorrow" arrival-reminder email (`composeArrivalReminder`) used
the bare `reservationEmailHtml` template (plain `<h1>`/`<table>`), so next to the premium
confirmation/cancellation emails it read as an automated, low-effort message. The owner
asked to bring it up to the shared house style and to address the guest informally ("Te"),
matching the confirmation copy.

**Change.** `composeArrivalReminder` now builds via the shared premium renderer
(`renderReservationEmail`) through a new `buildArrivalReminderEmail` + `ARRIVAL_COPY` map,
fully localized RO/RU/EN (subject, preheader, greeting, intro, info card carrying the
access-after-13:00 + no-pets rules, closing). RO uses the informal "tu/te" address
("Mâine te așteptăm…", "Bună, …!"), superseding the RO-only body of ADR-062. The arrival
SMS is unchanged — it stays formal like every other SMS, asserted by tests. Added `siteUrl`
plumbing in `send-reminders` so the email logo resolves; the localized directions button
(ADR-077) is preserved. Badge glyph is a monochrome "★"; the directions CTA is a filled
green primary button.

**Status.** Backend deployed to prod 2026-06-21 (`send-reminders`). Verified: `deno check`
clean, ro/ru/en reminder tests pass, previews sent to the owner inboxes. Files:
`supabase/functions/_shared/notifications.ts`, `supabase/functions/send-reminders/index.ts`,
`supabase/functions/tests/reservations.test.ts`.

---

### ADR-079 — All guest emails show the accommodation type, not the room number

**Context.** Every transactional email showed accommodation as "Căsuța #N" (room number).
The owner wanted the human-readable type instead — „Căsuță mică” / „Căsuță mare” /
„Cameră în hotel” — localized, across ALL emails (confirmation, cancellation, arrival
reminder, cash-expiry reminder, expired-cash cancellation, booking-change).

**Change.** Centralized the label in `notifications.ts`: `ACCOMMODATION_TYPE_LABELS`
(ro/ru/en × `small`|`large`|`hotel`) + a shared `accommodationTypeLabel(reservation,
language)` that resolves the type from either a normalized `room_type` or a raw
`rooms(type)` join, plus `aggregateRoomLabel`, which now groups a multi-villa booking by
type with a count ("2× Căsuță mică"; mixed types are listed, e.g. "Căsuță mică, Căsuță
mare"). The room number is no longer shown. Removed the four duplicate, number-based
`roomLabel`/aggregate helpers that had drifted across `_shared/bookingSettlement.ts`,
`reservation-cancel`, `reservation-cancel-notify`, and `_shared/reservationChanges.ts`;
all now call the shared helper.

**Status.** Backend deployed to prod 2026-06-21 (all edge functions redeployed so every
email path shares the new label). Verified: `deno check` clean on all affected functions,
100 edge tests pass (ro/ru/en single + multi-villa aggregation). Files:
`supabase/functions/_shared/notifications.ts`, `_shared/bookingSettlement.ts`,
`_shared/reservationChanges.ts`, `reservation-cancel/index.ts`,
`reservation-cancel-notify/index.ts`, `supabase/functions/tests/reservations.test.ts`.

---

### ADR-080 — Auth-free guest complaints: drop the OTP login + anonymity toggle, require a cabin number for căsuță reports, add an optional follow-up phone

**Context.** The complaints page (ADR-068) gated every report behind a phone-OTP login
(SMS code, restricted to phones with a paid reservation) and offered a "submit anonymously"
toggle. The owner found the login too much friction for a feedback form and wanted any
visitor to report a problem in one screen. With no login there is no verified identity, so
the anonymity toggle became meaningless. Separately, "Căsuța" reports need to say *which*
cabin, and staff wanted that inside the report text they already read.

**Change.** The complaints flow is now unauthenticated. Removed the login card (phone +
SMS-code steps) and the anonymity checkbox from `complaints.html`; the report form shows
immediately. `complaint-submit` no longer requires a session token or `isAnonymous` — its
only gate is the existing per-IP rate-limit bucket (`complaintSubmitIp`, 10 / 10 min, the
same pattern as the public `create-reservation`). Selecting "Căsuța" reveals a **required**
"Numărul căsuței" field; the server prefixes the cabin number into the stored description
("Căsuța <n> — …") via a shared `composeCasutaDescription`, so the admin "Probleme" tab
shows it with no schema change. A new **optional** phone field is the only identity a guest
may leave: when present and matching a paid reservation it still attaches the first name +
booking (`resolveIdentity`) so staff get a ☎ for follow-up; blank ⇒ a fully unattributed
report (`is_anonymous` is always stored `false`, which the admin already renders as
"Oaspete"). New shared helpers `normalizeComplaintRoom` / `normalizeOptionalPhone`;
translations updated RO/RU/EN (login/anonymity keys removed, room + optional-phone keys
added). The `/complaints → /complaints.html` rewrite already lives in `.htaccess` (ADR-068)
— unchanged. The orphaned login subsystem is fully retired: the `complaint-login-start` /
`complaint-login-verify` edge functions were deleted, the `complaint_sessions` table was
dropped (migration `20260621120000_drop_complaint_sessions.sql`), and the dead session/code
hashing helpers + the two `complaintLogin*` rate-limit buckets + their `config.toml` blocks
were removed.

**Status.** **Backend deployed to prod 2026-06-21** (project `mckchrviaawdxtsfytut`):
`complaint-submit` redeployed (v4, auth-free), `complaint-login-start` + `complaint-login-verify`
deleted, `complaint_sessions` dropped + migration history repaired. **Frontend bundled, not
yet TopHost-uploaded** — asset token bumped site-wide to `?v=2026062101`, `dist/tophost`
regenerated (incl. the `.htaccess` carrying the `/complaints` rewrite). Verified: 300 node +
101 deno tests pass; browser preview confirmed the form renders without login, the cabin
field toggles required-on-Căsuța, the validation chain, and the exact submit payload
(`{category, description, roomNumber, phone, language}`). Remaining step: upload the frontend
+ `.htaccess` to TopHost. Files: `complaints.html`, `js/complaints.js`, `js/supabase.js`,
`js/translations.js`, `css/complaints.css`, `supabase/functions/complaint-submit/index.ts`,
`supabase/functions/_shared/complaints.ts`, `_shared/rateLimit.ts`, `config.toml`,
`supabase/migrations/20260621120000_drop_complaint_sessions.sql`, tests.

**Follow-up polish (2026-06-21).** The room-number + phone inputs rendered unstyled because
the CSS only targeted the now-removed `.cmp-step input`; restyled under `.cmp-field input`.
The optional phone (guest form) and the staff add-reservation phone are now pre-filled with
the `+373` prefix so users type only the local digits — a bare prefix counts as "no phone"
on the guest form and still fails the staff form's `^\+\d{8,15}$` validation (locked in by a
new test). Asset token re-bumped to `?v=2026062102`. Files: `css/complaints.css`,
`complaints.html`, `js/complaints.js`, `admin/dashboard.html`, `tests/admin-crm.test.mjs`.

---

### ADR-081 — Require a country code on every guest phone field (reject a bare national number that lost its "+373")

**Context.** Guest phone inputs are pre-filled with the editable "+373" prefix. In
practice many guests delete the "373" but keep the "+", then type their 8-digit
Moldovan national number — producing values like "+60843453". Because Moldovan
mobiles are 8 digits and start 6/7, "+60…" reads as a plausible foreign country
code (Malaysia), and the validators waved it through: every phone guard fell back
to a generic `^\+\d{8,15}$` for anything that wasn't +373/+40/+380, and 8 digits
clears that floor. The reservation (or complaint / lookup) was then stored against
an unreachable number, so SMS, MIA routing and staff call-backs silently failed.
Deleting "+373" is itself legitimate — it means "I'm entering another country" — so
the fix had to keep genuine foreign numbers working while catching the bare-national
case.

**Change.** The generic fallback is tightened from `^\+\d{8,15}$` to
**`^\+[1-9]\d{9,14}$`** everywhere: the number must start with a non-zero country
code (E.164 codes never start with 0) and carry 10–15 digits after the "+". The
three served countries keep their exact-length branches (+373 → 8 national digits,
+40 / +380 → 9); only the "any other country" path changed. A bare Moldovan number
with a stray "+" ("+60843453", 8 digits) and a national number that kept a leading
zero ("+069…") are now rejected, while every realistic foreign number stays valid
(US / RO / UA / RU / DE / FR / UK are all ≥ 11 digits). Applied identically across
all eight copies of the guard — client: `js/checkout.js` (booking), `js/booking.js`
+ `js/anulare.js` (reservation lookup), `js/complaints.js` (optional follow-up
phone), `admin/js/crm-sidebar.js` (staff add-reservation); server:
`_shared/reservations.ts` (`hasValidPhoneLength`), `_shared/reservationManage.ts`
(`assertValidPhone`, the lookup/manage guard), `_shared/complaints.ts`
(`normalizeOptionalPhone`). The guest-facing error copy (`checkout.errorPhone`,
`complaints.phoneInvalid`) is a terse "Include the country code" in RO/RU/EN
(the complaints variant keeps "…or leave the field empty" since that phone is
optional), replacing the old digit-count description.

**Status.** **Backend deployed to prod 2026-06-22** (project
`mckchrviaawdxtsfytut`): all edge functions redeployed via
`supabase functions deploy`, so every bundle that transitively includes the three
changed shared modules ships the tightened guard — the behaviour-affecting ones are
`create-reservation`, `reservation-lookup-start` and `complaint-submit`, plus
`confirm-reservation-payment` / `reservation-*` / `maib-*` / `send-reminders` that
pull them in through `pricingGuard` / `bookingSettlement` / `reservationChanges`.
**Frontend bundled, not yet TopHost-uploaded** — asset token bumped site-wide
`?v=2026062102 → ?v=2026062201`, `dist/tophost` regenerated; this upload also
carries the still-pending ADR-080 frontend. Verified: 301 node + 101 deno tests pass
(new negative cases "+60843453" / "+069120220" locked in at every layer); browser
preview on `/complaints.html` confirmed "+60843453" is blocked with the new
country-code error while a valid "+37360120220" passes the phone gate. Files:
`js/checkout.js`, `js/booking.js`, `js/anulare.js`, `js/complaints.js`,
`admin/js/crm-sidebar.js`, `js/translations.js`,
`supabase/functions/_shared/reservations.ts`, `_shared/reservationManage.ts`,
`_shared/complaints.ts`, `supabase/functions/tests/reservationPhoneLength.test.ts`,
`tests/checkout.test.mjs`, `tests/anulare.test.mjs`, + the site-wide `?v=` bump.

### ADR-082 — Post-stay review-request email (Google review nudge the evening after checkout)

**Context.** EcoVila collects no post-stay feedback and has no steady inflow of
Google reviews. Staff already run situația zilnică (`admin/js/crm-daily.js`): when a
guest is checked out, a dialog optionally captures a free-text `checkout_note` on
`crm_daily_statuses`. A note means staff recorded something worth remembering (damage,
a complaint, a special circumstance); a guest who left with **no** note had an
uneventful — presumably good — stay. That is exactly the audience to ask for a public
review, and exactly the guests we want pointed at Google rather than the ones with a
known problem.

**Change.** A dedicated, cron-triggered edge function `send-review-requests` emails a
localized (ro/ru/en) Google-review nudge the evening after checkout.
- **Eligibility** (pure, unit-tested in `_shared/reviewRequests.ts`): `check_out` =
  yesterday (Europe/Chișinău), `payment_status='paid'`, not cancelled, at least one
  room of the booking marked checked-out in situația zilnică (`checked_out_at` set),
  and **no** room of the booking carrying a `checkout_note`. One email per booking
  group (the owner reservation), email-only (no SMS), skipped silently when the
  booking has no email on file. No-shows and unprocessed bookings are excluded.
- **Timing** (`_shared/reminders.ts`): `shouldSendReviewRequests` gates the send to the
  [18:30, 19:00) Chișinău window; `reviewRequestTargetDate` returns yesterday's local
  date. `businessDateParts` is left unchanged (its test deep-equals the whole object).
  The cron `ecovila-review-requests` fires every minute during UTC 15:00–16:59, which
  brackets 18:30 local in both EET and EEST without a DST-specific expression — the
  local-time gate lives in the function, which returns early (no DB work) outside the
  window.
- **Exactly-once**: dedup via `notification_events` (`event_type='review_request'`,
  reusing `dispatchScheduledNotificationOnce`), so repeated ticks within the window
  (which also give a transient provider failure a few retries) never double-send.
- **Email** (`_shared/notifications.ts`: `composeReviewRequest` +
  `buildReviewRequestEmail` + `REVIEW_COPY`): the shared premium layout (logo, green
  star badge, accommodation-type + stay-dates card, informal "tu/te" address), a single
  CTA to the EcoVila Google Business Profile "Get more reviews" short link
  (`EMAIL_REVIEW_URL = https://g.page/r/CWbeI4q_8_a1EBM/review`, which opens the
  star-rating dialog in one tap), and a "ceva nu a fost în regulă? sună-ne" card that
  routes a dissatisfied guest to the phone (+373 60 120 220) instead of a public low
  rating.

**Status.** **Code complete, not yet deployed** (awaiting owner go-ahead, per the
ship-to-prod sign-off rule). `deno test` 106 pass — new `tests/reviewRequests.test.ts`
plus review-window / target-date cases in `tests/reminders.test.ts`; the function
type-checks. The two product decisions are owner-confirmed: eligibility = "checked-out
in situația zilnică + no note", and the g.page review link. **Deploy steps:**
(1) `supabase functions deploy send-review-requests` (project `mckchrviaawdxtsfytut`;
`verify_jwt=false` is already in `config.toml`); (2) schedule the cron from
`migrations/20260623120000_review_request_cron.sql` against the live DB (history drifts
from the repo). No frontend, no schema change. Existing functions are unaffected — the
`notifications.ts` / `reminders.ts` additions are purely additive, so no other function
needs a redeploy. Files: `supabase/functions/send-review-requests/index.ts`,
`_shared/notifications.ts`, `_shared/reminders.ts`, `_shared/reviewRequests.ts`,
`supabase/config.toml`, `supabase/migrations/20260623120000_review_request_cron.sql`,
`supabase/functions/tests/reviewRequests.test.ts`, `tests/reminders.test.ts`.

---

### ADR-083 — Lower the free-child age ceiling from 3 to 2 (children aged 3 now pay the kid fee)

- **Date:** 2026-06-27.
- **Decision:** children are free only **through age 2** (was 3), owner-requested. The
  internal billing bands are now **1–2 free · 3–11 kid fee · 12–17 adult fee** (12–17
  still counts as a child for accommodation capacity).
- **Change.** Single source of truth is `FREE_CHILD_MAX_AGE` in `js/pricing.js` (and its
  byte-identical server copy `supabase/functions/_shared/pricing.js`), lowered `3 → 2`.
  The public booking page is unaffected by design — it collects an exact age 1–17 and
  shows no age-pricing copy, so a 3-year-old simply prices as a kid now; no guest-facing
  string changed. `pricingGuard.ts` and the change/extend flow (`reservationChanges.ts`)
  reuse the engine and follow automatically.
- **CRM age buckets** had to move in lockstep, or a "free" staff pick would silently bill:
  relabeled `0-3 → 0-2` (stores age 2) and `4-11 → 3-11` (stores age 3) in
  `admin/js/crm-sidebar.js` + `admin/js/crm-daily.js`; `bucketValueForAge` threshold
  `<=3 → <=2`; and the local staff price-preview literals in `crm-sidebar.js`
  (`calculateStaffBillableGuests`: free `age<=3 → <=2`, billable `age>=4 → >=3`).
- **Tests/docs.** `tests/booking-core.test.mjs` (free example retargeted 3→2 plus a new
  assertion that age 3 now bills), `tests/admin-crm.test.mjs` (bucket round-trips + the
  mixed-room floor total), `tests/booking-page.test.mjs` (brief regex),
  `reservationChanges.test.ts` (comment). `ECOVILA_PROJECT_BRIEF.md` + `project-overview.md`
  restated to the new bands. `node --test` 300/301 (the one red, `send-review-requests`
  rate-limit classification, pre-exists this change), `deno test` 106/106.
- **Data.** `kids_ages` stores exact integers (not bucket strings), so **no migration**:
  existing settled bookings are not re-billed. A later change/extension recompute on a
  booking that includes a 3-year-old will now add the kid fee for that child.
- **Deploy.** Frontend cache-bust bumped `?v=2026062201 → ?v=2026062701` and
  `dist/tophost` regenerated (rides with the still-un-uploaded ADR-080/081 bundle). No
  Supabase migration. **Edge-function redeploy of the shared `pricing.js` is deferred
  pending owner sign-off.**
- **⚠ Sequencing risk (must coordinate go-live).** Until the edge functions are
  redeployed, the **frontend/CRM engine** quotes age-3 as a kid fee while the **deployed
  server price-guard** still treats age-3 as free. For a public card/MIA booking that
  includes a 3-year-old, `pricingGuard` recomputes the authoritative total with the OLD
  ceiling, finds it lower than the client total, and **rejects the booking** ("total does
  not match current pricing"). So the frontend TopHost upload and the function redeploy
  must ship together, not staggered. No 3-year-olds in flight ⇒ no impact.

---

### ADR-084 — Block international (non-+373) bookings online; route them to phone/email

**Context.** Online payment routes by phone country code (`getPaymentRail`, the +373→MIA
integration): `+373` guests get the cheap MIA QR (~0.7% commission), everyone else falls
on the maib international **card** rail, whose cross-border commission is punitive. The
owner does not want to absorb that cost for foreign bookings and prefers to handle them
by phone/email.

**Decision.** At checkout, as soon as the entered phone carries a country code that is
definitely **not** Moldova's +373, disable **both** payment options (online card *and*
the in-person cash hold), lock the "Rezervă" button, and show a localized contact notice
("…we're unable to process international bookings online… contact us at +37360120220 or
rezervari@ecovila.md", RO/RU/EN) with tappable `tel:`/`mailto:` links. Cash is blocked
too, not just the card: the cash flow is a 30-minute pay-at-the-Chișinău-office hold,
unusable for a remote guest and would only create expiring junk holds — so foreign guests
are routed entirely to manual contact (owner decision, 2026-06-27).

**Detection (`isForeignPhone`, `js/checkout.js`).** Foreign = the normalized phone starts
with "+", is not "+373…", and "+373" is not still a prefix of it (so "+3"/"+37" never flash
the notice while a Moldovan number is mid-typing), and the country code is real (`^\+[1-9]`
— a "+0…" typo, i.e. a bare MD number that lost its code, stays a country-code error per
ADR-081, not an "international" block). +40 (RO) and +380 (UA) are intentionally blocked
too; they also use the card rail.

**Surface — frontend only.** `js/checkout.js` (detection + render/submit guards, exported
for tests), `checkout.html` (notice element), `css/checkout.css` (disabled-option + notice
+ `not-allowed` submit cursor), `js/translations.js` (`checkout.intlBlockedLead` /
`checkout.intlBlockedOr` ×3 langs). **No backend change:** the server already accepts
whatever `paymentRail` the client sends, and the only two card-rail entry points are
checkout selection (now blocked) and the confirmation-page "Continuă plata" retry — which
only fires for an already-pending card reservation a foreign guest can no longer create.
`gestionare.html` / admin never mint payments.

**Tests/verify.** `tests/checkout.test.mjs` (+`isForeignPhone` matrix incl. the
MD-in-progress and "+0…" edges, notice markup wiring). `node --test` 303/303,
`deno test` 106/106. Browser-verified desktop + mobile: foreign → both options + submit
greyed, single notice, links localize RO/RU/EN; "+37"/"+373" never trips it; reverting to
+373 re-enables everything.

**Deploy.** Frontend cache-bust bump (`npm run bump:assets`, `?v=2026062701 → 2026062702`)
+ `dist/tophost` regen + owner TopHost upload — **pending owner sign-off** (not bumped yet,
to keep the review diff focused). No Supabase migration, no edge-function redeploy, no
sequencing risk.

---

### ADR-086 — CRM reservation management: ship the reschedule move, remove the 1-year advance-booking wall, and de-jank calendar scrolling

Three fixes to the staff dashboard, reported together (reschedule was fully built in
ADR-054's shadow but never deployed; the other two are new). They ship as one commit
because the reschedule wiring and the scroll fix both live in `admin/js/crm-dashboard.js`
and cannot be cleanly separated.

**1 — Reschedule (move a booking to new dates) was built but undeployed.** The edit
dialog's "Salvează modificări" calls `client.functions.invoke('reservation-reschedule')`,
but that edge function had never been deployed — so the gateway 404'd without CORS headers,
the browser's `fetch` rejected, and the dialog showed *"Failed to send a request to the Edge
Function."* **Decision:** deploy the function as-is; the code was production-ready. It reuses
`orderRoomsByTightestWindow` (ADR-054) so a moved booking keeps its villa when still free,
else takes the tightest-window free villa of the **same type**, else the whole move is
rejected (409, nothing written). All group rows move together; the guest gets a localized
one-segment SMS only when the dates actually change (best-effort — a failed SMS never undoes
the move). `requireStaffRole(['diana'])`, rate-limit-exempt (staff-gated), DB exclusion
constraint `reservations_no_room_overlap` (23P01) as the final anti-double-book backstop.
*Known limitation:* the per-row updates are not one transaction, so a multi-villa group
could partial-move if a concurrent booking steals a planned villa mid-write — negligible on
a single-operator CRM, and single-villa bookings (the common case) carry zero such risk.

**2 — The "add reservation" form capped selectable dates at 1 year out.** The mini date
picker hard-disabled any date `>= today + 365` (`isAddDateSelectable`), because occupancy
was only loaded for that window and unknown dates must not show as "free." **Decision:**
remove the hard wall entirely and widen the occupancy load to ~2 years
(`ADD_RESERVATION_LOOKAHEAD_DAYS = 365 * 2`). Staff may now pick **any** future date;
availability is authoritative within the loaded window, optimistic beyond it, and the same
23P01 exclusion constraint (already surfaced with a friendly "tocmai au fost rezervate"
message + reload) guarantees no far-future double-booking. Pricing is open-ended forward, so
far-future nights price correctly — no "total = 0" wall.

**3 — Calendar horizontal scrolling stuttered / snapped back.** The scroll handler fired an
async network reload + full grid teardown-and-rebuild **synchronously on every scroll
frame** when near an edge, then force-set `scrollLeft` — fighting trackpad momentum and
yanking the view back mid-gesture. **Decision:** debounce the month-window extension so the
reload runs only after scrolling settles (`CALENDAR_EXTEND_DEBOUNCE_MS = 160`); add a
cooldown (`CALENDAR_EXTEND_SUPPRESS_MS = 500`) so our own repositioning can't instantly
re-trigger an extend; memoize the `--crm-day-column-width` read to drop a `getComputedStyle`
style-recalc per scroll frame. The live month label still tracks the scroll instantly.

**Surface.** Backend (deployed): `supabase/functions/reservation-reschedule/index.ts`,
`_shared/reservationReschedule.ts` (pure planner, unit-tested), `_shared/notifications.ts`
(`reservationRescheduleSms`), `config.toml` (`verify_jwt = true`). Frontend:
`js/supabase.js` (`rescheduleReservation` client, camelCase→snake_case), `admin/dashboard.html`
+ `css/crm.css` (inline edit-error), `admin/js/crm-dashboard.js` (edit-submit wiring; picker
horizon; scroll debounce/suppress/memoize), `admin/js/crm-sidebar.js` (drop the date wall).

**Tests/verify.** `supabase/functions/tests/reservationReschedule.test.ts` (planner keep/
relocate/reject, multi-villa no-double-assign, SMS ≤1 segment ×3 langs ×12 months) +
`tests/rate-limiting.test.mjs` (reschedule classified staff-gated + limiter-exempt) +
`tests/admin-crm.test.mjs` (unlimited-advance + debounced-scroll regression guards).
`npm test` → node 305/305, deno 112/112. Post-deploy smoke: OPTIONS preflight on the live
function returns 200 with `access-control-allow-origin` (the header the old 404 lacked).

**Deploy.** `reservation-reschedule` deployed to prod (v1, 2026-07-06). Frontend cache-bust
bump `?v=2026062702 → 2026070601` + `dist/tophost` regenerated — **pending owner TopHost
upload.** No migration. Because the frontend reschedule wiring and the live function ship
together, upload the frontend so real-Diana's browser reaches the now-live function.

---

### ADR-087 — Make the staff reschedule atomic, and surface the "no free villa" reason in the dialog

Two follow-ups to ADR-086's reschedule, closing its noted limitation.

**Atomic move.** ADR-086 applied a multi-villa move as one PostgREST `UPDATE` per row
(each auto-committed), so a villa grabbed by a concurrent booking mid-loop could leave a
group half-moved. Now the Edge Function still *plans* the villas, then applies every row's
patch through one transaction — a new `security definer` RPC `reschedule_reservation_group(
p_patches jsonb)` (migration `20260706120000`). Any villa taken between plan and commit trips
`reservations_no_room_overlap` (23P01), which aborts and rolls back the **whole** move —
nothing changes, and the Function returns a 409 to retry. The RPC runs two phases inside the
one transaction: (1) vacate every group row (`room_id → null` drops it from the exclusion
constraint, whose predicate is `room_id is not null`) while writing the new dates + edited
fields; (2) assign each row its planned room. Vacating first also fixes a swap/rotation edge
case the per-row loop would have wrongly rejected — a booking can relocate *into* a room a
sibling row is leaving. `room_id` is nullable so this is safe; both reservations triggers
no-op for the service role (`enforce_angela_reservation_columns` gates only role `angela`;
the `paid_at` trigger fires only on `payment_status`/`paid_at`, which the RPC never touches).
Patch semantics mirror the Function's field builders: a key's PRESENCE means "set it", an
absent key leaves the stored value untouched (never blanks a NOT NULL column). Execute is
revoked from `public, anon, authenticated` and granted only to `service_role` (same lock-down
as `rate_limit_hit`, ADR-060), so no logged-in client can call the raw mover and bypass the
Function's auth + planning.

**Surface the failure reason.** The "no free villa of that type for these dates" 409 *was*
already returned, but Supabase's client puts a generic "Edge Function returned a non-2xx
status code" on `error.message`; the real message lives in the response body at
`error.context`, which `decorateInvokeError` never read — so the dialog showed the useless
line. Added `readInvokeErrorDetail` (js/supabase.js) to pull the body's `error`/`message`, and
wired `rescheduleReservation` to surface it. The edit dialog now shows the specific reason for
both "nothing free" and "a villa was just taken — retry".

**Surface.** Migration `supabase/migrations/20260706120000_reschedule_reservation_group_rpc.sql`;
`reservation-reschedule/index.ts` (build patches → one `rpc()` call; `RpcClient` narrowing cast
per rateLimit.ts); `js/supabase.js` (`readInvokeErrorDetail` + wired into `rescheduleReservation`).

**Tests/verify.** `tests/supabase-wiring.test.mjs` (+ payload-mapping guard + error-surfacing
test). `npm test` → node 307/307, deno 112/112. The migration's jsonb expressions
(kids-array extraction, `?`, `nullif`, casts) were validated read-only against the live DB;
the RPC was smoke-tested there with empty + no-match inputs (no data change).

**Deploy.** LIVE in prod 2026-07-06: migration applied via `db query --linked` + `migration
repair`; RPC verified `security definer`, execute = `{service_role}` only; `reservation-
reschedule` redeployed **v2**. Frontend (`js/supabase.js`) rides the still-un-uploaded ADR-086
bundle under `?v=2026070601` — no new bump — **pending owner TopHost upload**.

---

### ADR-088 — Refunds are only "done" when MAIB confirms them: status parsing, reconcile-and-retry cron, and cancel/refund decoupling

**Problem (reported in prod).** A guest cancelled and never received the money. `refundMaibPayment`
treated any 2xx `ok:true` response as a completed refund, but MAIB models refunds with their own
`result.status` (`OK` = refunded, `REVERSED` = already refunded once before; anything else —
e.g. when the merchant settlement account lacks funds — means the money did NOT move). We recorded
`succeeded`, flipped the payment to `refunded`, emailed the guest "refunded", and nothing ever
re-checked. Failed refund rows were write-only. A synchronous MAIB rejection instead 500'd the whole
guest cancellation, leaving the booking active and the guest at risk of falling out of the 20-day window.

**Decision.**
1. `_shared/refunds.ts` — the single refund engine. `interpretMaibRefundResponse` reads
   `result.status` (`OK`/absent → completed, `REVERSED` → already-refunded, anything else →
   unresolved). `attemptBookingRefund` records every attempt on `maib_refunds`
   (requested/processing/succeeded/failed + attempts/last_attempt_at/confirmed_at/alerted_at) and
   only marks the payment `refunded` on provider confirmation.
2. **New cron `reconcile-refunds`** (every 30 min, shared-secret gated, migration
   `20260707100000`): re-attempts every unresolved refund. MAIB permits ONE refund per payment, so a
   retry of an executed refund returns `REVERSED` and resolves the row — the loop can never pay twice.
   The insufficient-funds case now heals itself as soon as the account is topped up. Also sweeps paid
   "add guests" differences left unrefunded on refund-cancelled bookings.
3. **Cancellation is decoupled from the refund**: `reservation-cancel` cancels the booking even when
   the refund leg fails, queues the refund for reconciliation, and returns `refundPending: true`.
   The CRM delete flow was reordered to cancel FIRST, refund second (refunding before a failed cancel
   left money returned + booking active).
4. **Staff alerts** (`_shared/alerts.ts`, email to new secret `ECOVILA_ALERT_EMAIL`): fired on every
   unresolved refund (re-alert every 6h), on `REVERSED`-resolution (verify in the maibmerchants
   panel), and by the ADR-089 manual-review paths. Unconfigured → console.error only, never breaks flow.
5. Adjacent fixes: `reservation-cancel` refund lookup now filters `status in ('paid','refunded')`
   (a newer abandoned session row could shadow the paid one → guest 409'd forever) and proceeds when
   the payment is already `refunded` (refunded-but-active stranding). `maib-refund` refuses a partial
   refund after a completed one with an explicit 409 instead of a fake success (unique `pay_id` row +
   MAIB's one-refund rule made the remainder silently unrefundable). `refundPaidChanges` is now
   per-change tolerant and status-aware — an unconfirmed difference stays `paid` for the cron.

**Surface.** `_shared/refunds.ts`, `_shared/alerts.ts`, `reconcile-refunds/` (new);
`reservation-cancel`, `maib-refund`, `_shared/reservationChanges.ts`; migration
`20260707100000_refund_reconciliation.sql` (status widening + retry columns + cron schedule);
`admin/js/crm-dashboard.js` (delete reorder). NEW SECRET: `ECOVILA_ALERT_EMAIL`.

### ADR-089 — Settlement crash-safety, one live MAIB session per booking group, and honest staff confirmation

**Problems (audit).** (1) Both rails flipped `maib_payments` terminal-paid BEFORE settling the
reservations and every retry short-circuited on the row's status alone — one transient error in that
gap and MAIB's retries all returned `duplicate:true`, the 5-minute cron cancelled the pending rows,
and a charged booking silently vanished. (2) `maib-create-payment` was check-then-act: two
concurrent calls minted two payable MAIB sessions; a guest paying both produced a second capture
that settled silently on the already-paid rows — an undetected double charge. (3) A terminal
`failed` callback permanently blocked a later `paid` result for the same checkout. (4)
`confirm-reservation-payment` never checked its UPDATE's row count: confirming in the same second
the cron expired the hold sent the guest a confirmation SMS for a cancelled booking.

**Decision.**
1. `processed_at` is stamped only AFTER settlement succeeds (both rails; `markPaymentProcessed`).
   A paid-but-unprocessed row is the crash marker: callbacks/polls re-run the (idempotent)
   settlement instead of short-circuiting, and a per-minute cron backstop in
   `expire-cash-reservations` (`settleUnprocessedPaidPayments`, 2-min grace) finishes any
   settlement whose process died — running BEFORE the expiry steps so the booking is never released.
2. Duplicate guard short-circuits only `paid && processed_at`; a late `paid` now supersedes a
   recorded `failed`/`cancelled`.
3. Migration `20260707101000`: partial unique index `maib_payments (booking_group_id) where status
   in ('created','pending')` (+ historical stale-row cleanup). The insert race's loser cancels its
   own just-minted session (MIA QR cancelled at MAIB) and returns the winner's session.
   `findReusablePayment` is rail-aware (a card caller can no longer receive a MIA QR as payUrl) and
   a superseded MIA QR is cancelled at MAIB regardless of the requested rail.
4. Suspected double capture (a different paid/refunded payment already exists for the group) is
   never settled: the row is flagged `manual_review` (new column) + staff alert; the same
   transition-gated alerting covers "charged but no reservation could be reinstated".
5. `confirm-reservation-payment` selects the UPDATE's row ids and notifies/tracks only genuinely
   paid rows; zero → 409 telling staff the hold expired first.
6. Hygiene: callback catch now logs; cron's stale-session cleanup runs every tick, is scoped away
   from attempt-grace-protected rows; `markReservationsInProgress` re-asserts `pending`.

**Surface.** `maib-callback`, `_shared/miaReconcile.ts`, `_shared/bookingSettlement.ts`
(`findOtherPaidPayment`/`markPaymentManualReview`/`markPaymentProcessed`), `maib-create-payment`,
`expire-cash-reservations`, `confirm-reservation-payment`; migration
`20260707101000_maib_payments_live_session_guard.sql`.

### ADR-090 — Booking-input hardening: past-date guard, server-generated group ids, capacity check, single-use OTP, normalized rate-limit keys

Server: `_shared/reservations.ts` rejects a check-in before the Europe/Chisinau business day
(a stale checkout tab could previously create AND pay for an already-started stay — no client or
server guard existed) and always generates `booking_group_id` server-side (a caller who learned a
victim's group UUID could inject a row and hijack group-keyed notifications).
`_shared/pricingGuard.ts` enforces party-fits-units via the shared engine's `getUnitsNeeded`
(bounded raw counts first). `reservation-lookup-verify` consumes the OTP on first success
(`verified_at` claim-once), so a correct code can't be replayed within its TTL to mint unlimited
manage tokens. `create-reservation` keys the per-phone rate limit on the NORMALIZED phone.

Frontend (same ADR): checkout rejects past check-in selections; the booking calendar clamps
forward navigation to the availability fetch horizon (today+210d — months beyond it rendered as
falsely free while staff now book 2 years out); anulare's success flag is token-scoped (a second
cancel link in the same tab showed fake success); Enter-key paths respect disabled buttons (each
Enter used to send a real OTP SMS); gestionare wires cash actions idempotently, guards concurrent
cancellation, generation-guards the card poll chain, and confirms hold expiry with the server
before the "expirat" overlay; confirmare computes "today" in Europe/Chisinau; notifications follow
the guest's CURRENT page language; the stale `ecovila_pending_reservation` blob is cleared once
its booking reaches a terminal state; calendar aria-labels use localized dates; plata-mia keeps
the loading panel until a status fetch succeeds and adopts refreshed expiries.

**Surface.** `_shared/reservations.ts`, `_shared/pricingGuard.ts`, `reservation-lookup-verify`,
`create-reservation`; `js/checkout.js`, `js/booking.js`, `js/anulare.js`, `js/gestionare.js`,
`js/confirmare.js`, `js/plata-mia.js`.

### ADR-091 — CRM hardening: atomic room swap RPC, checked writes, vendored supabase-js, localStorage sessions

1. **Atomic swap** — migration `20260707120000_swap_reservation_rooms.sql`: `security definer` RPC
   (vacate-then-assign in one transaction, ADR-087 pattern; in-function diana-only role check since
   the CRM calls it as `authenticated`). The old two-UPDATE swap could NEVER swap date-overlapping
   stays (both tripped the exclusion constraint, both errors discarded) and could half-apply.
   Drag/drop now checks every `{ error }`, surfaces 23P01 as "camera este ocupată", blocks
   multi-villa block drags and cross-type drops (no repricing), and the swap dialog only closes
   after a real attempt.
2. **Checked money/state writes** — `markPaid`/`sendPaymentConfirmation` disable during flight +
   surface failures; daily guest-edit saves sequentially with stop-on-failure reporting, asks
   confirmation before overwriting a (possibly negotiated) total, and disables its submit;
   checkout-note saves BEFORE closing the dialog (a silent failure also mis-gated the ADR-082
   review email); photo uploads isolate per-file failures and deletion asks confirmation; the
   pricing form rejects adult prices ≤ 0 (a mis-tabbed save published 0-MDL tariffs the live
   engine honored) and confirms past effective dates; add-reservation guards double-submit.
3. **Vendored supabase-js** — `js/vendor/supabase.js` (`@supabase/supabase-js@2.110.1` UMD,
   SHA-256 in `js/vendor/README.md`) replaces the un-pinned no-SRI jsdelivr tag on all 13 pages:
   a poisoned floating-major release would have run with full staff-session power.
4. **CRM sessions moved from cookies to localStorage** — the `Path=/admin` cookies sent 90-day
   staff tokens to the static host's access logs on every request. Legacy cookie sessions migrate
   on first read (nobody is logged out), then the cookies are deleted.

**Surface.** `admin/js/crm-dashboard.js`, `crm-daily.js`, `crm-photos.js`, `crm-pricing.js`,
`crm-sidebar.js`, `crm-auth.js`, `admin/dashboard.html`; all public HTML + `js/vendor/`;
migration `20260707120000_swap_reservation_rooms.sql`.

**Tests (ADR-088..091).** `npm test` → node 307/307 + deno 117/117 (new
`tests/refunds.test.ts` pins the refund-status interpretation; reservation/checkout/CRM tests
updated to the new invariants). **Deploy: NOT yet — pending owner sign-off** (3 migrations, all
edge functions incl. new `reconcile-refunds`, `ECOVILA_ALERT_EMAIL` secret, TopHost upload).

---

## Open questions for the owner (decisions not yet made)

- Should the owner-retained unused media (`ecovilavideo.mp4` HEVC master,
  `assets/logo_small.png`) stay in the repo even though they are not referenced or deployed?
  (`ecovilavideo-web.mp4` now has a defined role — the hero re-encode master, ADR-074.)
- Should dependency pinning/security scanning stay manual because this is a no-build
  static site, or should CI/security tooling be introduced before launch?
