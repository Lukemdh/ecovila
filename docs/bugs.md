# Bugs & Broken Behavior — EcoVila

Found during the Phase 0 audit (2026-05-31) and later off-plan bugfix sessions. Running
log; update Status as bugs are fixed. These are distinct from the cleanup *tasks* in
`docs/plan.md` (though some plan steps fix bugs listed here). Severities: Critical /
High / Medium / Low.

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| B-1 | `deno task test` discovers 0 tests (false green) | Medium | Fixed |
| B-2 | Orphaned ~36MB of unreferenced video binaries committed at repo root | Low | Accepted |
| B-3 | Unused `assets/logo_small.png` | Low | Accepted |
| B-4 | No `package.json` / documented test scripts for the frontend suite | Low | Fixed |
| B-5 | `deno lint` reported remaining `no-explicit-any` problems | Low | Fixed |
| B-6 | Backend + tests lived under `docs/` (mislocated relative to convention) | Low | Fixed |
| B-7 | Online cancellation allowed outside the current public window and for cash reservations | Medium | Fixed |
| B-8 | Legacy confirmation actions can extend/cancel by reservation UUID only | High | Open |
| B-9 | CRM stored-XSS risk from unescaped reservation fields | High | Fixed |
| B-10 | Edge Function accepts child ages `0` and `18` despite public 1-17 contract | Medium | Open |
| B-11 | Maib cron migrations assume `pg_cron`/`cron` exists | Medium | Open |
| B-12 | Public fallback imagery still uses placeholder SVGs | Low | Open |
| B-13 | Dependency audit/scanning gap: `npm audit` cannot run without a lockfile | Low | Open |

---

### B-1 — `deno task test` silently ran zero tests (Medium) — Fixed 2026-05-31
- **Description:** `supabase/functions/deno.json` defines
  `"test": "deno test --allow-env --allow-net tests"`. Before the fix, running it (or
  `deno test --allow-env --allow-net tests` from the functions dir) printed
  **"error: No test modules found"** because the 32 real tests were not discoverable.
- **Former reproduce (before fix):**
  ```sh
  cd supabase/functions
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

### B-2 — Orphaned video binaries at repo root (Low) — Accepted 2026-05-31
- **Description:** `ecovilavideo.mp4` (~15MB) and `ecovilavideo-web.mp4` (~21MB) are
  tracked in git but referenced by no page. The hero video actually used by `site.html`
  is `assets/videos/ecovila-hero.mp4`.
- **Reproduce:** `grep -rn "ecovilavideo" *.html admin/*.html js/*.js` → no matches.
- **Suspected cause:** leftovers from the 2026-05-12 hero-video revamp / the
  "ecovila2 backup" sync.
- **Why it matters:** ~36MB of dead weight in the repo and on any static deploy.
- **Owner decision:** keep `ecovilavideo.mp4` and `ecovilavideo-web.mp4` in the working
  tree despite no current references. Do not remove these files in later cleanup unless
  the owner explicitly reverses this decision.

### B-3 — Unused `assets/logo_small.png` (Low) — Accepted 2026-05-31
- **Description:** no references in any HTML/CSS/JS.
- **Reproduce:** `grep -rn "logo_small" . --include='*.html' --include='*.js' --include='*.css'` → none.
- **Suspected cause:** superseded by `logo.png` / `logoNT.png`.
- **Owner decision:** keep `assets/logo_small.png` despite no current references. Do not
  remove this file in later cleanup unless the owner explicitly reverses this decision.

### B-4 — No `package.json` / documented frontend test scripts (Low) — Fixed 2026-05-31
- **Description:** the Node suite was run with `node --test 'tests/**/*.test.mjs'`
  but there was no manifest documenting it; discovery was tribal knowledge. (The
  `.claude` permissions file hinted at the intended commands.)
- **Why it mattered:** onboarding friction; easy to run tests incorrectly (see the failed
  `node --test tests/` attempt, which errors because it is not the recursive glob).
- **Fix:** added a dependency-free root `package.json` with `test`, `test:node`, and
  `test:deno` scripts; documented `npm test` in `docs/README.md`; recorded ADR-009.

### B-5 — `deno lint`: remaining problems (Low) — Fixed 2026-05-31
- **Description:** `deno lint` formerly reported `no-explicit-any` findings in Edge
  Function helpers and entrypoints.
