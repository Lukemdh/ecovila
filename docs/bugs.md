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
| B-8 | Legacy confirmation actions could extend/cancel by reservation UUID only | High | Fixed |
| B-9 | CRM stored-XSS risk from unescaped reservation fields | High | Fixed |
| B-10 | Edge Function accepts child ages `0` and `18` despite public 1-17 contract | Medium | Open |
| B-11 | Maib cron migrations assume `pg_cron`/`cron` exists | Medium | Open |
| B-12 | Public fallback imagery still uses placeholder SVGs | Low | Open |
| B-13 | Dependency audit/scanning gap: `npm audit` cannot run without a lockfile | Low | Open |
| B-14 | CRM daily reception shows pending and cancelled reservations | Medium | Fixed |
| B-15 | SMS provider URL contains phone/message/token query parameters | High | Open |
| B-16 | Arrival reminders sent overnight (~03:00 EEST) instead of daytime | Low | Fixed |
| B-17 | Maib success redirect lands on "Rezervarea nu a fost găsită" | High | Fixed |
| B-18 | Confirmation page shows wrong payment panel + unused cash timer | Medium | Fixed |
| B-19 | Confirmation page has a large gap between confirmed and manage panels | Low | Fixed |
| B-20 | Booking card showed "De la" prefix on the exact-dates stay total | Low | Fixed |
| B-21 | Finance one-day calendar Apply did nothing | Medium | Fixed |
| B-22 | CRM delete used typed `sterge` and reset calendar position | Medium | Fixed |

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

### B-8 — Legacy confirmation actions could extend/cancel by reservation UUID only (High) — Fixed 2026-06-01
- **Description:** the non-managed confirmation flow called
  `get_pending_reservation_status`, `extend_cash_reservation`, and
  `cancel_pending_reservation` with only `reservationId` from
  `confirmare.html?id=<uuid>`. The SQL RPCs in
  `20260511120000_step6_guest_confirmation.sql` were `security definer` functions
  granted to `anon` and `authenticated`.
- **Root cause:** the newer manage-token flow was added for lookup/refunds but did not
  replace the older confirmation-page cash actions.
- **Why it mattered:** a leaked confirmation URL became a bearer link that could extend
  or cancel a pending reservation. UUID guessing is unlikely, but URL forwarding,
  browser history, support screenshots, analytics, or email compromise are realistic
  leak paths.
- **Fix:** `create-reservation` now creates a hashed `reservation_manage_tokens` row and
  returns the plaintext token only to the checkout caller. Direct cash redirects, Maib
  success/failure URLs, booking/payment confirmations, and cash-expiry reminders include
  `confirmare.html?id=<uuid>&manage=<token>`. `confirmare.js` rejects bare reservation
  IDs and routes status, extension, and cancellation through token-backed Edge
  Functions. A new migration drops the old UUID-only RPC signatures.
- **Verification:** Node tests cover bare-ID rejection, token-bearing confirmation URLs,
  the new `reservation-extend-cash` wrapper/config, and the absence of browser UUID-only
  RPC calls; Deno tests cover the manage-token row helper.

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

### B-14 — CRM daily reception shows pending and cancelled reservations (Medium) — Fixed 2026-06-02
- **Description:** `Situația zilnică` should show only confirmed reservations, but the
  daily check-in/check-out lists formerly rendered any reservation row returned for the
  selected date. The repo has no literal `confirmed` reservation status; confirmed maps
  to `payment_status = 'paid'` with `cancelled_at is null` **(inferred)** from the DB
  status constraint (`pending` / `paid` / `cancelled`) and the cash/Maib confirmation
  paths that promote paid bookings to `payment_status = 'paid'`.
- **Instances found:**
  - `admin/js/crm-daily.js` `loadDaily` fetches `previousDay..nextDay`, stores the raw
    result in `state.reservations`, and derives `state.checkIns` / `state.checkOuts`
    by `check_in === selectedDate` / `check_out === selectedDate` only. There is no
    `payment_status === 'paid'` or `cancelled_at is null` filter before rendering.
  - `admin/js/crm-daily.js` `filterDailyReservations` / `renderSection` only apply the
    free-text search filter to the already-selected rows, so pending and cancelled rows
    remain visible when they match the date/search.
  - `js/supabase.js` `fetchAdminReservations` intentionally returns all statuses for
    staff calendar/dashboard callers; this shared helper is not itself safe to tighten
    globally because the dashboard needs pending cash rows and optional cancelled-row
    display. The daily caller needs a local confirmed-only filter or an explicit helper
    option.
  - `tests/admin-crm.test.mjs` covers daily rendering/escaping with a paid row only; it
    has no regression asserting that pending or cancelled rows are excluded from daily
    check-in/check-out lists.
- **Former runtime evidence:** a one-off Node probe loaded `admin/js/crm-daily.js` with a fake
  `fetchAdminReservations` returning three selected-date rows (`paid`, `pending`,
  `cancelled`). `loadDaily` produced `checkInIds: ["paid-in","pending-in","cancelled-in"]`
  and rendered 3 cards.
