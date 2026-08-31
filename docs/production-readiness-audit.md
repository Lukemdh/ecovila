# Production Readiness Audit — 2026-06-01

Scope: repository-wide source, docs, migrations, Edge Functions, static pages, tests,
security-sensitive flows, unused assets, and deployment assumptions. Step 16 later
updated application code to close the legacy UUID-only confirmation-actions blocker.
The 2026-06-03 SEO/AEO + tracking pass replaced the root maintenance page with the full
Romanian homepage, added `/ru/` and `/en/`, and added consent-gated server-side
conversion tracking.

## 2026-06-11 addendum — payment-flow Critical fixes deployed

A dedicated pre-launch payment-flow audit (full log in the root `bugs.md`) found three
**Critical** issues missed by earlier scans, all fixed and **deployed to the production
Supabase project the same day**:

- **B-23 / S-13** — reservation `total_price` was fully client-controlled; the server
  charged whatever the browser sent. Fixed with server-side price recomputation in
  `create-reservation` (`_shared/pricingGuard.ts`; mismatches → HTTP 409).
- **B-24 / S-14** — RLS allowed direct `anon` INSERT into `reservations`, bypassing the
  Edge Function. Fixed by `20260611120000_revoke_public_reservation_insert.sql`.
- **B-25 / S-15** — the MAIB callback marked bookings paid without reconciling the
  captured amount. Fixed; mismatched amounts stay pending and are logged for review.

Also fixed: B-26 (test sold-out scaffolding in `booking.js`), B-27 (recurring holidays
date-range-filtered out of quotes), B-28 (silent hardcoded-price fallback), B-29 (stale
MAIB session amount reuse), B-30 (`.or()` filter injection in `maib-refund`), B-31
(missing `Secure` on the CRM auth cookie).

Live verification: tampered total → 409; direct anon insert → `42501`; correct total →
booking created (test row removed); `maib-callback` reachable without JWT and rejecting
unsigned payloads. `npm test` → **205 Node + 48 Deno tests pass** (as of 2026-06-11). Outstanding launch
items: upload `dist/tophost/` to TopHost, run a MAIB sandbox payment end-to-end, rotate
the access token used for the deploy, and resolve/accept S-12, S-9/S-10, B-10/B-11/
B-12/B-13. ⚠️ Migration histories are drifted — never plain `supabase db push`
(ADR-023).

## 2026-08-27 addendum — standalone payment links (ADR-106)

Implemented standalone single-use payment links in the CRM and guest page `plata.html`:
- Security & RLS posture: `payment_links` and `payment_link_attempts` tables enforce Diana-only
  SELECT RLS (`ecovila_app_role() = 'diana'`), no client insert/update/delete policies; all
  mutations are executed by service-role Edge Functions. All 4 RPCs (`claim_payment_link_attempt`,
  `settle_payment_link_attempt`, `revoke_payment_link`, `mark_payment_link_refunded`) are
  `SECURITY INVOKER`, have `SET search_path = ''`, fully qualified references, and are granted
  exclusively to `service_role`.
- Access control: `payment-link-admin` verifies bearer token through Supabase Auth and enforces
  `requireStaffRole(['diana'])`; Angela is refused server-side. Per ADR-103, staff endpoints have
  no IP rate limit; `payment-link-public` is rate limited per IP and per link.
- Capability model: plain UUID bearer ID in `plata.html?p=<uuid>` (122 unguessable bits, no secrets
  subject to rotation, no PII or staff data exposed in public responses).
- Deployment status: **LIVE in production since 2026-08-27** — migrations applied, all 30 Edge
  Functions redeployed, TopHost upload content-verified on the live host. No payment link has been
  paid and no cross-type move billed with real money yet. (Historic note: migration
  `20260826120000_payment_links.sql`
  and functions `payment-link-admin`, `payment-link-public` pending deploy; static files pending upload).
- Test verification: `npm test` → **412 Node + 186 Deno tests pass**.

## 2026-08-27 addendum — accommodation moves + bound differences (ADR-107)

Implemented and adversarially reviewed, but **not deployed**:

- Diana-only cross-type moves: single-villa drag and an exact-villa/free-target picker
  for multi-villa bookings. Optional integer-MDL difference billing reuses ADR-106;
  lazy provider minting makes link creation a database insert, so the room move and
  link commit in one transaction. SMS is per move, off by default, and best-effort after
  commit.
