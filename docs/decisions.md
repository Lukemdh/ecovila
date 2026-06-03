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
- **Date:** 2026-05-31.
- **Decision:** guest-facing online cancellation is available only when there are at
  least 7 calendar days before arrival, or when the reservation was created less than 2
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

---

## Open questions for the owner (decisions not yet made)

- Should the owner-retained unused media (`ecovilavideo.mp4`, `ecovilavideo-web.mp4`,
  `assets/logo_small.png`) stay in production deploy artifacts even though they are not
  referenced?
- Should dependency pinning/security scanning stay manual because this is a no-build
  static site, or should CI/security tooling be introduced before launch?
