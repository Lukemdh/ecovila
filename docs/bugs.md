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
| B-23 | Reservation price fully client-controlled; server never recomputed it | Critical | Fixed |
| B-24 | RLS allowed direct `anon` INSERT into `reservations` with any price | Critical | Fixed |
| B-25 | MAIB callback marked bookings paid without verifying the captured amount | Critical | Fixed |
| B-26 | Hardcoded May-2026 test "sold out" blocks shipping in `js/booking.js` | High | Fixed |
| B-27 | Booking page date-range-filtered recurring holidays, missing holiday pricing | High | Fixed |
| B-28 | Silent fallback to hardcoded prices when the Supabase pricing load failed | Medium | Fixed |
| B-29 | Reused MAIB checkout session could serve a stale amount | Medium | Fixed |
| B-30 | PostgREST `.or()` filter injection in `maib-refund` payment lookup | Low | Fixed |
| B-31 | CRM auth cookie missing the `Secure` flag | Low | Fixed |
| B-32 | CRM edit dialog showed single-villa price for grouped bookings | Low | Fixed |
| B-33 | Finance `paid_at` binning uses UTC midnight while queries use Europe/Chisinau | Low | Open |
| B-34 | Daily repricing asks reception to collect an already-paid add-guests difference again | Medium | Open |
| B-35 | Saving a paid Daily repricing reports an uncollected supplement as historical income | High | Open |
| B-36 | Finance refund reads silently swallow errors and under-report returned money | Medium | Open |
| B-37 | Difference-link reads sent every visible reservation id in one URL (400 on a busy calendar) | High | Fixed |

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

### B-23 — Reservation price fully client-controlled (Critical) — Fixed 2026-06-11
- **Description:** the browser computed the stay total from `pricing_tiers`, stored it in
  `localStorage`, and `create-reservation` accepted any non-negative integer
  `total_price`; `maib-create-payment` then charged exactly the stored sum. Editing
  `localStorage` (or calling the public function directly) allowed paying 1 MDL for any
  stay and receiving a confirmed, room-blocking reservation.
- **Fix:** server-side pricing guard. `supabase/functions/_shared/pricing.js` is an exact
  copy of `js/pricing.js` (byte-identity enforced by `tests/pricing-guard.test.mjs`);
  `supabase/functions/_shared/pricingGuard.ts` recomputes the authoritative total from DB
  rooms/tiers/holidays inside `create-reservation`, validates the booking group, rejects
  mismatched totals with HTTP 409, and normalizes the per-room split. Deno coverage in
  `supabase/functions/tests/pricingGuard.test.ts`. Deployed to production 2026-06-11 and
  verified live (tampered total → 409; correct total → created).

### B-24 — Direct `anon` INSERT into `reservations` (Critical) — Fixed 2026-06-11
- **Description:** the RLS policy "Public can create guest reservations" plus the `anon`
  INSERT grant let any visitor insert reservations straight through PostgREST with an
  arbitrary `total_price`, bypassing all Edge Function validation (and nullifying B-23's
  fix). Nothing legitimate used this path — the site books via the `create-reservation`
  Edge Function and the CRM inserts as authenticated staff.
- **Fix:** migration `20260611120000_revoke_public_reservation_insert.sql` drops the
  policy and revokes the grant. Applied to production via the management API (see
  ADR-023) and verified: direct anon insert now returns `42501 permission denied`.

### B-25 — MAIB callback never reconciled the captured amount (Critical) — Fixed 2026-06-11
- **Description:** `maib-callback` flipped reservations to `paid` based only on the
  callback status fields; the amount MAIB reported as captured was never compared against
  `maib_payments.amount`.
- **Fix:** `_shared/maib.ts` gained `getMaibCallbackAmount`; a `paid` callback whose
  amount differs from the stored expected amount is recorded as `pending`, answered with
  `amount_mismatch`, and logged at error level instead of confirming the booking. A
  callback with no amount field proceeds (already HMAC-verified) with a logged warning.

