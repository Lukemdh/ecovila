# plan.md — EcoVila Cleanup Plan

This is the single source of truth for the cleanup. It is executed by an AI agent **one
step at a time**, across many sessions. Each step is sized for one focused session and
assumes the agent remembers nothing from prior sessions.

---

## (A) HOW TO USE THIS PLAN — read every session

1. Read `docs/AGENTS.md` and **this entire file** before doing anything.
2. Find the **first step in section (E) whose Status is not DONE**. That is the ONLY
   step you work on this session.
3. Read that step's **Required reading** before touching code.
4. Do the step's **Actions**. Run its **Verification**. The step is **not done** until
   verification passes.
5. Apply the **Definition of Done** in section (C): review/update every doc file.
6. Commit (docs + code together). Set the step's **Status: DONE**, update the **Progress
   Tracker** (D), and append a **Session Log** entry (F). Then stop.

Do not skip ahead, do not batch steps, do not start a step whose dependencies aren't DONE.

---

## (B) DOCUMENT MAP — what each doc is for, and when to update it

| Doc | Purpose | Update when |
|-----|---------|-------------|
| `docs/AGENTS.md` | Standing agent rules + Definition of Done | the workflow itself changes |
| `docs/plan.md` (this) | The cleanup plan & next-step pointer | every session |
| `docs/README.md` | Install/run/test/deploy + env names | commands, tooling, or env change |
| `docs/project-overview.md` | Product, features, domain, architecture | product/architecture changes |
| `docs/project-structure.md` | File/dir map + data flow | files added/moved/removed |
| `docs/project-history.md` | Running historical log | every session (append) |
| `docs/security.md` | Security posture/findings log | security posture changes |
| `docs/bugs.md` | Known-bug log | a bug is found or its status changes |
| `docs/decisions.md` | Architectural decision log | a decision is made |
| `docs/conventions.md` | Coding standards actually followed | a pattern/standard changes |

**These docs are interrelated and MUST be kept mutually consistent.** If you change a
fact (path, command, env var, behavior) in one doc, grep the others for the same fact
and update them too.

---

## (C) DEFINITION OF DONE (the doc-update law) — NON-NEGOTIABLE

A step is **NOT complete** until you have reviewed and, where affected, UPDATED every one
of these files:

- `docs/README.md`
- `docs/project-overview.md`
- `docs/project-structure.md`
- `docs/project-history.md`   (append what changed this session)
- `docs/security.md`          (update if security posture changed)
- `docs/bugs.md`              (update status of any bug touched)
- `docs/decisions.md`         (log any decision made)
- `docs/conventions.md`       (update if a pattern/standard changed)
- `docs/plan.md`              (set step Status, update the progress tracker, append session log)

Agents tend to skip this. It is mandatory. If a doc was genuinely unaffected, explicitly
note in the session log that you checked it and it needed no change. Then commit the docs
together with the code change for that step.

---

## (D) PROGRESS TRACKER

**CURRENT STEP → STEP 13**

| Step | Title | Risk | Status |
|------|-------|------|--------|
| 1 | Add `.env.example` (secret names only) | Low | DONE |
| 2 | Fix Deno test discovery so the test task runs the tests | Low | DONE |
| 3 | Document/enable a one-command test runner | Low | DONE |
| 4 | Fix `require-await` lint violations | Low | DONE |
| 5 | Fix `no-import-prefix` lint violation | Low | DONE |
| 6 | Resolve orphaned media owner decision | Low | DONE |
| 7 | Remove hardcoded placeholder phone defaults | Low–Med | DONE |
| 8 | Type cleanup: `_shared/` `any` → real types | Low | DONE |
| 9 | Type cleanup: reservation lookup/manage/cancel functions | Low | DONE |
| 10 | Type cleanup: Maib functions (`maib-*`) | Low | DONE |
| 11 | Type cleanup: remaining functions | Low | DONE |
| 12 | Harden CORS allowlist across all Edge Functions | Medium | DONE |
| 13 | Defense-in-depth for `requireStaffRole` | Medium | TODO |
| 14 | Relocate backend/tests out of `docs/` — owner-gated | High | TODO |

