# Security Posture & Findings — EcoVila

Audit date: 2026-06-01; last updated 2026-08-27. This is a running log; future sessions update statuses and add
findings. Severities: Critical / High / Medium / Low / Info.

## Summary table

| ID | Finding | Severity | Where | Status |
|----|---------|----------|-------|--------|
| S-1 | Wildcard `Access-Control-Allow-Origin: *` on all Edge Functions except `maib-create-payment` | Low–Medium | `supabase/functions/_shared/cors.ts` | Fixed |
| S-2 | `requireStaffRole` formerly read role from an unverified JWT payload | Low (Info) | `supabase/functions/_shared/http.ts` | Fixed |
| S-3 | Supabase **anon** key committed in `js/supabase-config.js` | Info (by design) | `js/supabase-config.js:5` | Accepted |
| S-4 | No `.env.example`; required secret names undocumented outside code/brief | Low | repo root | Fixed |
| S-5 | Hardcoded placeholder phone defaults in staff/checkout code (`+37300000000`, `+373`) | Low | former `admin/js/crm-sidebar.js:205`, `js/checkout.js:432` | Fixed |
| S-6 | `no-explicit-any` lint violations weakened type safety on server code | Low | `supabase/functions/*/index.ts` | Fixed |
| S-7 | Legacy confirmation RPCs could be used with reservation UUID only | High | `js/confirmare.js`, `js/supabase.js`, `reservation-extend-cash`, `20260601173901_require_manage_token_confirmation_actions.sql` | Fixed |
| S-8 | CRM renders guest-controlled reservation fields through `innerHTML` | High | `admin/js/crm-dashboard.js`, `admin/js/crm-sidebar.js`, `admin/js/crm-daily.js` | Fixed |
| S-9 | Anonymous `security definer` RPCs remain in exposed `public` schema | Medium | `supabase/migrations/*.sql` | Open |
| S-10 | Legacy cancellation tokens are stored plaintext | Medium | `public.cancellation_tokens`, `_shared/reservations.ts` | Open |
| S-11 | Floating Supabase JS major tag creates supply-chain drift | Low | HTML CDN tags, Deno import map | Open |
| S-12 | SMS provider call passes phone/message/token in the URL query string | High | `supabase/functions/_shared/providers.ts` | Open / out of SEO-tracking scope |
| S-13 | Reservation `total_price` trusted from the client end-to-end (payment tampering) | Critical | `create-reservation`, `maib-create-payment` | Fixed |
| S-14 | RLS policy + grant allowed direct `anon` INSERT into `reservations` | Critical | `supabase/migrations/20260506210000`, `20260508123000` | Fixed |
| S-15 | MAIB `paid` callback accepted without reconciling the captured amount | Critical | `supabase/functions/maib-callback/index.ts` | Fixed |
| S-16 | PostgREST `.or()` filter injection via `payId` in `maib-refund` | Low | `supabase/functions/maib-refund/index.ts` | Fixed |
| S-17 | CRM auth session cookie written without the `Secure` flag | Low | `admin/js/crm-auth.js` | Fixed |

The 2026-06-11 payment-flow audit found and fixed three Critical findings (S-13, S-14,
S-15); all are deployed to production and verified live. The remaining open findings are
S-12 (High, SMS provider PII in URL query) and the Mediums S-9/S-10, which still need to
be fixed or explicitly accepted by the owner. See `docs/production-readiness-audit.md`
and the root `bugs.md` fix log for evidence.

## Findings detail

### S-1 — Wildcard CORS on most Edge Functions (Low–Medium)
Formerly, `_shared/cors.ts` returned `Access-Control-Allow-Origin: *` whenever a
function did not pass an explicit `allowedOrigins` list. Only `maib-create-payment`
passed a local allowlist.
- **Why it mattered:** any origin could invoke the functions from a browser. For
  functions gated by `verify_jwt = true` plus shared-secret/token checks the practical
  risk was limited, but it widened the attack surface.
- **Fixed 2026-05-31:** `_shared/cors.ts` now owns the default allowlist and optional
  comma-separated `ECOVILA_ALLOWED_ORIGINS` override. Known origins are echoed with
  `Vary: Origin`; unknown origins do not receive `Access-Control-Allow-Origin` and no
  function returns a permissive wildcard by default.