### B-26 — Test "sold out" scaffolding shipped to production (High) — Fixed 2026-06-11
- **Description:** `TEST_SOLD_OUT_RANGES` in `js/booking.js` merged fake May-2026
  availability blocks into live data on every load.
- **Fix:** deleted the ranges and helper functions; fetched blocks are used directly. The
  Node test that previously asserted the scaffolding exists now asserts it is gone.

### B-27 — Recurring holidays missed by the booking page (High) — Fixed 2026-06-11
- **Description:** holidays are recurring month-day rules (year stripped by
  `toHolidayKey`; month+day uniqueness enforced by migration `20260509100000`), but
  `js/booking.js` fetched them filtered to `[today, +210d]` on the stored year-specific
  `date` column, so holidays stored under an out-of-window year silently priced as
  weekdays. After B-23's guard this would also have blocked checkout with a 409.
- **Fix:** `js/booking.js` and the server-side guard both fetch all holidays with no
  range; locked by tests. CRM pages already fetched all holidays.

### B-28 — Silent fallback to hardcoded prices (Medium) — Fixed 2026-06-11
- **Description:** an empty/failed `pricing_tiers` load silently substituted hardcoded
  constants which became the quote and (pre-B-23) the charge; missing-config errors were
  swallowed.
- **Fix:** an empty pricing load is a hard failure; any load failure clears
  `state.pricingTiers`, shows `booking.loadError`, hides the continue button, and
  `reserveType` refuses checkout handoff while pricing is missing/loading/errored.

### B-29 — Stale MAIB checkout session reuse (Medium) — Fixed 2026-06-11
- **Description:** `maib-create-payment` reused any non-expired `created`/`pending`
  session without checking that its `amount` still matched the current reservation total.
- **Fix:** the current total is computed first; a session is reused only on exact amount
  match, otherwise the stale `maib_payments` row is cancelled and a new checkout created.

### B-30 — `.or()` filter injection in `maib-refund` (Low) — Fixed 2026-06-11
- **Description:** `findPayment` interpolated the caller-supplied `payId` into a
  PostgREST `.or()` filter string; staff-only surface, but a crafted value could alter
  the filter.
- **Fix:** replaced with two sequential `.eq()` lookups (`pay_id`, then
  `provider_payment_id`).

### B-31 — CRM auth cookie missing `Secure` (Low) — Fixed 2026-06-11
- **Description:** `admin/js/crm-auth.js` wrote the session cookie with `SameSite=Lax`
  and `Path=/admin` but no `Secure` flag.
- **Fix:** `Secure` is appended except on plain-HTTP local development hosts.

### B-32 — CRM edit dialog showed single-villa price for grouped bookings (Low) — Fixed 2026-06-17
- **Description:** for a multi-villa booking group the CRM calendar card summed every villa
  into the group total (e.g. `17.200 MDL`), but clicking it opened the edit dialog which
  rendered only the clicked (primary) reservation's `total_price` (e.g. `8.600 MDL`), so the
  card and dialog disagreed. Other dialog fields (adults, phone, dates) intentionally reflect
  the primary villa and already matched the card — price was the only aggregated value.
- **Fix:** `reservationCard` passes the already-computed block total into
  `openReservation(reservation, { groupTotal: total })`; the dialog renders `options.groupTotal`
  and falls back to `reservation.total_price` when opened outside the calendar grid. Display-only
  (`admin/js/crm-dashboard.js`); ships with the next TopHost upload.

### B-33 — Finance `paid_at` binning uses UTC midnight while queries use Europe/Chisinau (Low) — Open
- **Description:** `admin/js/crm-finance.js` bins `paid_at` timestamps using UTC midnight
  (`isPaidAtInRange`), while the `created_at` and `cancelled_at` Finance queries in `js/supabase.js`
  (`fetchFinanceReservations`, `fetchFinanceBookedReservations`, `fetchFinancePaymentLinks`) filter
  using Europe/Chisinau local day boundaries.
- **Context / ADR-106 decision:** Standalone payment links (ADR-106) deliberately reused the
  existing `isPaidAtInRange` UTC helper so payment links and reservations bin identically rather than
  diverging inside one report.