Statuses: TODO | IN PROGRESS | DONE.

---

## (E) THE STEPS

> Every step lists its own Required reading and file scope so you can load only what you
> need. Run the listed Verification from the repository root unless told otherwise.

---

### STEP 1 — Add `.env.example` (secret names only)
- Status: DONE
- Goal: Provide a committed `.env.example` listing required Edge Function secret **names**
  (no values), so deployers know what to set.
- Depends on: none | Why now: lowest risk, no application code, unblocks onboarding.
- Required reading before starting: `docs/AGENTS.md`, `docs/plan.md`, `docs/README.md`
  (env section), `docs/supabase/functions/_shared/env.ts`,
  `docs/supabase/functions/_shared/providers.ts`,
  `docs/supabase/functions/_shared/maib.ts`,
  `docs/supabase/functions/_shared/supabaseAdmin.ts`.
- In scope: new file `.env.example` at repo root; `.gitignore` already allows it
  (`!.env.example`).
- Out of scope: any `.js`/`.ts` change; do not put real values anywhere.
- Actions:
  1. Confirm the secret names by grepping: `grep -rnE "requiredEnv|optionalEnv" docs/supabase/functions --include='*.ts'`.
  2. Create `.env.example` with one `NAME=` per required secret and a comment per group
     (Supabase, cron/site, SMS.md, Resend, Maib). Names only — leave values blank.
  3. Verify `.gitignore` does not exclude it (`!.env.example` is present).
- Verification:
  - `git check-ignore .env.example` returns nothing (file is trackable).
  - `node --test 'docs/tests/**/*.test.mjs'` → 166 passing (unchanged).
  - Manual: every name in `.env.example` matches a name read in code; no secret values.
- Docs to update on completion: `README.md` (point env section at `.env.example`),
  `security.md` (mark S-4 addressed), `project-structure.md` (new root file),
  `project-history.md` (append), `plan.md` (status+tracker+log). Check `bugs.md`
  (B-4 is the test-runner issue and remains open), `decisions.md`, `conventions.md`,
  and `project-overview.md` and note no change.
- Suggested commit message: `docs: add .env.example with required secret names`

---

### STEP 2 — Fix Deno test discovery so the test task runs the tests
- Status: DONE
- Goal: Make `deno task test` actually execute the 32 backend tests (currently it finds 0).
- Depends on: none | Why now: gives later steps a trustworthy backend verification command.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/bugs.md` (B-1),
  `docs/supabase/functions/deno.json`, the three files in
  `docs/supabase/functions/tests/` (`maib.test.ts`, `reservation-manage.test.ts`,
  `reservations.test.ts`), and any file that imports them (none expected).
- In scope: rename the three test files to `*.test.ts`, OR change the `deno.json` `test`
  task to list them / use a matching glob. Prefer renaming to `*.test.ts` (matches Deno's
  default discovery and the frontend `*.test.mjs` convention).
- Out of scope: changing test contents/assertions; touching non-test code.
- Actions:
  1. `git mv` each `tests/<name>-test.ts` → `tests/<name>.test.ts` (if renaming).
  2. Confirm no import path references the old names (`grep -rn "\-test.ts" docs/supabase`).
  3. Leave `deno.json` task as `deno test --allow-env --allow-net tests` (now discoverable),
     or update it explicitly if you chose not to rename.
- Verification:
  - `cd docs/supabase/functions && deno test --allow-env --allow-net tests` → **32 passed**
    (no "No test modules found").
  - `node --test 'docs/tests/**/*.test.mjs'` → 166 passing (unchanged).
- Docs to update: `README.md` (test section — `deno task test` now works; remove the
  explicit-path workaround note), `bugs.md` (B-1 → Fixed), `conventions.md` (test naming),
  `project-structure.md` (renamed test files), `project-history.md`, `plan.md`, and the
  Node contract test that asserts backend test files exist. Check the rest.
- Suggested commit message: `fix: make deno test task discover the edge function tests`

---

### STEP 3 — Document/enable a one-command test runner
- Status: DONE
- Goal: Provide one obvious way to run both suites, and decide whether a minimal
  `package.json` should exist (no deps) purely for `test` scripts.
- Depends on: STEP 2 | Why now: after discovery is fixed, lock in the canonical commands.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/README.md` (test section),
  `docs/decisions.md` (open question on `package.json`), `.claude/settings.local.json`.
