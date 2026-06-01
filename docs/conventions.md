# Coding Conventions — EcoVila

The standards the codebase actually follows (observed during the Phase 0 audit). Keep
cleanup consistent with these. Update this file if a convention is deliberately changed
(and log the change in `docs/decisions.md`).

## Language & locale
- UI copy is **Romanian-first**, with RU and EN provided via `js/translations.js` and
  `data-i18n` attributes. Legal pages are **Romanian-only** by design (test-enforced).
- Currency is **MDL**; format via `EcoVilaPricing.formatMDL`. Dates display with
  `Intl.DateTimeFormat('ro-MD', …)`.
- Internal identifiers, code comments, commit messages, and these docs are in English.

## Browser JavaScript
- **No framework, no build, no ES modules.** Every shared file uses the UMD-style IIFE
  wrapper: assign a `window.EcoVila*` global and, when `module.exports` exists, export
  for CommonJS so `tests/*.test.mjs` can `require()` it. Mirror this pattern for any
  new shared module (see `js/pricing.js:1`, `admin/js/crm-app.js:1`).
- `'use strict';` at the top of each module factory.
- DOM is selected via `data-*` attributes (e.g. `[data-crm-app]`, `[data-guest-phone]`),
  not by id/class coupling. Keep using `data-` hooks for behavior.
- Do not silently persist fabricated defaults for guest data. Hints such as `+373` may
  appear as input placeholders, but required fields must validate and block submission
  instead of storing placeholder values.
- Naming: `camelCase` functions/vars, `UPPER_SNAKE` module constants, `EcoVila*`
  PascalCase globals. Files are `kebab-case.js`; CRM modules are `crm-*.js`.
- Script load order matters (no bundler): CDN supabase-js → `supabase-config.js` →
  `supabase.js` → feature scripts. Preserve dependency order when editing `<script>` tags.
- All Supabase access from the browser goes through `js/supabase.js` helpers — do not
  call the raw client from feature scripts. Pure pricing/date math lives in
  `js/pricing.js`; keep it side-effect-free (it is unit-tested directly).
- Any guest-controlled text rendered in the CRM must be assigned with `textContent` or a
  shared escaping helper before it reaches `innerHTML`. Treat reservation names, phones,
  notes, photo alt text, holiday labels, and any DB text field as untrusted. Shared CRM
  escaping currently lives at `EcoVilaCrmCalendar.escapeHtml`; use it for reservation
  card/search templates that still need string markup.
- Public guest actions that mutate reservation state must be authorized by a scoped token
  or equivalent proof, not by reservation UUID alone. Legacy confirmation RPCs are an
  open exception tracked as B-8/S-7.
- Browser code should have no `console.*` noise, no `debugger`, and no `TODO/FIXME`
  markers. Edge Functions may use concise operational `console.info` / `console.error`
  logging for provider callbacks and notification failures, but do not log secrets or
  full guest payloads. Default to no comments; comment only non-obvious *why*.

## Edge Functions (Deno/TypeScript)
- One `index.ts` entrypoint per function under `supabase/functions/<name>/`; shared
  logic in `_shared/`. New cross-cutting logic goes in `_shared/`, not copied per
  function.
- HTTP plumbing is centralized: use `_shared/http.ts` (`jsonResponse`, `errorResponse`,
  `assertMethod`, `readJson`, `HttpError`, `requireSharedSecret`, `requireStaffRole`)
  and `_shared/cors.ts`. Throw `HttpError(status, msg)` rather than crafting responses.
- CORS must stay centralized in `_shared/cors.ts`. Edge Functions should call
  `handleCors(request)` for preflight and pass the same `request` into
  `jsonResponse(..., ..., request)` / `errorResponse(error, request)` so normal responses
  echo only allowed origins. Do not reintroduce per-function allowlists or `*`.
- Env access goes through `_shared/env.ts` (`requiredEnv` / `optionalEnv`), never raw
  `Deno.env.get` in business code.
- `deno.json` sets `singleQuote: true`, `lineWidth: 100` — match it (`deno fmt`).
- Import Deno/NPM dependencies through bare specifiers defined in `deno.json` /
  `import_map.json`; do not add inline `npm:`, `jsr:`, or `https:` specifiers in
  source or tests.
