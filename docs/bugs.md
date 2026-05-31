# Bugs & Broken Behavior — EcoVila

Found during the Phase 0 audit (2026-05-31) and later off-plan bugfix sessions. Running
log; update Status as bugs are fixed. These are distinct from the cleanup *tasks* in
`docs/plan.md` (though some plan steps fix bugs listed here). Severities: Critical /
High / Medium / Low.

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| B-1 | `deno task test` discovers 0 tests (false green) | Medium | Fixed |
| B-2 | Orphaned ~36MB of unreferenced video binaries committed at repo root | Low | Open |
| B-3 | Unused `assets/logo_small.png` | Low | Open |
| B-4 | No `package.json` / documented test scripts for the frontend suite | Low | Fixed |
| B-5 | `deno lint` reports 92 problems | Low | Open |
| B-6 | Backend + tests live under `docs/` (mislocated relative to convention) | Low | Open |
| B-7 | Online cancellation allowed outside the current public window and for cash reservations | Medium | Fixed |

---

### B-1 — `deno task test` silently ran zero tests (Medium) — Fixed 2026-05-31
- **Description:** `docs/supabase/functions/deno.json` defines
  `"test": "deno test --allow-env --allow-net tests"`. Before the fix, running it (or
  `deno test --allow-env --allow-net tests` from the functions dir) printed
  **"error: No test modules found"** because the 32 real tests were not discoverable.
- **Former reproduce (before fix):**
  ```sh
  cd docs/supabase/functions
  deno test --allow-env --allow-net tests   # used to print "No test modules found"
  ```
- **Root cause:** the test files were named `maib-test.ts`,
  `reservation-manage-test.ts`, `reservations-test.ts`. Deno's default test discovery
  only matches `*_test.ts` / `*.test.ts` / `test.ts` — a **hyphen** before `test` did
  not match. Before the rename, they ran only when passed explicitly:
  ```sh
  deno test --allow-env --allow-net tests/maib-test.ts tests/reservation-manage-test.ts tests/reservations-test.ts   # → 32 passed
  ```
- **Fix:** renamed the Deno tests to `maib.test.ts`, `reservation-manage.test.ts`, and
  `reservations.test.ts`; updated the Node contract test and docs. `deno task test` now
  runs all 32 backend tests.

### B-2 — Orphaned video binaries at repo root (Low)
- **Description:** `ecovilavideo.mp4` (~15MB) and `ecovilavideo-web.mp4` (~21MB) are
  tracked in git but referenced by no page. The hero video actually used by `site.html`
  is `assets/videos/ecovila-hero.mp4`.
- **Reproduce:** `grep -rn "ecovilavideo" *.html admin/*.html js/*.js` → no matches.
- **Suspected cause:** leftovers from the 2026-05-12 hero-video revamp / the
  "ecovila2 backup" sync.
- **Why it matters:** ~36MB of dead weight in the repo and on any static deploy.
- **Suggested fix:** confirm with owner, then remove from the working tree (and consider
  history cleanup). Do **not** delete without confirmation — flagged per AGENTS safety
  rule.

### B-3 — Unused `assets/logo_small.png` (Low)
- **Description:** no references in any HTML/CSS/JS.
- **Reproduce:** `grep -rn "logo_small" . --include='*.html' --include='*.js' --include='*.css'` → none.
- **Suspected cause:** superseded by `logo.png` / `logoNT.png`.
- **Suggested fix:** confirm and remove. Low priority.

### B-4 — No `package.json` / documented frontend test scripts (Low) — Fixed 2026-05-31
- **Description:** the Node suite was run with `node --test 'docs/tests/**/*.test.mjs'`
  but there was no manifest documenting it; discovery was tribal knowledge. (The
  `.claude` permissions file hinted at the intended commands.)
- **Why it mattered:** onboarding friction; easy to run tests incorrectly (see the failed
  `node --test docs/tests/` attempt, which errors because it is not the recursive glob).
- **Fix:** added a dependency-free root `package.json` with `test`, `test:node`, and
  `test:deno` scripts; documented `npm test` in `docs/README.md`; recorded ADR-009.

### B-5 — `deno lint`: 92 problems (Low)
- **Description:** 87 `no-explicit-any`, 4 `require-await` (async functions with no
  await: `sendSms`, `sendEmail`, `hashManageToken`, `hashLookupCode`), 1
  `no-import-prefix` (inline `npm:` in `deno.json`).
- **Reproduce:** `cd docs/supabase/functions && deno lint`.
- **Why it matters:** code-quality / type-safety debt; not a runtime failure. Typecheck
  (`deno check`) currently passes.
- **2026-05-31 note:** the off-plan cancellation fix removed the lone
  `maib-refund` `no-explicit-any` while preserving B-5 as open lint debt.
- **Suggested fix:** address incrementally in the lint-cleanup steps of `docs/plan.md`.

### B-6 — Backend and tests under `docs/` (Low / structural)
- **Description:** `docs/supabase/` (migrations + Edge Functions) and `docs/tests/`
  contain real, shipping code/tests inside the documentation folder. Convention would
  put these at the repo root (`supabase/`, `tests/`).
- **Suspected cause:** the 2026-05-16 "docs reorg" (`ca4dfc5 Fix test harness paths
  after docs reorg`).
- **Why it matters:** surprising for newcomers; tooling defaults (Supabase CLI expects a
  top-level `supabase/`) may not find these without configuration.
- **Suggested fix:** treat any move as a **higher-risk, late** plan step (it touches the
  Supabase CLI workflow and every test path). Confirm intent with owner first — intent
  is currently Unknown.

### B-7 — Online cancellation policy was too permissive (Medium) — Fixed 2026-05-31
- **Description:** guest-facing cancellation paths allowed online cancellation when fewer
  than 7 calendar days remained and more than 2 hours had passed since reservation
  creation, and cash-paid reservations were not blocked from online cancellation.
- **Fix:** updated the shared refund eligibility helper, the `reservation-cancel` Edge
  Function, the legacy `cancel_reservation_by_token` RPC, and public confirmation /
  cancellation UI copy. Online guest cancellation is now available only at least 7
  calendar days before arrival or within the first 2 hours after creation. Cash-paid
  reservations show office-only reimbursement copy and are blocked online. CRM
  cancellations of paid Maib bookings call the Diana-only `maib-refund` function and can
  refund independently of the public guest window.
- **Verification:** covered by Node contract tests in `docs/tests/anulare.test.mjs`,
  `docs/tests/reservation-lookup-refunds.test.mjs`, `docs/tests/admin-crm.test.mjs`,
  and Deno test `docs/supabase/functions/tests/reservation-manage.test.ts`.

---

## Items checked and NOT bugs

- `site.html` hero `<source src="/assets/videos/ecovila-hero.mp4">` — the file exists;
  not broken.
- `index.html` not linking to `site.html` — **intentional** maintenance holding page,
  asserted by `docs/tests/maintenance-page.test.mjs`.
- `js/pricing.js` / `js/calendar.js` imported by both browser and Node tests — the
  UMD wrapper is by design, not a duplication bug.