- **Why it matters:** Payments recognized near midnight (within the 2–3 hour offset window between UTC
  and Europe/Chisinau) may bin into an adjacent day compared to their local date.
- **Fix direction / owner decision needed:** Correcting this binning to Europe/Chisinau local midnight
  is a separate change because it would retroactively shift historical daily Finance figures across all
  past reports, so it requires explicit owner decision and approval.

### B-34 — Daily repricing double-charges paid add-guests differences (Medium) — Open
- **Description / evidence:** ADR-057 deliberately leaves `reservations.total_price`
  at the original booking base when an add-guests `reservation_changes` row settles;
  `applyBookingChange` updates only `adults` and `kids_ages`. In
  `admin/js/crm-daily.js`, `calculateDailySupplement` reprices that now-larger party but
  subtracts the unchanged base total and reads only ADR-107 accommodation-difference
  links. It therefore presents the already-paid add-guests difference as money still to
  collect.
- **Reproduce:** create and pay a 3,000 MDL booking; use the guest add-people flow and
  pay a 500 MDL difference; open that booking in `Situația zilnică` without changing
  the party. The current-party quote is 3,500 MDL, the stored base remains 3,000 MDL,
  and reception sees `De încasat suplimentar: 500 MDL` although MAIB already captured
  that 500 MDL in the separate change payment.
- **Why ADR-107 did not fix it:** ADR-107 makes accommodation-difference reads honest
  and blocks writes for bookings carrying those links. Folding the separate
  `reservation_changes` ledger into Daily and defining how that older flow should be
  repriced/refunded is a distinct accounting change.

### B-35 — Paid Daily repricing turns an uncollected supplement into historical income (High) — Open
- **Description / evidence:** `saveDailyGuestEdit` directly and sequentially overwrites
  each live row's `total_price` after a confirmation prompt; it does not collect money,
  create a payment/change ledger row, or update `paid_at`. Finance `Încasări` reads the
  current `total_price` of paid rows and bins it by the unchanged original `paid_at`.
  The newly quoted supplement therefore appears as collected revenue on an earlier
  payment date even when reception never received it.
- **Reproduce:** pay a 3,000 MDL reservation on 1 August; in `Situația zilnică`, add a
  guest or extension that reprices the stay to 3,500 MDL and accept the save prompt,
  without recording any separate collection. Open Finance `Încasări` for 1 August:
  the booking now contributes 3,500 MDL on its original `paid_at`, overstating income by
  the uncollected 500 MDL.
- **Fix direction:** Daily repricing needs an explicit collection/ledger operation (and
  an atomic group write), not another direct rewrite of a paid booking base. ADR-107
  deliberately refused repricing for bookings carrying accommodation differences and
  left this broader redesign out of scope.

### B-36 — Finance refund reads silently swallow errors and under-report returned money (Medium) — Open
- **Description / evidence:** In `admin/js/crm-finance.js`, `fetchScheduledRefundsSafe` (~1351),
  the refunded-booking-group truth read `fetchRefundedGroupsSafe` (~1362), and the refunded add-guests read
  `fetchRefundedChangesByGroupSafe` (~1376) each swallow database/network/RLS errors via `.catch(() => [])` or
  `.catch(() => new Map())` and return empty sets.
- **Why it matters / reproduction:** A failed or RLS-denied read silently under-reports returned money and can make
  a cancellation vanish from the cancellation list:
  1. If `fetchRefundedGroupsSafe` fails or is denied by RLS, `state.refundedGroupIds` becomes empty;
     `summarizeCancellationRows` filters out cancellations that have no refunded group truth, making those cancellations
     silently vanish from the Finance cancellations list and dropping `refundedTotal` to 0.
  2. If `fetchRefundedChangesByGroupSafe` fails, `state.refundedChangesByGroup` is empty, so refunded add-guests
     differences are omitted from the cancellation quote and the calculation silently falls back to the base stay total.
  3. If `fetchScheduledRefundsSafe` fails, the scheduled refunds list simply renders empty without alerting staff.
