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
  difference (only free 1–3-year-olds) is applied instantly with no payment. New edge functions
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

## Open questions for the owner (decisions not yet made)

- Should `intrebari-frecvente.html` be split into per-language URLs (`/intrebari-frecvente.html`,
  `/ru/...`, `/en/...`) with hreflang, mirroring the homepage (ADR-016) and superseding the
  interim single-URL `@graph` from ADR-024?

- Should the owner-retained unused media (`ecovilavideo.mp4`, `ecovilavideo-web.mp4`,
  `assets/logo_small.png`) stay in production deploy artifacts even though they are not
  referenced?
- Should dependency pinning/security scanning stay manual because this is a no-build
  static site, or should CI/security tooling be introduced before launch?