- In scope: EITHER add a minimal root `package.json` with `"test"` /
  `"test:deno"` scripts (no dependencies), OR a short `docs/README.md`-referenced
  shell snippet. Log the choice as an ADR.
- Out of scope: adding any runtime dependency, bundler, or build step (forbidden by
  ADR-001 unless a new ADR overrides it).
- Actions:
  1. Decide package.json-vs-docs; record in `docs/decisions.md`.
  2. Implement the chosen option (scripts only; no `dependencies`).
  3. Ensure both commands run from the repo root.
- Verification:
  - The documented command runs both suites green: `npm test` → 171 Node + 32 Deno.
- Docs to update: `README.md`, `decisions.md` (resolve the open question), `bugs.md`
  (B-4 → Fixed/closed), `conventions.md` if scripts are added, `project-history.md`,
  `plan.md`. Check the rest.
- Suggested commit message: `chore: provide a single documented test runner`

---

### STEP 4 — Fix `require-await` lint violations
- Status: DONE
- Goal: Resolve the 4 `require-await` lint errors without changing behavior.
- Depends on: STEP 2 | Why now: trivial, isolated, improves lint baseline early.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/conventions.md` (Edge
  Functions), `docs/supabase/functions/_shared/providers.ts` (`sendSms`, `sendEmail`),
  `docs/supabase/functions/_shared/reservationManage.ts` (`hashManageToken`,
  `hashLookupCode`), and their call sites
  (`grep -rn "sendSms\|sendEmail\|hashManageToken\|hashLookupCode" docs/supabase/functions`).
- In scope: those two `_shared` files and only what's needed to keep call sites correct.
- Out of scope: behavioral changes; the `any` cleanup (separate steps).
- Actions:
  1. For each flagged function, either remove `async` (and adjust callers if they relied
     on a returned Promise) or introduce a genuine `await`. Choose the option that keeps
     callers working unchanged (callers likely already `await`; keeping `async` but
     making the body actually async, or returning the value directly, both work — pick the
     minimal change that satisfies lint and keeps tests green).
- Verification:
  - `cd docs/supabase/functions && deno lint` → the 4 `require-await` errors are gone
    (88 unrelated lint findings remain for later steps).
  - `cd docs/supabase/functions && deno check $(find . -name '*.ts' -not -path './tests/*' | tr '\n' ' ')` → passes.
  - `deno test --allow-env --allow-net tests` → 32 passing.
  - `node --test 'docs/tests/**/*.test.mjs'` → 171 passing.
- Docs to update: `bugs.md` (B-5 partial), `conventions.md` if guidance changes,
  `project-history.md`, `plan.md`. Check the rest.
- Suggested commit message: `fix: resolve deno require-await lint warnings`

---

### STEP 5 — Fix `no-import-prefix` lint violation
- Status: DONE
- Goal: Remove the inline `npm:`/`jsr:`/`https:` import-prefix lint error.
- Depends on: STEP 2 | Why now: trivial config fix, no runtime impact expected.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`,
  `docs/supabase/functions/deno.json`, `docs/supabase/functions/import_map.json`,
  the function files that import `@supabase/supabase-js`
  (`grep -rn "@supabase/supabase-js" docs/supabase/functions`).
- In scope: `deno.json` / `import_map.json` import wiring.
- Out of scope: changing the supabase-js major version; function logic.
- Actions:
  1. Identify the offending inline prefix flagged by `deno lint`.
  2. Move the dependency mapping to the import map / proper `imports` form so the lint
     rule passes, keeping the resolved version identical.
