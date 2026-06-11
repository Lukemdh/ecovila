# EcoVila — Pre-Launch Bug Report & Fix Log

Original audit date: 2026-06-10 (finance & pricing flow end-to-end).
Fix pass date: 2026-06-11 — full codebase re-read, every issue below verified, fixed, and
covered by tests. **All Node (205) and Deno (48) tests pass after the fixes.**

Severity legend:
- **CRITICAL** — can cause real money loss / wrong charges; fix before launch.
- **HIGH** — likely to cause customer-visible problems or operational pain.
- **MEDIUM** — latent / edge-case.
- **LOW** — cleanup / robustness.

---

## CRITICAL — fixed

### C1. Reservation price was fully client-controlled — server never recomputed it ✅ FIXED
**Was:** The browser computed the stay price from `pricing_tiers` and wrote it to
`localStorage`; `create-reservation` accepted any non-negative integer `total_price` and
`maib-create-payment` charged exactly that sum. Editing `localStorage` (or calling the
public function directly) let anyone pay 1 MDL for any stay.

**Fix:** New server-side pricing guard.
- `supabase/functions/_shared/pricing.js` — exact copy of `js/pricing.js` (a Node test,
  `tests/pricing-guard.test.mjs`, fails if the two files ever diverge).
- `supabase/functions/_shared/pricingGuard.ts` — `verifyReservationGroupPricing` loads
  rooms / pricing_tiers / holidays from the database, validates the booking group (same
  stay details on every row, distinct active rooms of one type, ≤10 rooms, ≤365 nights),
  recomputes the authoritative total with `calculateStayPrice`, **rejects any mismatched
  client total with HTTP 409**, and normalizes the per-room split server-side.
- `create-reservation/index.ts` runs the guard before inserting rows.
- Deno tests: `supabase/functions/tests/pricingGuard.test.ts` (6 tests: accept, tamper-reject,
  multi-room split, recurring holidays, room validation, group validation).

### C1b (new finding). Direct `anon` INSERT into `reservations` bypassed the Edge Function ✅ FIXED
**Was:** The RLS policy "Public can create guest reservations"
(`20260506210000`, re-created in `20260508123000`) plus `grant insert ... to anon` let any
visitor insert reservations straight through PostgREST with an arbitrary `total_price`,
bypassing all Edge Function validation — this would have nullified the C1 fix.
The website only ever inserts via the `create-reservation` Edge Function (service role),
and the CRM inserts as `authenticated` staff, so nothing legitimate used this path.

**Fix:** Migration `20260611120000_revoke_public_reservation_insert.sql` drops the policy
and revokes the `anon` insert grant. **This migration must be applied to the production
project** (see deploy checklist below).

### C2. MAIB callback marked bookings "paid" without verifying the captured amount ✅ FIXED
**Was:** `maib-callback` flipped reservations to `paid` based only on the status fields;
the captured amount was never reconciled against `maib_payments.amount`.

**Fix:** `_shared/maib.ts` gains `getMaibCallbackAmount` (reads `amount` / `orderAmount` /
`result.amount`). In `maib-callback/index.ts`, a `paid` callback whose amount differs from
the stored payment amount (fallback: sum of reservation totals) is **not confirmed**: the
payment row is recorded as `pending`, an `amount_mismatch` response is returned, and the
mismatch is logged at error level for manual review. If MAIB omits the amount entirely the
booking proceeds (the callback is already HMAC-verified) but a warning is logged.

---

## HIGH — fixed

### H1. Hardcoded test "sold out" blocks were shipping to production ✅ FIXED
**Was:** `TEST_SOLD_OUT_RANGES` in `js/booking.js` merged fake May-2026 availability
blocks into live data, both initially and after every real availability load.

**Fix:** `TEST_SOLD_OUT_RANGES`, `createTestingSoldOutBlocks`, and
`withTestingSoldOutBlocks` are deleted; fetched blocks are used directly
(`state.reservations = normalizeAvailabilityBlocks(blocks)`). The test that previously
*asserted* the scaffolding exists was replaced with one asserting it is **gone**
(`tests/booking-page.test.mjs`).

### H2 (new finding). Booking page missed recurring holidays outside the fetch window ✅ FIXED
**Was:** Holidays are recurring month-day rules (`20260509100000` enforces uniqueness on
month+day and `toHolidayKey` strips the year), but `js/booking.js` fetched holidays with a
`[today, +210d]` date filter on the stored (year-specific) `date` column. Example: a
holiday stored as `2026-01-01` would be invisible to a November-2026 visitor booking New
Year's Eve, so the quote would silently use the weekday rate. After C1, such a wrong quote
would also block checkout with a 409 because the server (which loads *all* holidays)
disagrees.

**Fix:** `js/booking.js` now calls `fetchHolidays(client)` with no range; the server-side
guard does the same. The CRM pages already fetched all holidays. Locked by test.

---

## MEDIUM — fixed

### M1. Silent fallback to hardcoded prices when the Supabase load failed ✅ FIXED
**Was:** An empty/failed `pricing_tiers` load silently substituted hardcoded constants,
which became the quote and the charge; "Missing Supabase config" errors were swallowed
entirely.