- **Why it matters:** staff can see and act on holds that are not real confirmed stays,
  plus rows already cancelled/released, making reception/towel/checkout operations
  inaccurate.
- **Fix:** `admin/js/crm-daily.js` now filters daily check-in/check-out rows to
  `payment_status === 'paid' && !cancelled_at` before fetching daily status records or
  rendering cards. `fetchAdminReservations` remains broad for dashboard/calendar
  callers, so pending holds and optional cancelled-row display still work outside the
  daily reception view.
- **Verification:** `tests/admin-crm.test.mjs` now covers paid, pending,
  `payment_status = 'cancelled'`, and non-null `cancelled_at` rows on the selected
  daily date, and asserts that only paid non-cancelled arrivals/departures are rendered.

### B-15 — SMS provider URL contains phone/message/token query parameters (High) — Open
- **Description:** the SMS provider call passes phone/message/token in the URL query
  string, which violates the no-PII-in-URLs constraint and Legea 195/2024.
- **Scope note:** owner explicitly kept this out of the SEO/tracking effort. It is
  tracked as standalone Step 20 in `docs/plan.md`; do not let new tracking code repeat
  this URL-query PII pattern.
- **Fix direction:** use a POST body if SMS.md supports it. If the provider only
  accepts GET, ensure the full request URL is never written to logs or telemetry.

### B-16 — Arrival reminders sent overnight instead of daytime (Low) — Fixed 2026-06-03
- **Description:** guests received the "Vă așteptăm mâine la EcoVila" arrival reminder
  around 03:00 EEST. `send-reminders` runs ~every minute (the cash-expiry warning window
  is only 2 minutes wide), and `sendArrivalReminders` selected `check_in = tomorrow`
  computed from the **UTC** date. The UTC date rolls over at 00:00 UTC, which is 03:00
  EEST (summer), so the batch fired then.
- **Fix:** added `supabase/functions/_shared/reminders.ts` with
  `shouldSendArrivalReminders(now)` (gate at `ARRIVAL_REMINDER_LOCAL_HOUR = 10`,
  Europe/Chisinau, DST-aware) and `arrivalReminderTargetDate(now)` (tomorrow in local
  time). `sendArrivalReminders` returns early before 10:00 local; dedup
  (`notification_events` unique `(reservation_id, event_type)`) keeps the batch single
  even though the cron keeps ticking. Cash-expiry warnings are unaffected.
- **Verification:** `supabase/functions/tests/reminders.test.ts` covers the overnight
  hold, the 10:00 release, daytime release, and the local "tomorrow" date (incl.
  month rollover). See [[ADR-019]] in `docs/decisions.md`.

### B-17 — Maib success redirect lands on "Rezervarea nu a fost găsită" (High) — Fixed 2026-06-03
- **Description:** after a successful card payment the guest was redirected to the
  confirmation page's error state. `maib-create-payment` builds
  `successUrl = confirmare.html?id=<id>&manage=<token>&payment=success`, but the maib
  Checkout gateway does not preserve those query parameters on the browser redirect — it
  appends its own `checkoutId`/`checkoutStatus`/`orderId` (per maib docs; preservation of
  pre-existing params is undocumented). With `id`/`manage` missing, `confirmare.js`
  `init()` hit the `if (!reservationId || !manageToken)` guard and showed the error.
  Cash bookings were unaffected because they redirect directly without the maib round-trip.
- **Fix:** `confirmare.js` now recovers `id`/`manage` from the pending reservation that
  `checkout.js` already persists in `localStorage` (`ecovila_pending_reservation`,
  including `primaryReservationId`, `bookingGroupId`, `manageToken`) before redirecting
  to maib. Recovery only triggers when the URL lacks the params, and is matched against
  maib's returned `orderId` (= our `bookingGroupId`) when present. The manage-token
  requirement is unchanged — a valid token is still required, just sourced from the same
  browser's storage. See [[ADR-020]].
- **Verification:** `npm test` (frontend contract suite still asserts the
  `if (!reservationId || !manageToken)` guard remains). Manual reasoning + the localStorage
  shape written by `checkout.js`.

### B-18 — Confirmation page shows wrong payment panel + unused cash timer (Medium) — Fixed 2026-06-03
- **Description:** when a guest searched for / returned to a reservation, the managed
  view rendered a status panel that did not match the payment type/status. Paid **cash**
  reservations still showed the "Plată cash" hold panel with a live countdown timer (the
  hold had already been paid, so the timer was unused), and the manage panel showed the
  MAIB online-refund policy + a disabled online-cancel button instead of just the
  office-only note.
- **Fix:** in `js/confirmare.js`, `showContentState` now shows the cash hold panel (and
  starts the countdown) only while `payment_status === 'pending'`; the confirmation
  ("card") box is shown only for card reservations. `renderManagePanel` hides the MAIB
  refund policy and the online-cancel action for cash reservations, leaving only the
  `confirmare.cashOfficeRefund` note. Pending-cash holds and card flows are unchanged.
- **Verification:** `npm test` (the lookup/refund contract suite still asserts the
  `showContentState(...) → renderManagePanel(...)` order and the pending-cash timer
  branch).