- Completion note: the actual `no-import-prefix` finding was the inline
  `https://deno.land/std@0.224.0/assert/mod.ts` import in
  `docs/supabase/functions/tests/maib.test.ts` (inferred from `deno lint` output), not
  the already mapped `@supabase/supabase-js` import.
- Verification:
  - `cd docs/supabase/functions && deno lint` → `no-import-prefix` error gone.
  - `deno check` (as in STEP 4) → passes; `deno test … tests` → 32 passing.
- Docs to update: `bugs.md` (B-5 partial), `project-history.md`, `plan.md`. Check the rest.
- Suggested commit message: `fix: resolve deno no-import-prefix lint warning`

---

### STEP 6 — Resolve orphaned media owner decision
- Status: DONE
- Goal: Decide whether to remove unreferenced large binaries and the unused logo to slim
  the repo.
- Depends on: none | Why now: low risk once confirmed; do not delete ambiguous files
  without owner confirmation (AGENTS safety rule).
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/bugs.md` (B-2, B-3).
- In scope: `ecovilavideo.mp4`, `ecovilavideo-web.mp4`, `assets/logo_small.png`.
- Out of scope: `assets/videos/ecovila-hero.mp4` (in use), any history rewrite.
- Actions:
  1. Re-confirm zero references: `grep -rn "ecovilavideo" *.html admin/*.html js/*.js`
     and `grep -rn "logo_small" . --include='*.html' --include='*.js' --include='*.css'`.
  2. **Flag to the human and get confirmation** that these are removable.
  3. On confirmation, `git rm` the files (working-tree removal only; no history rewrite
     unless explicitly approved).
- Completion note: owner explicitly declined removal, so the files were kept and B-2/B-3
  were marked Accepted instead of Fixed.
- Verification:
  - Both greps return no references.
  - `node --test 'docs/tests/**/*.test.mjs'` → 171 passing.
  - Manual: `site.html` still loads `assets/videos/ecovila-hero.mp4`.
- Docs to update: `project-structure.md` (drop the removed entries if removed, or mark
  owner-retained if kept), `bugs.md` (B-2/B-3 → Fixed or Accepted),
  `project-history.md`, `plan.md`. Check the rest.
- Suggested commit message: `docs: record owner decision for unreferenced media`

---

### STEP 7 — Remove hardcoded placeholder phone defaults
- Status: DONE
- Goal: Stop silently substituting fake phone numbers for reservations.
- Depends on: none | Why now: small, security-adjacent (S-5), independent.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/security.md` (S-5),
  `admin/js/crm-sidebar.js` (around line 205), `js/checkout.js` (around line 432), and
  the server-side validation in `docs/supabase/functions/_shared/reservations.ts`
  (`buildReservationRows`).
- In scope: the two placeholder defaults; minimal validation messaging.
- Out of scope: redesigning the phone-entry UX; international-phone parsing logic.
- Actions:
  1. Replace `'+37300000000'` (crm-sidebar) and the `'+373'` silent default (checkout)
     with proper required-field handling (block submit / surface an error) rather than a
     fabricated number. Keep `+373` only as a non-committal input *placeholder attribute*
     if desired, never as a stored value.
- Completion note: also converted the CRM search phone prefix to placeholder-only for
  consistency, although it was not a stored reservation value.
- Verification:
  - `node --test 'docs/tests/**/*.test.mjs'` → 171 passing (update a contract test only
    if it explicitly asserts the old default; record any such change).
  - Manual: submitting checkout/CRM-add with an empty phone is rejected, not silently
    filled.
- Docs to update: `security.md` (S-5 → Fixed), `conventions.md` (no fabricated defaults),
  `project-history.md`, `plan.md`. Check the rest.
- Suggested commit message: `fix: stop substituting placeholder phone numbers`

---

### STEP 8 — Type cleanup: `_shared/` `any` → real types
- Status: DONE
- Goal: Remove `no-explicit-any` in the shared backend modules (~17 across
  notifications/reservations/maib/reservationManage).
- Depends on: STEP 2 | Why now: shared types first so per-function steps reuse them.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/conventions.md`,
  `docs/supabase/functions/_shared/notifications.ts`,
  `docs/supabase/functions/_shared/reservations.ts`,
  `docs/supabase/functions/_shared/maib.ts`,
  `docs/supabase/functions/_shared/reservationManage.ts`,
  `docs/supabase/functions/_shared/supabaseAdmin.ts` (for the client type).