### S-2 — Role claim trusted without local signature verification (Low / Info)
Formerly, `requireStaffRole` (`_shared/http.ts`) base64-decoded the JWT payload and read
`app_metadata.role` without verifying the token signature, relying on each staff-facing
function's `verify_jwt = true` gateway setting.
- **Why it mattered:** if any of those functions were ever switched to `verify_jwt =
  false`, role gating would have been trivially forgeable.
- **Fixed 2026-06-01:** `requireStaffRole` now validates the bearer token through
  Supabase Auth (`auth.getUser`) using `SUPABASE_URL` + `SUPABASE_ANON_KEY`, then reads
  `app_metadata.role` only from the verified user object. Staff functions still keep
  `verify_jwt = true` in `config.toml`; the local Auth check is defense in depth.

### S-3 — Anon key in source (Info / Accepted)
The Supabase anon JWT is intentionally public; access is controlled by RLS. No action
needed beyond confirming RLS coverage. **Confirm no service-role key is ever committed**
(none found in tracked files as of this audit).

### S-4 — Missing `.env.example` (Low)
Required Edge Function secret *names* were only discoverable by reading code or the
brief.
- **Fixed 2026-05-31; updated 2026-06-03:** added a committed root `.env.example` with
  the canonical Supabase, cron/site, SMS.md, Resend, Maib, Meta CAPI, and Google Ads
  conversion names only; all values are blank.

### S-5 — Hardcoded placeholder phones (Low)
Formerly, `admin/js/crm-sidebar.js:205` defaulted a missing phone to `+37300000000`, and
`js/checkout.js:432` seeded the input with `+373`. These are UX placeholders, not
secrets, but the staff default could have created reservations with a bogus contact
number.
- **Fixed 2026-05-31:** checkout and CRM phone fields now use `+373` only as placeholder
  copy, not as a submitted value; CRM add-reservation validation blocks empty/invalid
  phone values, and row building no longer substitutes `+37300000000`.

### S-6 — `no-explicit-any` on server code (Low)
Formerly, Edge Function entrypoints still carried explicit `any` types after the
shared-helper cleanup. These were not vulnerabilities by themselves, but they raised the
chance of unchecked data handling in privileged server code.
- **Fixed 2026-05-31:** Steps 8–11 replaced the lint debt with typed Supabase
  client/result aliases plus local row, query-builder, and payload shapes. `deno lint`
  now passes with 0 problems.

### S-7 — Legacy confirmation RPCs were reservation-UUID-only (High / Fixed 2026-06-01)
The older confirmation path called `get_pending_reservation_status`,
`extend_cash_reservation`, and `cancel_pending_reservation` by reservation UUID from
`confirmare.html?id=<reservation_id>`. Those SQL functions were `security definer`,
granted to `anon`/`authenticated`, and did not require the newer manage token or phone
verification.
- **Why it mattered:** UUID guessing is impractical, but a leaked confirmation URL gave
  anyone with the URL the ability to extend or cancel a pending reservation. This was a
  bearer-link design without a token scope or expiry distinct from the reservation ID.
- **Fixed:** `create-reservation` now mints a hashed manage token immediately and returns
  plaintext only to the caller. Checkout, Maib return URLs, booking/payment
  notifications, and cash-expiry reminders link to
  `confirmare.html?id=<reservation_id>&manage=<token>`. The confirmation page requires
  both values and uses token-backed Edge Functions for status, cash extension, and
  cancellation (`reservation-manage-details`, `reservation-extend-cash`,
  `reservation-cancel`).
- **Migration:** `20260601173901_require_manage_token_confirmation_actions.sql` drops
  the three legacy UUID-only RPC signatures.

### S-8 — Stored XSS risk in CRM rendering (High) — Fixed 2026-06-01
Formerly, several CRM surfaces built `innerHTML` with reservation fields such as
`guest_first_name`, `guest_last_name`, and `guest_phone`. `guestName()` returned raw DB
strings, and public reservation creation trimmed but did not restrict name characters.
- **Why it mattered:** a guest could submit markup in their name. When staff opened the
  CRM, that markup could execute in the authenticated admin origin, potentially exposing
  session state or triggering privileged staff actions.
- **Fixed:** `EcoVilaCrmCalendar.escapeHtml` now provides the shared CRM escaping helper,
  and dashboard calendar cards, pending-cash cards, sidebar search results, and daily
  reception cards escape guest names, phones, labels, dates, and data attributes before
  template insertion. Public reservation creation now rejects guest names containing
  `<` or `>`.
- **Verification:** Node regression tests cover the payload
  `<img src=x onerror=alert(1)>` and an unsafe phone payload across the affected CRM
  cards; the Deno reservation test asserts unsafe public guest names are rejected.