- `reservations.total_price` stays the original base. Paid net bound links form the
  staff-visible effective total and Finance income by their own `paid_at`; guest totals
  stay base. Daily quotes use the effective total and refuse any repricing write once a
  booking carries a bound link or the link read is unverified. Concurrency is enforced at
  the database level: the `prevent_repricing_with_accommodation_difference` DB trigger
  rejects any UPDATE altering `reservations.total_price` while an accommodation difference
  exists, making the DB the authoritative enforcement point.
- Cancellation posture: a database trigger revokes open bound links inside every
  cancellation transaction. Paid/unrefunded balances are not included in
  `prepare_full_refund_intent`; the CRM full/partial preflights, localized guest copy,
  and staff alerts state that staff must refund those link payments manually in MAIB.
  Money calculations strictly use verified `paid_amount` (missing/invalid `paid_amount`
  fails closed as UNVERIFIED with pessimistic copy + alert, never falling back to requested
  `amount`). Bound-link refunds are fetched strictly by cancelled `reservation_id` so
  legacy ungrouped bookings are not dropped.
- ADR-106 hardening found here: `mark_payment_link_refunded` is monotonic, preventing a
  stale CRM session from lowering the recorded cumulative refund, and `payment_links`
  is added idempotently to `supabase_realtime` so the existing CRM subscriptions work.
- Move & change concurrency hardening: `move_reservation_accommodation` locks prior links
  and refuses replacement billing if a provider attempt is live (`creating`/`pending`/captured);
  `insertChangeRow` optimistically re-reads room types before inserting pending add-guests changes.
- Review hardening: difference reads no longer fail silently into plausible base-only
  money figures, cross-booking links cannot enter a Daily quote, partial refunds keep
  their outstanding warning, move dialog indicates unverified effective price on fetch
  failure, and copied move-payment URLs come from `ECOVILA_SITE_URL`, not the browser origin.
- Verification: `npm test` → **426 Node + 202 Deno tests pass**; `deno lint` and
  `deno fmt --check` pass; asset token is `?v=2026082702`; `dist/tophost/` is regenerated.
- Rollout remains blocked on order: `20260826120000_payment_links.sql` first, then
  `20260827120000_payment_link_reservation_binding.sql`, then the seven affected
  functions, then TopHost. Do not set `ECOVILA_REFUND_COMMISSION_BPS`.

## 2026-08-31 addendum — ADR-111 guest dossier + B-38/B-39, QA pass

Reviewed by three passes: a Gemini frontend verification (measurement-based), a focused Codex
review of the four live email-sending modules, and my own live-production probing. The whole of
this work was already deployed when the QA ran, so findings were fixed against production.

**Verified against production, as the real roles.** The earlier deploy probe ran as `postgres`,
which BYPASSES RLS and therefore proved nothing about the policies. Re-probed with
`set local role authenticated` plus real staff JWT claims, everything inside a rolled-back block:
- Angela inserting a note while claiming `created_by_role='diana'` and Diana's uuid → **stored as
  `angela` with her own uuid**. Authorship cannot be forged.
- Angela archiving → **0 rows**. This is the subtle one: RLS denies an UPDATE with no policy by
  matching zero rows, not by raising, so an exception-based probe would have wrongly reported
  success.
- Diana archiving → 1 row, `archived_by` overwritten with her real uuid (she supplied a different
  one). Diana editing a body → **42501**. `anon` selecting → denied.
- `DELETE` is held only by `postgres`, never by `service_role` or `authenticated`.

**Verified about the 36 emails actually sent:** 37 `review_request` events, **37 distinct people,
0 duplicates, 0 complainers, 0 missing addresses**. The 37th is the LIVE flow firing at 18:30
Chișinău — B-39's fix confirmed end to end, not merely by constraint inspection. A follow-up dry
run returned 108 with the newest checkout moved from 30 → 24 August, proving the sent cohort is
excluded.

**Defects found and fixed in this pass:**
1. *(Codex, High)* The backfill treated ANY `review_request` event as delivered. A `reserved` or
   `failed` row would have silently retired a guest who received nothing — the exact mirror of the
   cooldown bug already fixed in the flag sweeper. Now filtered to `delivery_status = 'sent'`.
2. *(Codex, High)* Complainers were resolved only from bookings inside the 30-day window, so a
   complaint filed on an older stay was invisible when the newer booking carried a different or
   missing phone. Now resolved to email across the guest's whole history.