- In scope: only those `_shared` files. Introduce a shared `SupabaseClient` type alias
  (e.g. from `supabaseAdmin.ts`) to replace `client: any`.
- Out of scope: per-function entrypoints (STEPs 9–11); behavior changes.
- Actions:
  1. Replace each `any` with a precise type (`SupabaseClient`, generated row types, or
     `unknown` + narrowing). Prefer a single exported client type reused everywhere.
- Verification:
  - `cd docs/supabase/functions && deno check $(find . -name '*.ts' -not -path './tests/*' | tr '\n' ' ')` → passes.
  - `deno lint` → no `no-explicit-any` remaining **in `_shared/`** (count drops by the
    `_shared` total).
  - `deno test --allow-env --allow-net tests` → 32 passing.
- Docs to update: `bugs.md` (B-5 progress), `conventions.md` (shared client type),
  `project-history.md`, `plan.md`. Check the rest.
- Suggested commit message: `refactor: type shared edge function helpers (remove any)`

---

### STEP 9 — Type cleanup: reservation lookup/manage/cancel functions
- Status: DONE
- Goal: Remove `any` in `reservation-lookup-start`, `reservation-lookup-verify`,
  `reservation-manage-details`, `reservation-cancel` (~21).
- Depends on: STEP 8 | Why now: reuses the shared client type from STEP 8.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/conventions.md`, the four
  `index.ts` files under those function dirs, and `_shared/reservationManage.ts`.
- In scope: those four `index.ts` files only.
- Out of scope: other functions; behavior changes.
- Actions: replace each `any` with the shared type / row types / `unknown` + narrowing.
- Verification:
  - `deno check` (full, as above) → passes.
  - `deno lint` → no `no-explicit-any` in these four files.
  - `deno test --allow-env --allow-net tests` → 32 passing.
- Docs to update: `bugs.md` (B-5 progress), `project-history.md`, `plan.md`. Check the rest.
- Suggested commit message: `refactor: type reservation lookup/manage functions`

---

### STEP 10 — Type cleanup: Maib functions (`maib-*`)
- Status: DONE
- Goal: Remove `any` in `maib-callback` (17) and `maib-create-payment` (11).
- Depends on: STEP 8 | Why now: groups the highest-density payment files together.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/conventions.md`,
  `maib-callback/index.ts`, `maib-create-payment/index.ts`, and `_shared/maib.ts`.
- In scope: those two `index.ts` files only. (`maib-refund`'s previous lone `any` was
  removed by the 2026-05-31 off-plan cancellation policy fix.)
- Out of scope: signature/verification logic changes (S-1/S-2 are separate steps).
- Actions: replace each `any` with precise types for Maib payloads/DB rows.
- Verification:
  - `deno check` (full) → passes; `deno lint` → no `no-explicit-any` in
    `maib-callback` / `maib-create-payment`; `deno test … tests` → 32 passing
    (Maib tests still green).
- Docs to update: `bugs.md` (B-5 progress), `project-history.md`, `plan.md`. Check the rest.
- Suggested commit message: `refactor: type maib edge functions (remove any)`

---

### STEP 11 — Type cleanup: remaining functions
- Status: DONE
- Goal: Remove the last `any` in `confirm-reservation-payment` (7),
  `expire-cash-reservations` (8), `send-reminders` (5), `create-reservation` (1).