**Fix:** In `js/booking.js`, an empty pricing load is now a hard failure; any load failure
clears `state.pricingTiers`, sets the visible `booking.loadError` status, hides the
continue button, and `reserveType` refuses to hand off to checkout while pricing is
missing, still loading, or errored. (The fallback constants remain only as an initial
render skeleton; they can no longer reach checkout.)

### M2. Reusable MAIB payment session could serve a stale amount ✅ FIXED
**Was:** `maib-create-payment` reused any non-expired `created`/`pending` checkout session
without checking its `amount`.

**Fix:** The current total is computed first; a reusable session is returned only when
`existingPayment.amount` equals it, otherwise the stale `maib_payments` row is marked
`cancelled` and a fresh checkout session is created.

---

## LOW — fixed

### L1. Refund amount derives from the stored total — resolved by C1
Refunds repay `maib_payments.amount` (what was actually charged). With C1/C1b fixed the
stored total is now server-authoritative, so this is correct as designed. No code change.

### L4 (new finding). PostgREST filter injection in `maib-refund` payment lookup ✅ FIXED
**Was:** `findPayment` interpolated the caller-supplied `payId` into a PostgREST
`.or('pay_id.eq.…,provider_payment_id.eq.…')` filter string. Staff-only (`diana` role), so
low severity, but a crafted `payId` containing commas/parentheses could alter the filter.

**Fix:** Replaced with two sequential `.eq()` lookups (`pay_id`, then
`provider_payment_id`).

### L5 (new finding). CRM auth cookie lacked the `Secure` flag ✅ FIXED
`admin/js/crm-auth.js` now appends `Secure` to the session cookie except on plain-HTTP
local development hosts. (`SameSite=Lax`, `Path=/admin` were already set; the site also
sends HSTS via `.htaccess`.)

---

## L2/L3 — confirmed-good controls (unchanged, for the launch checklist)
- Pricing math (`js/pricing.js`) is correct and well tested; happy-path charge equals the
  displayed quote. It is now also enforced server-side (C1).
- Double-booking is prevented at the DB level via the GiST exclusion constraint on
  `(room_id, daterange(check_in, check_out))` for active pending/paid rows.
- MAIB callback signature: HMAC-SHA256 over the raw body + timestamp tolerance +
  constant-time compare.
- MAIB amounts use major MDL units consistently on charge and refund.
- Cash holds expire via cron after 30 min; in-flight and unstarted card sessions are
  reclaimed by `expire-cash-reservations`.
- Staff-only actions (`confirm-reservation-payment`, `maib-refund`, `send-email`,
  `send-sms`) require the `diana` staff role; guest cancel/extend require a hashed manage
  token.
- The confirmation page derives paid/pending/cancelled state from the server, not the
  `?payment=success` URL param.
- CRM `innerHTML` templates consistently `escapeHtml()` guest-controlled values, and the
  public API additionally rejects `<`/`>` in guest names — no XSS sink found.
- Anon-exposed RPCs (`get_public_availability_blocks`, cancellation/lookup functions) are
  `security definer` with explicit checks; tokens are stored hashed.

---

## Deploy status (2026-06-11)

1. ✅ **Migration applied to production** via the management API (the local/remote
   migration histories had drifted, so `db push` was avoided — it would have re-run the
   seed upserts and reset live prices). The migration is recorded in
   `supabase_migrations.schema_migrations` as `20260611120000`. Verified in prod: the
   "Public can create guest reservations" policy is gone and `anon` has no INSERT grant
   on `reservations` (direct PostgREST insert returns `42501 permission denied`).
2. ✅ **Edge Functions deployed**: `create-reservation`, `maib-callback`,
   `maib-create-payment`, `maib-refund`. Verified live:
   - tampered `total_price: 1` → HTTP 409 "Reservation total does not match current pricing";
   - correct total (recomputed from prod tiers/holidays) → reservation created
     (test row deleted afterwards);
   - `maib-callback` reachable without JWT and rejects unsigned payloads with 401.
3. ⬜ **Upload the static site to TopHost** — bundle is ready at `dist/tophost`
   (`npm run prepare:tophost` already run). Ships `js/booking.js` (test blocks removed,
   holiday fetch fixed, pricing-failure guard) and `admin/js/crm-auth.js` (Secure cookie).
   Until this is uploaded, quotes for stays adjacent to a recurring holiday whose stored
   date lies outside the old 210-day window will be rejected by the new server guard with
   a 409 (guest sees a "refresh and retry" error — safe, but degraded), so upload soon.
4. ⬜ Run one real card booking end-to-end in the MAIB sandbox and confirm the callback
   marks the booking paid with matching amounts.
5. ⬜ **Rotate the Supabase personal access token** that was shared in chat during this
   deploy (Dashboard → Account → Access Tokens).

**Note on migrations going forward:** remote migration history uses different version IDs
than the local files (changes were applied via the dashboard/MCP). Never run a plain
`supabase db push` against this project until the history is repaired with
`supabase migration repair`; the foundation migration's seed upserts would overwrite live
`pricing_tiers` and reset `rooms.is_active`.

## Maintenance invariants (enforced by tests)
- `supabase/functions/_shared/pricing.js` must stay byte-identical to `js/pricing.js`
  (`tests/pricing-guard.test.mjs` fails otherwise; re-copy on every pricing change).
- Holiday fetches must never be date-range-filtered (recurring month-day semantics).
- No test availability scaffolding may reappear in `js/booking.js`.