- **Context & contrast with ADR-107:** This is a pre-existing fail-open pattern in legacy Finance reads (not introduced
  by ADR-107 and deliberately not fixed here). By contrast, ADR-107's new bound-link read (`fetchRefundedBoundLinksSafe`
  in `crm-finance.js` ~1409, invoked in `loadFinance` ~1500) deliberately does **NOT** swallow errors: it surfaces the failure,
  alerts staff via `context.setAlert`, sets `state.refundedBoundLinksError`, displays `(neverificat)` in the UI, and rethrows.


### B-38 — Opening a past reservation from sidebar search wiped guest counts, child ages and notes (High) — Fixed 2026-08-31

**Symptom.** Search a guest by name or phone, click a past result, press `Salvează modificări` —
the reservation loses its party size, its child ages and Diana's note.

**Cause.** `searchReservations` (`js/supabase.js`) selected only
`id, room_id, guest_first_name, guest_last_name, guest_phone, check_in, check_out, payment_status,
rooms(number, type)`. `openReservation` (`admin/js/crm-dashboard.js`) then populated the dialog from
that partial row, so `adults` rendered as 0, kids as empty and notes as empty. The save path passes
those form values straight into `rescheduleReservation`, and the server accepts all three
(`reservation-reschedule/index.ts` validates `adults >= 0` and maps an empty note to `null`).
`booking_group_id` and `payment_type` were missing too, so the money, partial-cancel and move
sections were computed from an empty group.

**Fix (ADR-111).** `searchReservations` now selects the full admin column set, and
`openReservation` hydrates the entire booking group via `fetchReservationGroupById` before opening
whenever the row is not already in `activeState.reservations`. A wider SELECT alone is insufficient:
group membership and totals are derived from the loaded calendar window, which never holds
out-of-window history. A contract test asserts the select string keeps `booking_group_id` and
`adults`.

---

### B-40 — Backfill treated undelivered review events as sent, and missed complainers outside the window (High) — Fixed 2026-08-31

Found by the post-deploy QA pass, before the 108 remaining emails ran.

1. `fetchAlreadySentEmails` selected every `review_request` notification event regardless of
   `delivery_status`. The live flow uses `dispatchScheduledNotificationOnce`, which legitimately
   leaves `reserved` and `failed` rows, so any such row would have added that guest's address to
   `alreadySentEmails` and **silently dropped them from every future run** — a guest who received
   nothing, retired forever. This is the same defect class already fixed in the guest-flag
   sweeper's six-hour cooldown. Now filtered to `delivery_status = 'sent'`.
2. Complainer exclusion was derived only from bookings inside the 30-day window, so a complaint
   filed on an **older** stay was invisible whenever the newer booking carried a different or
   missing phone — and that guest would have been invited to leave a public Google review. Now
   resolved to email addresses across the guest's whole booking history.
3. Several PostgREST reads had no explicit row bound. Truncation is silent, and a short
   reservations read skips guests while a short complaints read can email a complainer. Each read
   now requests a ceiling and throws rather than proceeding on a partial answer.

Regression tests added for (1) and (2). Re-deployed and re-verified: the dry run still reports 108,
so the hardening excluded nobody incorrectly.

---

### B-41 — Dossier severity pills signalled their state by colour alone (Medium) — Fixed 2026-08-31

Measured in a browser: checked and unchecked pills differed only in background, border and text
colour — identical `font-weight`, no glyph, no border-width change (WCAG 2.1 SC 1.4.1). Choosing
the wrong severity is consequential: `attention` paints the calendar and triggers staff email. The
checked pill now also carries a ✓ and `font-weight: 800`; because the three pills sit in a
fixed-width grid this costs no reflow (measured: 159px in every state). Their focus outline
measured **1.27:1** against the panel, under the 3:1 required by SC 1.4.11, and is now a solid moss
outline at **5.35:1**.

---

### B-39 — ADR-082 review-request emails have never sent: `review_request` is missing from the `notification_events` CHECK (High) — Fixed 2026-08-31

**Confirmed against production, not inferred.**

- The live `notification_events_event_type_check` allows exactly eight values and does NOT include
  `review_request`. The repo's latest copy
  (`supabase/migrations/20260619170000_complaints.sql`) is identical, so this was never drift — the
  constraint shipped without the value the feature needs.