- Depends on: STEP 8 | Why now: clears the remaining lint debt so `deno lint` is clean.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/conventions.md`, those four
  `index.ts` files, `_shared/notifications.ts`.
- In scope: those four `index.ts` files only.
- Out of scope: behavior changes.
- Actions: replace each `any` with precise types.
- Verification:
  - `deno check` (full) → passes.
  - `cd docs/supabase/functions && deno lint` → **0 problems** (assuming STEPs 4,5,8–10
    done).
  - `deno test … tests` → 32 passing; `node --test 'docs/tests/**/*.test.mjs'` → 171.
- Docs to update: `bugs.md` (B-5 → Fixed/closed once lint is clean), `conventions.md`
  (drop the "lint debt" note), `project-history.md`, `plan.md`. Check the rest.
- Suggested commit message: `refactor: type remaining edge functions; deno lint clean`

---

### STEP 12 — Harden CORS allowlist across all Edge Functions
- Status: DONE
- Goal: Restrict `Access-Control-Allow-Origin` to the known EcoVila origins on every
  function, not just `maib-create-payment` (S-1).
- Depends on: STEPs 8–11 (codebase well-typed/understood) | Why now: behavior-affecting;
  do it once functions are well understood and tests are reliable.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/security.md` (S-1),
  `docs/supabase/functions/_shared/cors.ts`,
  `docs/supabase/functions/maib-create-payment/index.ts` (reference allowlist), and every
  function `index.ts` (to thread the allowlist through `handleCors`/`withCors`).
- In scope: `_shared/cors.ts` and each function's CORS call sites.
- Out of scope: auth/signature logic; CORS for `maib-callback` if cross-origin browser
  access is not used there (server-to-server callbacks don't need permissive CORS — keep
  it minimal/closed).
- Actions:
  1. Centralize the allowlist in `_shared/cors.ts` behind an env var
     (e.g. `ECOVILA_ALLOWED_ORIGINS`, comma-separated) with the current hardcoded list as
     the default.
  2. Make functions default to the allowlist instead of `*`.
  3. Keep `OPTIONS` preflight working for legitimate origins.
- Verification:
  - `deno check` / `deno lint` clean; `deno test … tests` → 35 passing.
  - Manual/local: a request with `Origin: https://ecovila.md` gets that origin echoed; an
    unknown origin does not receive a permissive `*`.
  - **Smoke-test the live booking/checkout/CRM flows in a browser** (this is the highest
    regression risk — a wrong allowlist breaks the site).
- Docs to update: `security.md` (S-1 → Fixed), `decisions.md` (ADR for the env-driven
  allowlist), `conventions.md` (CORS rule), `README.md` (new env var name),
  `.env.example` (add the name), `project-history.md`, `plan.md`. Check the rest.
- Suggested commit message: `fix: restrict edge function CORS to known origins`

---