3. *(Codex, High)* Unpaginated PostgREST reads truncate silently; a short reservation set skips
   guests and a short complaints set can email a complainer. Both now request a ceiling and **fail
   loudly** rather than proceeding on a partial answer.
4. *(Gemini, High)* The dossier severity pills signalled their checked state by colour alone
   (WCAG 1.4.1) — and choosing the wrong severity has consequences. Now also a ✓ glyph and
   `font-weight: 800`, measured to cause no reflow (pills stay 159px).
5. *(Gemini, Medium)* Their focus outline measured **1.27:1**, under the 3:1 of WCAG 1.4.11. Now a
   solid moss outline at **5.35:1**.
6. *(mine)* `_preview/` was committed by an over-broad `git add -A`. Removed and gitignored; it
   could never have shipped, because `prepare-tophost-upload.mjs` copies from an explicit allowlist.

**Found and deliberately NOT changed, with reasons:**
- *Send-then-record leaves a duplicate window* in both senders. This is the accepted at-least-once
  design: recording first would silently retire a guest who received nothing, which is worse. Same
  guarantee as every other notification here.
- *Concurrent `mode=send` runs could double-send.* The only caller is a once-daily cron and three
  runs remain; adding locking machinery to disposable code is not worth it.
- *Dedup reads the reservation's current, mutable email.* Editing a guest's address after a send
  could cost one duplicate. Accepted.
- *Staggered checkout dates could split a booking group before assembly.* Checked empirically:
  **0 of 285** groups in the window have mixed checkout dates. Latent, not live.
- *A guest with >100 historical rows could have a previous-stay group truncated* in the staff
  alert's party totals. Cosmetic, and the busiest real guest is nowhere near it; fixing means
  redeploying every function for a shared-module change.

**Regression audits.** `openReservation` became `async`: its return value is unused at all four
call sites. The Angela read-only lock changed from a blanket `input, textarea` to an explicit list;
every one of the 16 dialog controls was enumerated — 7 locked, 4 dossier controls intentionally
enabled for her, 4 inside sections already `hidden` for her, 1 with its own disable. Nothing became
newly reachable.

**Clean:** `npm test` 440 Node + 220 Deno; `deno lint` 31 files; `deno fmt --check`; no
`console.*`/`debugger`/`TODO` in the new browser code; one asset token (`?v=2026083101`) across all
19 shipped pages; `dist/tophost` regenerated with no drift; cron health 228/228 and 8,280/8,280
succeeded.

**Not yet exercised:** the guest-flag alert has never fired with a real flagged guest, because
`guest_notes` is empty until the frontend upload lands. The sweeper returns `{"scanned":0,...}` and
is a genuine no-op until then.

---

## Readiness verdict

**Not production-ready yet.** The automated suites are green, and Steps 15-16 fixed the
open High blockers, but Medium production blockers still need to be fixed or explicitly
accepted before public launch:

| Area | Verdict | Evidence |
|------|---------|----------|
| Test suite | Green | `npm test` -> 426 Node + 202 Deno tests pass on 2026-08-27 |
| Payment integrity | Green locally | B-23/B-24/B-25 deployed; ADR-106/107 payment links tested locally but still undeployed |
| Deno lint/type/format | Green | `deno lint`, `deno check`, `deno fmt --check` pass |
| Static local references | Green | Root, `/ru/`, `/en/`, booking, CRM, legal, and required assets are covered by tests |
| Local static serving | Green | `index.html`, `site.html`, `rezervari.html`, `admin/`, hero MP4 return HTTP 200 locally |
| Secret scan | Mostly clean | Regex scan found only the intended public Supabase anon JWT |
| Security hardening | Blocked | S-9 and S-10 remain open |
| Deployment migrations | Blocked | B-11: Maib cron migration assumes `pg_cron`/`cron` exists |
| CRM daily operations | Green | B-14 fixed: daily lists show only paid, non-cancelled reservations |
| ADR-107 Daily repricing | Guarded / follow-up bugs open | Bound-link bookings cannot be repriced; B-34/B-35 document the older add-guests/uncollected-income defects |
| CRM deletion/calendar operations | Green | B-22 fixed: double confirmation, MAIB refund-before-cancel coverage, and scroll-preserving rolling calendar |
| Production content/assets | Partly ready | Root homepage is now live content; placeholder SVG photos remain fallback public imagery |
| Privacy/compliance | Blocked | S-12: SMS provider URL-query PII remains open and out of scope for SEO/tracking work |
| Dependency audit | Incomplete | `npm audit` cannot run without a lockfile; Deno dependency is slightly behind latest |