- **Former reproduce:** `cd supabase/functions && deno lint`.
- **Why it mattered:** code-quality / type-safety debt; not a runtime failure.
  Typecheck (`deno check`) continued to pass throughout the cleanup.
- **2026-05-31 note:** the off-plan cancellation fix removed the lone
  `maib-refund` `no-explicit-any` while preserving B-5 as open lint debt.
- **2026-05-31 Step 4 note:** removed the four `require-await` findings by making
  `sendSms`, `sendEmail`, `hashManageToken`, and `hashLookupCode` regular functions
  that return their existing Promises.
- **2026-05-31 Step 5 note:** moved the Deno std assert dependency behind the
  `std/assert` import-map alias and changed `maib.test.ts` to use the bare specifier,
  removing the lone `no-import-prefix` finding.
- **2026-05-31 Step 8 note:** removed all `_shared/` explicit `any` usage by adding
  shared Supabase client/result aliases and typed notification, reservation, Maib, and
  reservation-management helper payloads. `deno lint --json` now reports 70
  `no-explicit-any` diagnostics total and 0 under `_shared/`.
- **2026-05-31 Step 9 note:** removed all explicit `any` usage from
  `reservation-lookup-start`, `reservation-lookup-verify`, `reservation-manage-details`,
  and `reservation-cancel`. `deno lint --json` now reports 49 `no-explicit-any`
  diagnostics total and 0 under those four files.
- **2026-05-31 Step 10 note:** removed all explicit `any` usage from `maib-callback`
  and `maib-create-payment` with typed payment/reservation/session row shapes.
  `deno lint` now reports 21 `no-explicit-any` findings, all in the Step 11 entrypoints.
- **2026-05-31 Step 11 note:** removed the final explicit `any` usage from
  `confirm-reservation-payment`, `expire-cash-reservations`, `send-reminders`, and
  `create-reservation`. `deno lint` now passes with 0 problems.

### B-6 — Backend and tests under `docs/` (Low / structural) — Fixed 2026-06-01
- **Description:** before Step 14, the Supabase workspace and Node test suite lived in
  documentation subdirectories instead of root-level `supabase/` and `tests/`.
  Convention puts these at the repo root.
- **Suspected cause:** the 2026-05-16 "docs reorg" (`ca4dfc5 Fix test harness paths
  after docs reorg`).
- **Why it mattered:** surprising for newcomers; tooling defaults (Supabase CLI expects
  a top-level `supabase/`) may not find these without configuration.
- **Fix:** owner approved the structural move. Step 14 relocated both trees to the repo
  root, updated package scripts, test paths, `.claude` command permissions, and every
  documented reference to the old layout.

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
- **Verification:** covered by Node contract tests in `tests/anulare.test.mjs`,
  `tests/reservation-lookup-refunds.test.mjs`, `tests/admin-crm.test.mjs`,
  and Deno test `supabase/functions/tests/reservation-manage.test.ts`.

### B-8 — Legacy confirmation actions can extend/cancel by reservation UUID only (High) — Open
- **Description:** the non-managed confirmation flow still calls
  `get_pending_reservation_status`, `extend_cash_reservation`, and
  `cancel_pending_reservation` with only `reservationId` from
  `confirmare.html?id=<uuid>`. The SQL RPCs in
  `20260511120000_step6_guest_confirmation.sql` are `security definer` functions granted
  to `anon` and `authenticated`.
- **Root cause:** the newer manage-token flow was added for lookup/refunds but did not
  replace the older confirmation-page cash actions.
- **Why it matters:** a leaked confirmation URL becomes a bearer link that can extend or
  cancel a pending reservation. UUID guessing is unlikely, but URL forwarding, browser
  history, support screenshots, analytics, or email compromise are realistic leak paths.
- **Reproduce / evidence:**
  ```sh
  rg -n "extend_cash_reservation|cancel_pending_reservation|get_pending_reservation_status" js/supabase.js supabase/migrations/20260511120000_step6_guest_confirmation.sql
  ```
- **Fix direction:** require a hashed manage token or signed action token for all
  pending reservation status/action RPCs, update `confirmare.html` links, and revoke the
  old UUID-only RPCs.