### STEP 13 — Defense-in-depth for `requireStaffRole`
- Status: TODO
- Goal: Make role gating robust even if a function's `verify_jwt` were ever disabled (S-2).
- Depends on: STEPs 8–11 | Why now: security hardening, best done with typed, understood code.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/security.md` (S-2),
  `docs/supabase/functions/_shared/http.ts` (`requireStaffRole`, `parseJwtPayload`),
  `docs/supabase/config.toml` (which functions set `verify_jwt`), and the staff functions
  that call `requireStaffRole`.
- In scope: `_shared/http.ts` and a guard/assertion or JWKS verification.
- Out of scope: changing role semantics; CRM auth UI.
- Actions:
  1. Either verify the JWT signature against the project JWKS inside `requireStaffRole`,
     OR add an explicit invariant (and documented assertion/test) that every caller runs
     with `verify_jwt = true` per `config.toml`. Prefer real verification if feasible
     without heavy deps.
- Verification:
  - `deno check` / `deno lint` clean; `deno test … tests` → 32 passing; add/adjust a Deno
    test asserting unauthorized/forged-role requests are rejected.
- Docs to update: `security.md` (S-2 → Fixed), `decisions.md` (ADR), `conventions.md`
  (auth rule), `project-history.md`, `plan.md`. Check the rest.
- Suggested commit message: `fix: harden staff-role authorization in edge functions`

---

### STEP 14 — Relocate backend/tests out of `docs/` — owner-gated, HIGH RISK
- Status: TODO
- Goal: Move `docs/supabase/` → `supabase/` and `docs/tests/` → `tests/` to match Supabase
  CLI conventions (B-6), if the owner agrees.
- Depends on: STEPs 1–13 | Why now: highest blast radius (touches every test path, the
  CLI workflow, and many contract tests); do it last when everything else is stable.
- Required reading: `docs/AGENTS.md`, `docs/plan.md`, `docs/bugs.md` (B-6),
  `docs/decisions.md` (open question), every `docs/tests/*.test.mjs` (for `require('../../js/…')`
  relative paths), `docs/supabase/config.toml`, and CI/deploy notes in `docs/README.md`.
- In scope: moving the two trees and fixing ALL path references (test `require` paths,
  Supabase CLI config, the documented test commands, any plan/spec references).
- Out of scope: changing test logic or function behavior.
- Actions:
  1. **Get explicit owner confirmation** that this move is wanted (it is a structural
     decision, currently Unknown). Record the decision in `docs/decisions.md`.
  2. If approved: `git mv` the trees; fix every relative path
     (`grep -rn "docs/tests\|docs/supabase\|\.\./\.\./js" .`); update README test/deploy
     commands and `.claude/settings.local.json` permission globs if present.
  3. Update every doc that references the old paths (this whole doc set references
     `docs/supabase` and `docs/tests`).
- Verification:
  - `node --test 'tests/**/*.test.mjs'` → 171 passing at the new path.
  - `cd supabase/functions && deno test --allow-env --allow-net tests` → 32 passing.
  - `deno check` / `deno lint` clean at new paths.
  - `grep -rn "docs/tests\|docs/supabase" .` → only intentional historical references in
    `project-history.md`, if any.
- Docs to update: **all of them** (every path reference), especially `README.md`,
  `project-structure.md`, `conventions.md`, `bugs.md` (B-6 → Fixed),
  `decisions.md`, `project-history.md`, `plan.md`. 
- Suggested commit message: `refactor: relocate supabase backend and tests to repo root`

---

## (F) SESSION LOG (append; newest last)

- **2026-05-31 — Phase 0 audit & plan (no step executed).** Performed full repository
  audit without changing application code. Verified: 164 Node tests pass
  (`node --test 'docs/tests/**/*.test.mjs'`), 32 Deno tests pass (by explicit path),
  `deno check` passes, `deno lint` = 93 problems. Discovered B-1 (broken `deno task test`
  discovery), orphaned media (B-2/B-3), missing `.env.example` (S-4/B-4), wildcard CORS
  (S-1), unverified role-claim decode (S-2), placeholder phones (S-5), and the
  backend/tests-under-`docs/` quirk (B-6). Authored the full doc set under `docs/` and
  this 14-step plan. **Next session: STEP 1.**