## Commands run

```sh
npm test
# 188 Node tests + 38 Deno tests passed after the 2026-06-03 SEO/tracking pass

cd supabase/functions && deno lint
# Checked 31 files after the 2026-06-03 SEO/tracking pass

cd supabase/functions && deno check $(find . -name '*.ts' -not -path './tests/*')
# exit 0

cd supabase/functions && deno fmt --check
# Checked 30 files after Step 16

cd supabase/functions && deno outdated
# npm:@supabase/supabase-js current 2.105.3, latest 2.106.2

npm audit --omit=dev --audit-level=moderate
# failed with ENOLOCK because the repo intentionally has no npm lockfile
```

2026-06-08 off-plan admin delete/calendar scan:

```sh
node --test tests/admin-crm.test.mjs
# 52 CRM tests passed

npm test
# 200 Node tests + 41 Deno tests passed

cd supabase/functions && deno check $(find . -name '*.ts' -not -path './tests/*')
# exit 0

cd supabase/functions && deno lint
# Checked 33 files

rg -n "data-delete-confirm|Tastează sterge|tastează sterge|confirm\s*!=\s*'sterge'|sterge pentru" admin tests js css
# no stale app hooks; only the negative regression assertion references data-delete-confirm
```

Browser smoke: served the static repo on `localhost:8080`; opening
`/admin/dashboard.html` redirected to `/admin/index.html` and showed the CRM login,
confirming the protected admin route still gates unauthenticated local access.

Additional manual/static checks:

- Local HTML reference checker: all local links/assets in 10 HTML files exist.
- Local static server HEAD checks: `index.html`, `site.html`, `rezervari.html`,
  `admin/`, and `assets/videos/ecovila-hero.mp4` returned HTTP 200.
- Secret-pattern scan: no service-role/API-key pattern found outside expected code/env
  names; the committed anon JWT in `js/supabase-config.js` is intentional.
- Supabase docs/changelog spot-check: current docs still warn that exposed-schema RLS
  tables require RLS, views bypass RLS unless `security_invoker`, and
  security-definer functions should not be created in exposed schemas.
- 2026-06-03 focused tracking scan: browser assets contain no Meta CAPI / Google Ads /
  service-role secrets; new tracking code does not place raw phone/email/message values
  into URLs.

## Production blocker tracking

### 1. Legacy confirmation RPCs were UUID-only — fixed 2026-06-01

Formerly, `confirmare.html?id=<reservation_id>` used
`get_pending_reservation_status`, `extend_cash_reservation`, and
`cancel_pending_reservation` through `js/supabase.js`. The SQL functions were granted to
`anon`/`authenticated` and authorized only by reservation UUID. UUID guessing was
unlikely, but any leaked confirmation URL could extend or cancel a pending reservation
without the newer manage token.

Status: fixed in Step 16. `create-reservation` now creates a hashed manage token,
confirmation links require `id` + `manage`, status/extension/cancellation use
token-backed Edge Functions, and
`20260601173901_require_manage_token_confirmation_actions.sql` drops the legacy RPC
signatures.

### 2. CRM renders guest-controlled fields through `innerHTML` — fixed 2026-06-01

Formerly, the CRM calendar, dashboard, sidebar search, and daily reception cards
interpolated reservation names/phones/labels into template strings. Guest names were not
normalized or escaped server-side, so a public booking could persist markup that
executed when staff viewed the CRM.

Status: fixed in Step 15. `EcoVilaCrmCalendar.escapeHtml` now guards the affected CRM
template renderers, public guest names with `<` or `>` are rejected server-side, and
Node/Deno regression tests cover the malicious payload.

### 3. Public security-definer RPCs remain in `public`

Several anonymous RPCs are `security definer` functions in the exposed `public` schema.
Some are intentionally narrow, but this is still a Supabase security footgun and should
be revisited before launch. Prefer private-schema functions exposed through reviewed
wrappers or Edge Functions, and keep explicit `search_path` settings.

Track as: S-9. Next step: audit each RPC, move privileged helpers out of `public`, and
keep only the minimal public execution surface.