### S-9 — Exposed-schema `security definer` RPCs (Medium / Open)
The migration set contains `security definer` functions in the `public` schema and grants
several to `anon`/`authenticated`, including availability, token lookup, pending-status,
extension, and cancellation RPCs.
- **Why it matters:** Supabase guidance treats security-definer functions in exposed
  schemas as risky. The current functions set explicit `search_path` and mostly use
  qualified table names, which helps, but the exposed privileged surface is still larger
  than it needs to be.
- **Required fix:** audit each RPC, move privileged helpers to a private schema or Edge
  Functions where possible, keep only deliberately public wrappers in `public`, and
  preserve explicit `search_path` settings.

### S-10 — Plaintext legacy cancellation tokens (Medium / Open)
The newer reservation lookup codes and manage tokens are hashed, but
`public.cancellation_tokens.token` stores the legacy cancellation bearer token plaintext.
- **Why it matters:** a DB read leak would expose active cancellation links. This is a
  lower-impact issue than service-role exposure but inconsistent with the newer hashed
  token model.
- **Required fix:** add a token-hash column, look up by hash, return plaintext only at
  creation time, and migrate existing active tokens deliberately.

### S-11 — Floating Supabase JS major tag (Low / Open)
Browser pages load `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`; Deno imports
`npm:@supabase/supabase-js@2` and the current lock resolves to 2.105.3. On 2026-06-01,
`deno outdated` reported 2.106.2 as the latest.
- **Why it matters:** the browser CDN and Deno lock can drift from each other, and a
  floating major tag makes exact production behavior harder to reproduce.
- **Required fix:** pin/review an exact Supabase JS version for browser and Deno, then
  decide whether CDN SRI or local vendoring fits the no-build hosting model.

### S-12 — SMS provider URL-query PII (High / Open)
The SMS.md provider call currently places phone/message/token values in a request URL
query string. This violates the no-PII-in-URLs constraint and Legea 195/2024. It is
explicitly out of scope for the 2026-06-03 SEO/tracking implementation, but is tracked
as standalone Step 20 in `docs/plan.md`.
- **Required fix:** use a POST body if SMS.md supports it; if the provider only accepts
  GET, ensure the full request URL is never written to logs or telemetry.
- **Current control:** new conversion-tracking code does not repeat this pattern and
  does not put phone/email/message data into browser URLs.

## Positive controls (verified)

- **Manage tokens & lookup codes are hashed in the DB** (`_shared/reservationManage.ts`
  `hashManageToken` / `hashLookupCode`); plaintext is never stored (asserted by Deno
  tests covering lookup codes and `buildManageTokenRow`). Confirmation-page actions now
  require the hashed manage-token flow rather than reservation UUID alone.
- **Maib callback signature** is HMAC-SHA256 over `rawBody.timestamp`, verified with a
  **constant-time compare** and a replay/tolerance window (`_shared/maib.ts`
  `verifyMaibCallbackSignature`, tested).
- **Cron/function shared secret** uses a constant-time comparison (`_shared/http.ts`
  `requireSharedSecret` / `constantTimeEqual`) and accepts `x-ecovila-secret` or bearer.
- **RLS** with public/`diana`/`angela` roles is defined in the foundation migration and
  asserted by `tests/supabase-foundation.test.mjs` ("adds role-aware policies…",
  "public-safe availability RPC without exposing guest reservation details").
- **Guest-created reservation privileged fields are sanitized** server-side
  (`buildReservationRows` rejects unsafe guest-created reservation fields such as
  payment status, notes, staff-created flags, and conference-room flags). Public guest
  names containing `<` or `>` are rejected before storage, and CRM renderers escape
  untrusted reservation text before `innerHTML`.
- **Guest cancellation/refund windows are enforced server-side** in both
  `reservation-cancel` and the latest `cancel_reservation_by_token` RPC; browser UI copy
  mirrors the policy but is not the control point. Staff Maib refunds still require the
  JWT-verified, Diana-only `maib-refund` function.
- **Per-function `verify_jwt`** is declared in `config.toml`; public callbacks
  (`maib-callback`) and cron jobs run with `verify_jwt = false` but enforce their own
  signature/shared-secret checks. Staff role checks additionally validate bearer tokens
  through Supabase Auth before trusting `app_metadata.role`.