- Privileged DB writes use the service-role client from `_shared/supabaseAdmin.ts`.
- Guest-facing cancellation rules must be enforced server-side in both the
  `reservation-cancel` Edge Function and the latest `cancel_reservation_by_token` RPC.
  Browser code may disable buttons and show policy copy, but must not be the only
  enforcement point. Staff Maib refunds remain Diana-only through `maib-refund` and do
  not reuse the public guest refund window.
- Server-side public reservation creation must enforce the same domain constraints as
  the public UI. Guest first/last names cannot include raw `<` or `>` characters. Child
  ages are supposed to be 1-17; the current 0/18 server acceptance is tracked as B-10.
- Secrets/signatures: hash tokens before storage; compare secrets/signatures with the
  constant-time helper; verify external callbacks (Maib) by signature + replay window.
- New bearer-style guest tokens should be stored hashed. The legacy plaintext
  `cancellation_tokens.token` column is an open exception tracked as S-10.
- Declare each function's `verify_jwt` in `supabase/config.toml`. Public/cron
  functions (`verify_jwt = false`) must enforce their own signature or shared-secret.
- Staff-only functions must `await requireStaffRole(request, [...])`; the helper validates
  the bearer token through Supabase Auth and reads `app_metadata.role` only from the
  verified user object. Do not parse JWT payloads by hand for authorization decisions.
- Shared helpers that accept a service-role Supabase client import the shared
  `SupabaseClient` / `SupabaseQueryResult` types from `_shared/supabaseAdmin.ts` and add
  local row/builder payload types where needed. Do not reintroduce `client: any` in
  `_shared/`.
- Reservation management entrypoints (`reservation-lookup-*`,
  `reservation-manage-details`, `reservation-cancel`) follow the same typed-client
  pattern with local row and query-builder shapes instead of `client: any`.
- `deno lint` is expected to pass cleanly for all Edge Function source and tests. New
  server code should use real types (`SupabaseClient`, `SupabaseQueryResult`, local
  row/query-builder shapes, or `unknown` + narrowing) and must not add explicit `any`.

## SQL migrations
- One file per change under `supabase/migrations/`, named
  `YYYYMMDDHHMMSS_snake_case_description.sql`, applied in filename order. Never edit a
  migration that has shipped — add a new one.
- RLS is enabled on all tables; access is by role (`anon` / `diana` / `angela`). Public
  reads of guest data must go through safe RPCs, not direct table selects.
- Migrations that use extensions must create/enable those extensions explicitly before
  first use. The current Maib `cron.schedule` migrations assume `pg_cron` exists and are
  tracked as B-11.
- Avoid `security definer` functions in exposed schemas. If a public RPC truly needs
  elevated privileges, keep its return shape minimal, set an explicit `search_path`, use
  fully qualified table names, grant only required roles, and document the reason in
  `docs/security.md`.

## Tests
- Root `package.json` is allowed only for dependency-free test scripts. It must not add
  runtime dependencies, dev dependencies, a build step, or an install requirement unless
  a future ADR explicitly changes ADR-001 / ADR-009.
- **Full suite:** run `npm test` from the repository root. It runs the Node contract
  suite first, then the Deno Edge Function suite.
- **Frontend:** Node `node:test` files in `tests/`, named `*.test.mjs`, run via
  `npm run test:node` (equivalent to `node --test 'tests/**/*.test.mjs'`). They
  `require()` the UMD modules and also assert page/markup contracts.
- **Backend:** Deno tests in `supabase/functions/tests/`, named `*.test.ts`, run
  via `npm run test:deno` from the repository root (equivalent to
  `cd supabase/functions && deno task test`, which runs
  `deno test --allow-env --allow-net tests`). Keep using `*.test.ts` so Deno's default
  directory discovery runs the tests.
- A change that alters markup, copy, or file layout will likely require updating the
  corresponding contract test in the same commit.

## Docs & process
- The Definition of Done in `docs/AGENTS.md` is mandatory: every step reviews/updates all
  doc files and commits docs + code together.
- Commit messages follow the existing style: `feat:` / `fix:` / `docs:` / `test:`
  prefixes for scoped changes, plain imperative sentences for larger ones.