### 4. Cancellation tokens are stored plaintext

`reservation_manage_tokens` and lookup codes are hashed, but legacy
`cancellation_tokens.token` stores the bearer token plaintext and `anulare.html` uses it
directly. A database read leak would expose active cancellation links.

Track as: S-10. Next step: migrate cancellation-token lookup to a hash column and return
plaintext only at creation time.

### 5. Maib cron migration assumes `pg_cron`

`20260526193653_maib_session_expiry_cron.sql` and
`20260527082000_maib_unstarted_payment_cleanup.sql` call `cron.schedule`, but no
migration creates/enables `pg_cron`. If the target Supabase project lacks that
extension, `supabase db push` can fail.

Track as: B-11. Next step: add an extension migration or move this cleanup to a
scheduled Edge Function with documented setup.

### 6. Server accepts impossible child ages

The public UI and pricing contract allow child ages 1-17, but
`normalizeKidsAges` accepts 0 and 18. A direct Edge Function caller can create rows that
do not match the public booking contract.

Track as: B-10. Next step: tighten server-side validation to 1-17 and add Deno coverage.

### 7. Daily reception includes non-confirmed reservations — fixed 2026-06-02

`admin/js/crm-daily.js` formerly built the `Situația zilnică` check-in/check-out lists
from all reservation rows returned by `fetchAdminReservations` for the selected date
window. Because the daily view applied only date and search filters, pending holds and
cancelled rows could appear in the reception workflow. Confirmed means
`payment_status = 'paid'` with `cancelled_at is null` **(inferred)**; the database has
no literal `confirmed` status.

Status: fixed in the B-14 off-plan fix. Daily check-in/check-out derivation now filters
to paid, non-cancelled rows before fetching daily status records or rendering cards,
without globally tightening the shared staff reservation fetcher.

### 8. SMS provider URL-query PII remains open

The SMS.md provider call passes phone/message/token in a request URL query string. This
violates the no-PII-in-URLs constraint and Legea 195/2024. The owner explicitly kept it
out of scope for the SEO/tracking work, so it is tracked as S-12 and standalone Step 20.

Next step: confirm whether SMS.md supports POST request bodies. If yes, move the
payload out of the URL; if no, ensure the full provider URL is never written to logs.

## Lower-priority production risks

- Floating Supabase JS version: browser pages load
  `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`, while Deno resolves
  `npm:@supabase/supabase-js@2` to the lockfile version. Pin/review before launch.
- `npm audit` is not available because the repo intentionally has no npm lockfile.
  Decide whether to keep this accepted or introduce a docs-only/security-scanning path.
- Public fallback imagery is still placeholder SVG art unless CRM photos have been
  published from Supabase Storage.
- `ecovilavideo.mp4`, `ecovilavideo-web.mp4`, and `assets/logo_small.png` remain
  owner-retained unused assets. They are documented as accepted, not current cleanup
  targets.
- There is no CI, dependency scanning, or secret scanning configuration in the repo.

## Positive findings

- Full local test suite passes.
- Deno lint/type/format checks pass.
- Local static asset references are intact.
- `verify_jwt` settings are explicit per Edge Function.
- CORS is centralized and no longer returns a wildcard by default.
- Staff-only functions verify Supabase Auth tokens before reading `app_metadata.role`.
- Maib callback signatures use HMAC verification and replay-window checks.
- Manage tokens and lookup codes are hashed.
- Confirmation-page status, cash extension, and guest cancellation now require a manage
  token; a bare reservation ID is no longer enough to act on a booking.
- Guest cancellation/refund policy is enforced server-side in the newer Edge Function
  flow.
- Root homepage decision is resolved: Romanian is canonical at `/`, with `/ru/` and
  `/en/`; no `/ro/` duplicate exists.
- Consent-gated conversion tracking stores server-side secrets only in Edge Function
  environment variables and hashes user match data before provider payloads.

## Recommended next sequence

1. Fix B-11/S-9 before applying migrations to production: confirm extension posture and
   reduce exposed security-definer surface.
2. Migrate S-10 legacy cancellation links to hashed token lookup.
3. Fix B-10 and add server-side contract tests for public booking payload constraints.
4. Fix S-12 SMS URL-query PII as a separate privacy/compliance task.
5. Pin/review Supabase JS and replace placeholder public imagery.