- `notification_events` holds **0** `review_request` rows. For comparison: `arrival_24h` 742,
  `checkin_welcome` 706, `payment_confirmation` 567.
- The `ecovila-review-requests` cron job is active and has run **8,160 times, every one
  "succeeded"** (that is the `net.http_post` succeeding). `send-review-requests` wraps each guest in
  a `try/catch` that logs to `console.error` and pushes `{ sent: false, error }`, so the CHECK
  violation is swallowed per guest and the function still answers HTTP 200. Nothing anywhere
  surfaced the failure.
- Between 2026-06-24 and 2026-08-30, **552 booking groups** were eligible (paid, not cancelled, an
  email on file, no checkout note in situația zilnică). None received the invitation.

**Why it hid for ten weeks.** Three layers each did something individually reasonable: the constraint
rejected the insert, the function caught the error per guest so one bad row could not abort a batch,
and the cron reported success because the HTTP call worked. There was no signal above `console.error`.

**Fix (shipped with ADR-111).** `20260831120000_guest_notes.sql` recreates the constraint with the
complete allowlist plus `review_request` and `guest_flag_alert`. Review requests resume from the next
evening's checkouts; the function only ever targets yesterday's checkout date, so the 552 past guests
are not retroactively mailed. Owner asked for a catch-up proposal to be worked out separately before
anything is sent to them.

**Lesson recorded in `docs/conventions.md`:** read the LIVE definition before recreating an
enumerated CHECK, and do not let a cron's HTTP success stand in for its business outcome.

---

### B-37 — Difference-link reads sent every visible reservation id in one URL (High) — Fixed 2026-08-27

**Symptom (reported from live prod).** Every card on the CRM calendar rendered a
`Total neverificat` badge.

**Cause.** `fetchReservationDifferenceLinks` put every reservation id of the visible window into a
single PostgREST `in.(...)` filter, which travels in the URL. A three-month window holds hundreds of
reservations; measured against prod, 600 ids (~22KB) returned 200 but **900 ids (~33KB) returned
400**. The read therefore threw on a busy calendar, `differenceLinksError` was set, and the ADR-107
fail-closed display stamped every card.

**Fix.** Both bound-link reads (`fetchReservationDifferenceLinks` and
`fetchRefundedBoundLinkAmounts`) chunk their ids at 200 per request and merge, so no single request
can outgrow the URL limit. Guarded by a regression test that feeds 950 ids and asserts several
requests, full coverage, and a bounded batch size.

**Also corrected here (UI).** The fail-closed state was being expressed as a badge on every calendar
card, a label on every daily card, and a relabelled total in two dialogs — noise that made the whole
calendar unreadable. Display now shows the booking price plainly; the guarantee stays where it
changes an outcome: the daily repricing save is still refused outright, the cancel and partial-cancel
preflights still warn, and the move dialog still states that differences could not be verified.

---

### B-42 — A guest who lost their villa mid-checkout was told to "check your details and try again" (High) — Fixed 2026-09-03

**Confirmed against production, not inferred.**

Roughly one guest in five could not reach the payment page. `js/booking.js` takes a single
availability snapshot at page load (`loadBookingData()`, line 1438 — no polling, no refetch on
focus) and `js/checkout.js` never re-checked it. When the villa was taken while the guest filled in
the form, the insert hit `23P01 reservations_no_room_overlap`, `_shared/reservations.ts:207`
rethrew it as a plain `Error`, and `errorResponse` turned that into a 500 that checkout rendered as
`checkout.errorCreate`.

**Why it kept guests stuck rather than merely failing them.** The message says *"Verifică datele și
încearcă din nou"* — check your details and try again. The details were fine and retrying could
never work, because the villa was genuinely gone. Edge logs show runs of 5-7 consecutive 500s from
one device inside a few minutes, then a 429 as the guest hit the rate limiter. Counting devices,
not requests: 5 failing sessions against ~10 successful on 09-03, 1 against ~11 on 09-02.

