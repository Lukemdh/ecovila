# Security Posture & Findings — EcoVila

Audit date: 2026-06-01; last updated 2026-06-03. This is a running log; future sessions update statuses and add
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

No Critical or High findings remain open. Medium findings still block production launch
until fixed or explicitly accepted. See `docs/production-readiness-audit.md` for the
2026-06-01 scan evidence.

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
- **Raw old hosting backups are ignored, not committed.** `Archive.zip` and
  `docs/old php/` stay local-only because the backup contains retired credentials and
  cPanel/mail/SSL artifacts; committed old-content context is limited to the sanitized
  `docs/old-content-inventory.md`.

## Notes / not assessed

- Dependency CVEs: no npm dependency audit is available because there is no npm
  lockfile. Deno dependency drift was checked with `deno outdated` on 2026-06-01.
- No automated dependency or secret scanning is configured (no CI found).