- **Conversion tracking is consent-gated and server-secret-only.** Browser code only
  reads public tracking IDs from `js/tracking-config.js`; Meta CAPI and Google Ads API
  tokens are read server-side via `_shared/env.ts`. Server-side user match data is
  SHA-256 hashed before provider payload construction, and Purchase events dedupe with
  the browser event via a shared `tracking_event_id`.
- **Standalone payment links RLS & RPC posture (ADR-106).**
  `payment_links` and `payment_link_attempts` tables enforce RLS with Diana-only SELECT
  policies (`ecovila_app_role() = 'diana'`). No client-facing INSERT, UPDATE, or DELETE
  policies exist for either table; all mutations execute via service-role Edge Functions.
  All four RPCs (`claim_payment_link_attempt`, `settle_payment_link_attempt`,
  `revoke_payment_link`, `mark_payment_link_refunded`) are `SECURITY INVOKER`, declare
  `SET search_path = ''`, use fully-qualified schema names (`pg_catalog.*`, `public.*`),
  have `REVOKE EXECUTE ... FROM PUBLIC`, and grant execute exclusively to `service_role`.
- **Standalone payment links capability model (ADR-106).**
  The guest page `plata.html?p=<uuid>` is accessed via a plain UUID bearer ID in a query
  parameter rather than an HMAC or URL fragment:
  - *Why plain UUID over HMAC:* 122 unguessable bits provide sufficient entropy (matching
    `maib-mia-status`). An HMAC adds a secret rotation hazard that would invalidate
    never-expiring links, without mitigating the real bearer risk (forwarded/screenshotted links).
  - *Why query param over fragment:* Fragment survival across messaging apps (WhatsApp, Viber)
    is unverified, and B-17 proved MAIB Checkout does not preserve custom parameters on the card
    return redirect (relying on `orderId` matching attempt id). Leaked IDs carry minimal risk
    (at worst, paying money to EcoVila).
  - *Data isolation:* Public responses expose only coarse status, amount, currency, rail,
    label, and expiry; no provider payloads, staff notes, or personal data are accessible.
- **Diana-only staff gating on payment links (ADR-106).**
  `payment-link-admin` enforces `await requireStaffRole(request, ['diana'])`, validating bearer
  tokens via Supabase Auth. Angela is refused server-side (HTTP 403) and has no UI tab. Per ADR-103,
  staff endpoints carry no IP rate limiting, while `payment-link-public` is rate limited per IP
  and per link (tighter on `start` than `status`).
- **Payment link provider reconciliation & money invariants (ADR-106).**
  Callbacks and status re-read MAIB authoritatively (`GET /v2/checkouts/{id}` for card,
  `GET /v2/mia/payments?orderId=` for MIA). Settlement is atomic via `settle_payment_link_attempt`
  (locking link-then-attempt). Captured money always wins: late captures after expiry or revocation
  are recorded as paid and flagged `manual_review` with alert rather than discarded or shown as expired.
- **Reservation-bound payment-link posture (ADR-107).**
  Accommodation differences reuse the ADR-106 tables/settlement path, classified by
  `purpose` and bound to a reservation plus destination room-type snapshot. Diana's
  `reservation-accommodation-move` function keeps `verify_jwt = true`, awaits
  `requireStaffRole(['diana'])`, derives the booking group server-side, and invokes the
  service-role-only `SECURITY INVOKER` move RPC. The RPC locks the reservation and
  mutable target-room row before moving inventory; its execution is revoked from
  `public`/`anon`/`authenticated`. Angela receives SELECT only for
  `purpose = 'accommodation_difference'`, which is required for accurate Daily totals,
  and still cannot see standalone links or payment attempts.
- **Replacement billing concurrency lock (ADR-107).**
  `move_reservation_accommodation` explicitly locks any previous active difference link row
  (`FOR UPDATE`) and rejects replacement billing if a provider attempt is currently
  `creating` or `pending` (or settled in flight). This prevents a race where a late capture
  on a revoked link settles as paid while a new active link is simultaneously paid by the guest.
- **Database trigger enforces "no repricing with difference" (ADR-107).**
  A narrowly scoped `SECURITY DEFINER` trigger, `prevent_repricing_with_accommodation_difference`
  (BEFORE UPDATE OF `total_price` ON `public.reservations`), acts as the authoritative
  enforcement point rejecting any price modification when an `accommodation_difference` link
  exists. This eliminates race conditions where a stale Daily tab could pass client-side checks
  and overwrite the base price.
