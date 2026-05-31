# Bugs & Broken Behavior — EcoVila

Found during the Phase 0 audit (2026-05-31). Running log; update Status as bugs are
fixed. These are distinct from the cleanup *tasks* in `docs/plan.md` (though some plan
steps fix bugs listed here). Severities: Critical / High / Medium / Low.

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| B-1 | `deno task test` discovers 0 tests (false green) | Medium | Open |
| B-2 | Orphaned ~36MB of unreferenced video binaries committed at repo root | Low | Open |
| B-3 | Unused `assets/logo_small.png` | Low | Open |
| B-4 | No `package.json` / documented test scripts for the frontend suite | Low | Open |
| B-5 | `deno lint` reports 93 problems | Low | Open |
| B-6 | Backend + tests live under `docs/` (mislocated relative to convention) | Low | Open |

---

### B-1 — `deno task test` silently runs zero tests (Medium)
- **Description:** `docs/supabase/functions/deno.json` defines
  `"test": "deno test --allow-env --allow-net tests"`. Running it (or
  `deno test --allow-env --allow-net tests` from the functions dir) prints
  **"error: No test modules found"**. The 32 real tests exist but are never run by the
  task.
- **Reproduce:**
  ```sh
  cd docs/supabase/functions
  deno test --allow-env --allow-net tests   # → "No test modules found"
  ```
- **Suspected cause:** the test files are named `maib-test.ts`,
  `reservation-manage-test.ts`, `reservations-test.ts`. Deno's default test discovery
  only matches `*_test.ts` / `*.test.ts` / `test.ts` — a **hyphen** before `test` does
  not match. They run only when passed explicitly:
  ```sh
  deno test --allow-env --allow-net tests/maib-test.ts tests/reservation-manage-test.ts tests/reservations-test.ts   # → 32 passed
  ```
- **Why it matters:** CI or a developer trusting `deno task test` would see a green run
  while testing nothing.
- **Suggested fix:** rename files to `*.test.ts` (or `*_test.ts`), or change the task to
  list the files / a matching glob. Update `docs/README.md` and `conventions.md` after.

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

### B-4 — No `package.json` / documented frontend test scripts (Low)
- **Description:** the Node suite is run with `node --test 'docs/tests/**/*.test.mjs'`
  but there is no manifest documenting it; discovery is tribal knowledge. (The `.claude`
  permissions file hints at the intended commands.)
- **Why it matters:** onboarding friction; easy to run tests incorrectly (see the failed
  `node --test docs/tests/` attempt, which errors because it's not a glob).
- **Suggested fix:** add a minimal `package.json` with `test` / `test:deno` scripts, or
  document the exact commands prominently (done in `docs/README.md`). Decide in
  `docs/decisions.md` whether a manifest is wanted given the no-build philosophy.

### B-5 — `deno lint`: 93 problems (Low)
- **Description:** 88 `no-explicit-any`, 4 `require-await` (async functions with no
  await: `sendSms`, `sendEmail`, `hashManageToken`, `hashLookupCode`), 1
  `no-import-prefix` (inline `npm:` in `deno.json`).
- **Reproduce:** `cd docs/supabase/functions && deno lint`.
- **Why it matters:** code-quality / type-safety debt; not a runtime failure. Typecheck
  (`deno check`) currently passes.
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

---

## Items checked and NOT bugs

- `site.html` hero `<source src="/assets/videos/ecovila-hero.mp4">` — the file exists;
  not broken.
- `index.html` not linking to `site.html` — **intentional** maintenance holding page,
  asserted by `docs/tests/maintenance-page.test.mjs`.
- `js/pricing.js` / `js/calendar.js` imported by both browser and Node tests — the
  UMD wrapper is by design, not a duplication bug.
