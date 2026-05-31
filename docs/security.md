# Security Posture & Findings — EcoVila

Audit date: 2026-05-31. This is a running log; future sessions update statuses and add
findings. Severities: Critical / High / Medium / Low / Info.

## Summary table

| ID | Finding | Severity | Where | Status |
|----|---------|----------|-------|--------|
| S-1 | Wildcard `Access-Control-Allow-Origin: *` on all Edge Functions except `maib-create-payment` | Low–Medium | `docs/supabase/functions/_shared/cors.ts` | Open |
| S-2 | `requireStaffRole` reads role from JWT payload without verifying the signature (relies on gateway `verify_jwt`) | Low (Info) | `docs/supabase/functions/_shared/http.ts:62` | Open |
| S-3 | Supabase **anon** key committed in `js/supabase-config.js` | Info (by design) | `js/supabase-config.js:5` | Accepted |
| S-4 | No `.env.example`; required secret names undocumented outside code/brief | Low | repo root | Fixed |
| S-5 | Hardcoded placeholder phone defaults in staff/checkout code (`+37300000000`, `+373`) | Low | former `admin/js/crm-sidebar.js:205`, `js/checkout.js:432` | Fixed |
| S-6 | `no-explicit-any` lint violations weakened type safety on server code | Low | `docs/supabase/functions/*/index.ts` | Fixed |

No Critical or High findings were identified. Several controls are implemented well
(see "Positive controls" below).

## Findings detail

### S-1 — Wildcard CORS on most Edge Functions (Low–Medium)
`_shared/cors.ts` returns `Access-Control-Allow-Origin: *` whenever a function does not
pass an explicit `allowedOrigins` list. Only `maib-create-payment` passes one
(`https://ecovila.md`, `https://www.ecovila.md`, `https://admin.ecovila.md`). 
- **Why it matters:** any origin can invoke the functions from a browser. For functions
  gated by `verify_jwt = true` plus shared-secret/token checks the practical risk is
  limited, but it widens the attack surface (e.g. CSRF-style abuse from a logged-in
  victim's browser on functions that act on bearer tokens).
- **Recommended fix:** pass the same `ALLOWED_ORIGINS` allowlist to `handleCors` /
  `withCors` in every function, not just `maib-create-payment`. Centralize the allowlist
  in `_shared/cors.ts` behind an env var (e.g. `ECOVILA_ALLOWED_ORIGINS`).

### S-2 — Role claim trusted without local signature verification (Low / Info)
`requireStaffRole` (`_shared/http.ts`) base64-decodes the JWT payload and reads
`app_metadata.role` **without verifying the token signature**. This is safe *only*
because `config.toml` sets `verify_jwt = true` for the staff-facing functions, so the
Supabase gateway verifies the token before the function runs, and `app_metadata` is
server-controlled.
- **Why it matters:** if any of those functions were ever switched to `verify_jwt =
  false`, role gating would be trivially forgeable.
- **Recommended fix:** add a defense-in-depth comment/assertion tying `requireStaffRole`
  to `verify_jwt = true`, or verify the JWT against the project JWKS inside the function.

### S-3 — Anon key in source (Info / Accepted)
The Supabase anon JWT is intentionally public; access is controlled by RLS. No action
needed beyond confirming RLS coverage. **Confirm no service-role key is ever committed**
(none found in tracked files as of this audit).

### S-4 — Missing `.env.example` (Low)
Required Edge Function secret *names* were only discoverable by reading code or the
brief.
- **Fixed 2026-05-31:** added a committed root `.env.example` with the canonical
  Supabase, cron/site, SMS.md, Resend, and Maib names only; all values are blank.

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

## Positive controls (verified)

- **Manage tokens & lookup codes are hashed in the DB** (`_shared/reservationManage.ts`
  `hashManageToken` / `hashLookupCode`); plaintext is never stored (asserted by Deno
  test "does not expose plaintext codes or tokens").
- **Maib callback signature** is HMAC-SHA256 over `rawBody.timestamp`, verified with a
  **constant-time compare** and a replay/tolerance window (`_shared/maib.ts`
  `verifyMaibCallbackSignature`, tested).
- **Cron/function shared secret** uses a constant-time comparison (`_shared/http.ts`
  `requireSharedSecret` / `constantTimeEqual`) and accepts `x-ecovila-secret` or bearer.
- **RLS** with public/`diana`/`angela` roles is defined in the foundation migration and
  asserted by `docs/tests/supabase-foundation.test.mjs` ("adds role-aware policies…",
  "public-safe availability RPC without exposing guest reservation details").
- **Guest-created reservation fields are sanitized** server-side
  (`buildReservationRows` "rejects unsafe guest-created reservation fields", tested).
- **Guest cancellation/refund windows are enforced server-side** in both
  `reservation-cancel` and the latest `cancel_reservation_by_token` RPC; browser UI copy
  mirrors the policy but is not the control point. Staff Maib refunds still require the
  JWT-verified, Diana-only `maib-refund` function.
- **Per-function `verify_jwt`** is declared in `config.toml`; public callbacks
  (`maib-callback`) and cron jobs run with `verify_jwt = false` but enforce their own
  signature/shared-secret checks.

## Notes / not assessed

- Dependency CVEs: no lockfile of pinned versions for the frontend (CDN `@2` floating
  tag); Deno resolves `npm:@supabase/supabase-js@2` at build. A floating major tag means
  transitive versions are not pinned (Low — supply-chain drift).
- No automated dependency or secret scanning is configured (no CI found).