### B-9 — CRM stored-XSS risk from unescaped reservation fields (High) — Fixed 2026-06-01
- **Description:** several authenticated CRM surfaces interpolated guest-controlled
  reservation data into `innerHTML` templates. `guest_first_name` / `guest_last_name`
  were only trimmed server-side, so markup submitted during public booking could be
  stored and rendered in staff sessions.
- **Fix:** added shared CRM escaping via `EcoVilaCrmCalendar.escapeHtml`; escaped
  calendar reservation cards, pending-cash cards, sidebar search results, and daily
  reception cards; and rejected public guest names containing `<` or `>`.
- **Verification:** Node contract tests cover `<img src=x onerror=alert(1)>` and an
  unsafe phone payload across the affected CRM cards. The Deno reservation test asserts
  public guest names with HTML control characters are rejected.

### B-10 — Edge Function accepts child ages `0` and `18` (Medium) — Open
- **Description:** the public booking contract allows child ages 1-17, but
  `normalizeKidsAges` in `supabase/functions/_shared/reservations.ts` accepts whole
  numbers from 0 to 18.
- **Reproduce:**
  ```sh
  cd supabase/functions
  deno eval "import { buildReservationRows } from './_shared/reservations.ts'; console.log(JSON.stringify(buildReservationRows([{ room_id: '00000000-0000-0000-0000-000000000001', guest_first_name: 'A', guest_last_name: 'B', guest_phone: '+37360123456', guest_email: 'a@example.md', check_in: '2026-07-01', check_out: '2026-07-02', adults: 1, kids_ages: [0, 18], total_price: 1, payment_type: 'cash' }], { now: new Date('2026-06-01T00:00:00Z') })[0].kids_ages));"
  # -> [0,18]
  ```
- **Why it matters:** direct callers can create reservations that the public UI and
  pricing contract say are invalid.
- **Fix direction:** enforce ages 1-17 server-side and add Deno tests proving 0/18 are
  rejected.

### B-11 — Maib cron migrations assume `pg_cron`/`cron` exists (Medium) — Open
- **Description:** `20260526193653_maib_session_expiry_cron.sql` and
  `20260527082000_maib_unstarted_payment_cleanup.sql` call `cron.schedule`, but the
  migration set never creates/enables `pg_cron`.
- **Reproduce / evidence:**
  ```sh
  rg -n "cron\\.schedule|create extension.*cron|pg_cron" supabase/migrations
  ```
- **Why it matters:** `supabase db push` can fail in a fresh project if `pg_cron` is not
  already enabled. This is a production rollout blocker, not a runtime bug in the static
  frontend.
- **Fix direction:** add a migration that enables the required extension(s), or replace
  the SQL cron with a scheduled Edge Function and document the operational setup.

### B-12 — Public fallback imagery still uses placeholder SVGs (Low) — Open
- **Description:** shipped public pages reference the placeholder SVG files under
  `assets/photos/**` when no CRM-published Supabase photos are available. The SVGs
  explicitly identify themselves as placeholders in their `<title>` / `<desc>`.
- **Why it matters:** production can launch with illustrated placeholder surfaces if CRM
  photos have not been uploaded and published first.
- **Fix direction:** publish real CRM photos before launch or replace the committed
  fallback assets with approved production imagery.

### B-13 — Dependency audit/scanning gap (Low) — Open
- **Description:** the repo intentionally has no npm dependencies or lockfile, so
  `npm audit --omit=dev --audit-level=moderate` exits with `ENOLOCK`. `deno outdated`
  works and reported `@supabase/supabase-js` 2.105.3 current / 2.106.2 latest on
  2026-06-01.
- **Why it matters:** dependency and supply-chain drift are not automatically surfaced.
- **Fix direction:** either accept this as a documented no-build tradeoff, or add a
  lightweight CI/security scanning path that does not introduce a production build step.

---

## Items checked and NOT bugs

- `site.html` hero `<source src="/assets/videos/ecovila-hero.mp4">` — the file exists;
  not broken.
- `index.html` not linking to `site.html` — **intentional** maintenance holding page,
  asserted by `tests/maintenance-page.test.mjs`.
- `js/pricing.js` / `js/calendar.js` imported by both browser and Node tests — the
  UMD wrapper is by design, not a duplication bug.
- `send-sms` and `send-email` are not called from the public browser; they are
  Diana-only direct staff endpoints and shared provider helpers are used internally by
  notification flows.