- **2026-05-31 — OFF-PLAN cancellation policy fix (commit: 577b252).** Enforced the guest online cancellation window (at least 7 calendar days before arrival or first 2 hours after creation), blocked cash online cancellation with office-only reimbursement copy, and routed paid Maib CRM cancellations through the Diana-only refund function; planned step statuses unchanged.
- **2026-05-31 — STEP 1 (commit: 0679247).** Added root `.env.example` with blank Supabase, cron/site, SMS.md, Resend, and Maib names; verified 166 Node tests, 32 Deno tests, `deno check`, and `git check-ignore`; checked README, project-overview, project-structure, project-history, security, bugs, decisions, conventions, and plan.
- **2026-05-31 — STEP 2 (commit: 14eee8b).** Renamed Deno backend tests to `*.test.ts` so `deno task test` discovers all 32 tests; updated the Node contract test plus README, project-structure, project-history, bugs, conventions, and plan; checked project-overview, security, and decisions with no changes needed.
- **2026-05-31 — STEP 3 (commit: c1d963c).** Added scripts-only root `package.json` plus a test-runner contract; verified `npm test` (168 Node + 32 Deno); updated README, project-structure, project-history, bugs, decisions, conventions, and plan; checked project-overview/security with no changes needed.
- **2026-05-31 — STEP 4 (commit: 53d78c4).** Removed unnecessary `async` from `sendSms`, `sendEmail`, `hashLookupCode`, and `hashManageToken`; verified no `require-await` lint output, `deno check`, 32 Deno tests, and 168 Node tests; updated README, project-history, bugs, and plan; checked project-overview, project-structure, security, decisions, and conventions with no changes needed.
- **2026-05-31 — STEP 5 (commit: 311bdba).** Added the `std/assert` Deno import-map alias and changed `maib.test.ts` to use the bare specifier; verified no `no-import-prefix` lint output, `deno check`, and 32 Deno tests; updated README, project-history, bugs, conventions, and plan; checked project-overview, project-structure, security, and decisions with no changes needed.
- **2026-05-31 — STEP 6 (commit: aa1cc08).** Reconfirmed no scoped references to `ecovilavideo.mp4`, `ecovilavideo-web.mp4`, or `assets/logo_small.png`; owner declined removal, so the files were kept and B-2/B-3 were marked Accepted; verified 168 Node tests; updated project-structure, project-history, bugs, decisions, and plan; checked README, project-overview, security, and conventions with no changes needed.
- **2026-05-31 — STEP 7 (commit: 7784bbb).** Removed checkout/CRM fabricated phone defaults, kept `+373` as placeholder-only copy, added contract coverage for empty-phone rejection, and verified `npm test` (171 Node + 32 Deno); updated README, project-history, security, conventions, and plan; checked project-overview, project-structure, bugs, and decisions with no changes needed.
- **2026-05-31 — STEP 8 (commit: 097dc6a).** Removed all `_shared/` explicit `any` usage with shared Supabase client/result aliases and typed helper payloads; verified `deno check`, no `_shared/` lint findings, 32 Deno tests, and full `npm test`; updated README, project-history, security, bugs, conventions, and plan; checked project-overview, project-structure, and decisions with no changes needed.
- **2026-05-31 — STEP 9 (commit: af26332).** Removed all explicit `any` usage from reservation lookup, manage-details, and guest cancellation Edge Function entrypoints with typed Supabase clients and local row/query shapes; verified `deno check`, no Step 9 lint findings, 32 Deno tests, and full `npm test`; updated README, project-history, security, bugs, conventions, and plan; checked project-overview, project-structure, and decisions with no changes needed.
- **2026-05-31 — STEP 10 (commit: 3bec80b).** Removed all explicit `any` usage from `maib-callback` and `maib-create-payment`; verified `deno check`, no Step 10 lint findings, and 32 Deno tests; updated README, project-history, security, bugs, conventions, and plan; checked project-overview, project-structure, and decisions with no changes needed.
- **2026-05-31 — STEP 11 (commit: f4442ab).** Removed the final explicit `any` usage from `confirm-reservation-payment`, `expire-cash-reservations`, `send-reminders`, and `create-reservation`; verified `deno check`, clean `deno lint`, 32 Deno tests, and 171 Node tests; updated README, project-history, security, bugs, conventions, and plan; checked project-overview, project-structure, and decisions with no changes needed.
- **2026-05-31 — STEP 10 status reconciliation (source commit: 3bec80b).** Re-read required Step 10 files, re-verified committed Step 10/11 type-cleanup state, corrected stale Step 10/11 status lines so CURRENT STEP remains Step 12; reviewed README, project-overview, project-structure, project-history, security, bugs, decisions, conventions, and plan with only project-history/plan changes needed.
- **2026-05-31 — STEP 12 (commit: 472e479).** Centralized Edge Function CORS behind default EcoVila origins plus `ECOVILA_ALLOWED_ORIGINS`; verified RED/GREEN CORS tests, `deno check`, clean `deno lint`, 35 Deno tests, 171 Node tests, local CORS request checks, and Chrome smoke of booking/checkout/CRM pages; updated README, project-structure, project-history, security, decisions, conventions, `.env.example`, and plan; checked project-overview and bugs with no changes needed.
