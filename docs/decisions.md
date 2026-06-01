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

### ADR-006 — Maintenance holding page as the live homepage (reconstructed)
- **Date:** 2026-05-17 (favicon refresh era) / current.
- **Decision:** `index.html` is a minimal "în curând" maintenance page; the full landing
  is kept at `site.html`, reachable directly.
- **Why:** Unknown — needs owner input (likely a soft-launch gate). The behavior is
  locked by `docs/tests/maintenance-page.test.mjs`, so do not "fix" it without a new ADR.

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
  keep `verify_jwt = true` in `docs/supabase/config.toml`.
- **Why:** relying only on the Edge Function gateway made role checks forgeable if a
  future config change accidentally disabled `verify_jwt` on a staff function. Auth
  validation uses the existing Supabase JS dependency and avoids adding a JWT library.
- **Consequence:** staff-only Edge Functions require `SUPABASE_ANON_KEY` in their
  server-side environment in addition to `SUPABASE_URL`; call sites must `await
  requireStaffRole(...)`.

---

## Open questions for the owner (decisions not yet made)

- Should `docs/supabase/` and `docs/tests/` move to the repo root (`supabase/`,
  `tests/`) to match Supabase CLI conventions? (See B-6.) — **undecided.**