### B-19 — Confirmation page large gap between confirmed and manage panels (Low) — Fixed 2026-06-03
- **Description:** on desktop the two-column `.checkout-grid` placed the summary in
  column 1 and the right-hand panels (`success`/`cash` + `manage`) as separate grid
  items in column 2. Because `.cf-manage` was forced to `grid-column: 2`, the manage
  panel landed in grid row 2, whose height was driven by the tall summary — leaving a
  large blank gap below the short confirmed panel.
- **Fix:** wrapped the three right-column panels in a `.cf-panels` container
  (`confirmare.html`) that stacks them with a 28px gap independent of the summary
  height; removed the now-obsolete `.cf-manage { grid-column: 2 }` rule and its
  responsive override (`css/confirmation.css`).
- **Verification:** live preview at 1280px width — the success→manage vertical gap is a
  clean 28px (was ~600px), panels share the same column. `npm test` still passes
  (`data-manage-panel`/`data-managed-cancel-btn` markup preserved).

### B-20 — Booking card showed "De la" on the exact-dates stay total (Low) — Fixed 2026-06-04
- **Description:** with exact check-in/check-out dates selected, each accommodation card
  still rendered the price as `De la 5.000 MDL` ("from 5.000 MDL"), implying an estimate
  even though the quote was the exact stay total.
- **Root cause:** the display logic in `js/booking.js` already switched to the
  `booking.priceForStay` key for the exact-dates branch and `booking.priceFrom` only for
  the no-dates estimate, but the Romanian `booking.priceForStay` string in
  `js/translations.js` still read `De la {price}`. (RU/EN had a `{price} за проживание` /
  `{price} for stay` suffix form, which read awkwardly.)
- **Fix:** changed `booking.priceForStay` to a `Total:`-prefixed form in all three
  languages — RO `Total: {price}`, RU `Итого: {price}`, EN `Total: {price}`.
  `booking.priceFrom` ("De la / От / From") is unchanged and still used only for the
  earliest-availability estimate when no dates are selected.
- **Verification:** static preview — `EcoVilaTranslations` resolves `booking.priceForStay`
  without a "from" prefix in all three languages and `booking.priceFrom` keeps it; no
  console errors.

### B-21 — Finance one-day calendar Apply did nothing (Medium) — Fixed 2026-06-08
- **Description:** in the Finance tab, clicking a single day in the range calendar and
  then pressing `Aplică` did not apply the range. This made the new one-day `Încasări`
  booked-villas detail unreachable from the calendar flow.
- **Root cause:** a single calendar click stored only `state.draftStart`; the Apply
  handler required both `state.draftStart` and `state.draftEnd`, so it returned without
  calling `setRange` or reloading Finance data.
- **Fix:** the Apply handler now treats a missing draft end as the same selected day and
  converts it to the app's exclusive end date (`selected day + 1`) before loading data.
  Multi-day range selection is unchanged. A repo-wide button hook scan found no other
  static buttons with missing JS handlers; reported selector misses were dynamic markup
  wired immediately after rendering.
- **Verification:** RED/GREEN CRM regression simulates `Încasări` mode, selecting
  2026-06-06, pressing `Aplică`, and confirms both Finance metrics and booked-villa rows
  load for `2026-06-06` → `2026-06-07`.

### B-22 — CRM delete used typed `sterge` and reset calendar position (Medium) — Fixed 2026-06-08
- **Description:** dashboard reservation deletion still required staff to type
  `sterge`, and the dashboard reload after deletion scrolled the calendar back to the
  month start/current focus instead of keeping the staff member's horizontal position.
  The visible month/year label also reflected the configured month rather than the month
  currently reached by horizontal scrolling.
- **Fix:** the reservation dialog now uses two Romanian native confirmations
  (`Sigur vrei să ștergi această rezervare?` then
  `Ești absolut sigur că vrei să ștergi această rezervare?`). Paid card/MAIB bookings
  still call the Diana-only `maib-refund` helper before cancelling the booking group.
  The dashboard calendar now renders a rolling previous/current/next month window,
  extends that window when staff scroll near either edge, derives the month/year label
  from the visible scroll position, and restores the scroll offset after reloads such
  as deletion.
- **Verification:** RED/GREEN CRM regressions cover the two confirmation prompts, second
  confirmation cancellation, MAIB refund-before-group-cancel ordering, buffered calendar
  dates, visible-month label calculation, and scroll restoration. Full `npm test`
  passed 200 Node + 41 Deno tests; `deno check`, `deno lint`, static stale-hook grep,
  and a localhost browser auth-gate smoke also passed.

---

## Items checked and NOT bugs

- `site.html` hero `<source src="/assets/videos/ecovila-hero.mp4">` — the file exists;
  not broken.
- `site.html` redirecting to `/` — intentional transition URL after root replacement;
  `index.html` is now the full Romanian canonical homepage.
- `js/pricing.js` / `js/calendar.js` imported by both browser and Node tests — the
  UMD wrapper is by design, not a duplication bug.
- `send-sms` and `send-email` are not called from the public browser; they are
  Diana-only direct staff endpoints and shared provider helpers are used internally by
  notification flows.
