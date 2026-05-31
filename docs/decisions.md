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

---

## Open questions for the owner (decisions not yet made)

- Should `docs/supabase/` and `docs/tests/` move to the repo root (`supabase/`,
  `tests/`) to match Supabase CLI conventions? (See B-6.) — **undecided.**
- Should a minimal `package.json` exist purely to document test scripts, given the
  no-build philosophy? (See B-4.) — **undecided.**
- Are the root `*.mp4` files and `logo_small.png` truly removable? (See B-2, B-3.) —
  **needs confirmation.**
