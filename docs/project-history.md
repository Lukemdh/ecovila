# Project History — EcoVila

Reconstructed from git history (`git log`, 41 commits, 2026-05-07 → 2026-05-31), the
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

## Current state (2026-05-31)

- Brief Steps 1–11 are implemented in code. Step 12 (tophost deployment) and live
  provider/secret wiring are operational, not verifiable from the repo.
- Branches present: `main` (default working branch here), `codex/crm-step-9`
  (the repo's configured base for PRs), `codex/crm-towels-daily-cards`. No tags.
- Tests green: 168 Node contract tests + 32 Deno tests.
- The public homepage is a maintenance holding page (`index.html`); full landing at
  `site.html`.
- Notable structural quirk: backend code (`supabase/`) and tests live under `docs/`,
  moved there during the 2026-05-16 "docs reorg" (`ca4dfc5`).

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