**One instance reconstructed completely.** 2026-09-02 10:36 UTC — a staff hold took room 25 (hotel)
for 13-14 Sep. 10:49 — a guest began seven consecutive 500s, rate-limited at 10:54. Occupancy for
that night at that moment: small 8/8, large 7/7, hotel 9/10. The hold had taken the last room on
the property; the guest's page, loaded before 10:36, still showed it free.

**Why it hid.** `errorResponse` never logged. The only trace was a 500 in edge logs with ~7-day
retention, and the DB held nothing at all — the insert is what failed, so there was no row to find.
Verified: across 89 guest card bookings in 7 days, zero were missing a payment row or a cancellation
token, which is what ruled out every partial-write theory.

**Ruled out along the way,** each with evidence rather than argument: the ADR-084 foreign-phone
block (measured at ~6% of bookings and dropping to exactly zero non-`+373` bookings after June —
working as designed); a stale TopHost upload (live JS and HTML byte-identical to the repo); the
pricing guard (answers 409 and logs; zero of either); rate limiting (always arrives *after* a run of
500s, never before); and old browsers (every failing user agent was Chrome 152, iOS 26 or
CriOS 151/152).

**Fix (ADR-113).** 23P01 now maps to a 409 carrying which villas of that type are still free; the
checkout page shows a truthful message and a button back to the booking page with the dates
preserved, and disables submit so the retry spiral cannot start. An explicit villa pick is never
silently substituted — that was an explicit owner decision. Failures are logged with their SQLSTATE
and counted in the CRM.

**Lesson, and it is the same one as B-39:** an error path that is never logged is a bug that can run
for months. `errorResponse` mapping every untyped error to a silent 500 was the mechanism both
times.

---

### B-43 — Auto room assignment read a truncated calendar and handed guests an occupied villa (High) — Fixed 2026-09-04

**Found by the telemetry shipped hours earlier in ADR-113, against production.**

`loadActiveReservations` in `supabase/functions/_shared/roomAssignment.ts` was unpaginated and had no
`ORDER BY`, so PostgREST capped it at 1000 rows and the rows it dropped varied per call.
`assignAutomaticRooms` calls it with the stay window padded by `±FREE_WINDOW_CAP_DAYS` — about four
months. Measured in production for a 26-27 Sep 2026 stay: **1007 rows matched, 7 were silently
dropped.**

Auto-assignment therefore saw an incomplete calendar, judged an occupied villa free, and assigned it.
The ADR-113 preflight, which reads only the narrow stay window and so is complete, then correctly
refused the booking. A guest who had NOT picked a specific villa could not recover by retrying,
because going back ran the same broken assignment again.

**Live impact.** Four guests hit it on 2026-09-04 between 05:51 and 06:35 UTC, all wanting a hotel
room for 26-27 Sep — logged in `booking_failures` with `sqlstate = null`, i.e. refused by the
preflight rather than by the database constraint. Rooms 23 and 24 were free for that night the whole
time.

**This is older than ADR-113 and was not caused by it.** Before that change the same guests hit
`23P01` at the insert and received the opaque 500 of B-42; they were already failing, invisibly. The
threshold was only crossed recently — the window sat under 1000 rows until this season.

**Also fixed here:** `loadActiveReservationsWindow` in `reservation-reschedule/index.ts` carried an
identical unpaginated ±61-day query, so a staff reschedule could be planned against the same
truncated view. It now delegates to the shared paginated reader.

**Fix.** Both reads page with `.range()` until a short page arrives, rebuilding a fresh builder per
page, ordered by `id` so offset paging cannot skip or repeat a row. A regression test puts the
blocking reservation on the SECOND page and asserts auto-assignment does not pick the occupied room.
Every other shared read was audited and documented as bounded (scoped to a booking group, a pay id,
or an explicit limit).

**Lesson.** This is the fourth appearance of the same 1000-row truncation class — B-37, ADR-092, the
guest availability read in ADR-113, and now this. The pattern is always an unpaginated PostgREST read
over a date window that grows with the business. Fixing the instance in front of you is not enough:
grep for siblings.