- **Optimistic room-type re-read on guest changes (ADR-107).**
  `insertChangeRow` in `_shared/reservationChanges.ts` re-reads the group's live room types
  immediately prior to inserting a pending add-guests change row and refuses (409) if the
  room types moved since quote generation, preventing stale quotes from settling against
  a different accommodation type.
- **Cancellation/refund honesty & strict paid_amount validation (ADR-107).**
  The narrowly scoped `SECURITY DEFINER` trigger has no executable grant and only
  revokes active difference links when a reservation changes to `cancelled`, inside the
  writer's transaction. Paid link money is deliberately outside
  `prepare_full_refund_intent`; outstanding balances are surfaced to staff/guest for a
  separate portal refund. Money calculations strictly use verified `paid_amount`: a
  `status='paid'` link with a missing or invalid `paid_amount` fails closed as UNVERIFIED,
  routed to pessimistic copy plus staff alert, never falling back to requested `amount`.
  Failed reads are not treated as proof of zero: CRM money displays/preflights become
  unverified, Finance fails visibly, Daily repricing is refused, and guest cancellation
  sends pessimistic localized copy plus a staff alert while preserving the already-committed
  cancellation/base refund.
- **Recorded link refunds are monotonic (ADR-107 hardening).**
  `mark_payment_link_refunded` locks the paid link and rejects a cumulative amount below
  the stored value (equality remains allowed for correcting the note), so a stale CRM
  session cannot make refunded money reappear as Finance income.
- **Raw old hosting backups are ignored, not committed.** `Archive.zip` and
  `docs/old php/` stay local-only because the backup contains retired credentials and
  cPanel/mail/SSL artifacts; committed old-content context is limited to the sanitized
  `docs/old-content-inventory.md`.

## Notes / not assessed

- Dependency CVEs: no npm dependency audit is available because there is no npm
  lockfile. Deno dependency drift was checked with `deno outdated` on 2026-06-01.
- No automated dependency or secret scanning is configured (no CI found).

### S-13 — Client-controlled reservation price (Critical) — Fixed 2026-06-11
The browser quote (`js/booking.js` → `localStorage` → `js/checkout.js`) was the only
price computation; `create-reservation` validated `total_price` merely as a non-negative
integer and `maib-create-payment` charged the stored sum. Any guest could pay 1 MDL for
any stay.
- **Fixed:** `_shared/pricingGuard.ts` recomputes the authoritative total inside
  `create-reservation` from DB `rooms`/`pricing_tiers`/`holidays` using the same pricing
  module as the browser (`_shared/pricing.js`, an exact copy of `js/pricing.js`,
  byte-identity enforced by `tests/pricing-guard.test.mjs`). Mismatches are rejected with
  HTTP 409; the per-room split is normalized server-side. Verified in production:
  tampered total → 409, correct total → created.

### S-14 — Direct `anon` INSERT path into `reservations` (Critical) — Fixed 2026-06-11
The "Public can create guest reservations" RLS policy plus the `anon` INSERT grant let
any visitor bypass the Edge Function entirely via PostgREST and set any `total_price`.
- **Fixed:** migration `20260611120000_revoke_public_reservation_insert.sql` drops the
  policy and revokes the grant; public bookings exist only through `create-reservation`
  (service role), staff bookings through the authenticated CRM policy. Verified in
  production: direct anon insert → `42501 permission denied`.

### S-15 — MAIB callback amount never reconciled (Critical) — Fixed 2026-06-11
A signed `paid` callback flipped reservations to paid regardless of the amount actually
captured.
- **Fixed:** `getMaibCallbackAmount` (`_shared/maib.ts`) extracts the callback amount;
  on mismatch with the stored `maib_payments.amount` (fallback: reservation total sum)
  the booking stays `pending`, the response is `amount_mismatch`, and the event is logged
  at error level for manual review. Absent amount fields proceed with a logged warning
  (callback authenticity is already HMAC-verified).

### S-16 — PostgREST filter injection in `maib-refund` (Low) — Fixed 2026-06-11
`findPayment` interpolated the staff-supplied `payId` into an `.or()` filter string.
- **Fixed:** replaced with two sequential `.eq()` lookups. Staff-only surface (`diana`
  role), so impact was limited to malformed staff input.

### S-17 — CRM auth cookie without `Secure` (Low) — Fixed 2026-06-11
`admin/js/crm-auth.js` now appends `Secure` to the `/admin` session cookies except on
plain-HTTP local development hosts; `SameSite=Lax` and the `/admin` path scope were
already in place, and `.htaccess` sends HSTS.
