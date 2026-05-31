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
  for CommonJS so `docs/tests/*.test.mjs` can `require()` it. Mirror this pattern for any
  new shared module (see `js/pricing.js:1`, `admin/js/crm-app.js:1`).
- `'use strict';` at the top of each module factory.
- DOM is selected via `data-*` attributes (e.g. `[data-crm-app]`, `[data-guest-phone]`),
  not by id/class coupling. Keep using `data-` hooks for behavior.
- Naming: `camelCase` functions/vars, `UPPER_SNAKE` module constants, `EcoVila*`
  PascalCase globals. Files are `kebab-case.js`; CRM modules are `crm-*.js`.
- Script load order matters (no bundler): CDN supabase-js → `supabase-config.js` →
  `supabase.js` → feature scripts. Preserve dependency order when editing `<script>` tags.
- All Supabase access from the browser goes through `js/supabase.js` helpers — do not
  call the raw client from feature scripts. Pure pricing/date math lives in
  `js/pricing.js`; keep it side-effect-free (it is unit-tested directly).
- No `console.*` noise, no `debugger`, no `TODO/FIXME` markers exist today — keep it that
  way. Default to no comments; comment only non-obvious *why*.

## Edge Functions (Deno/TypeScript)
- One `index.ts` entrypoint per function under `docs/supabase/functions/<name>/`; shared
  logic in `_shared/`. New cross-cutting logic goes in `_shared/`, not copied per
  function.
- HTTP plumbing is centralized: use `_shared/http.ts` (`jsonResponse`, `errorResponse`,
  `assertMethod`, `readJson`, `HttpError`, `requireSharedSecret`, `requireStaffRole`)
  and `_shared/cors.ts`. Throw `HttpError(status, msg)` rather than crafting responses.
- Env access goes through `_shared/env.ts` (`requiredEnv` / `optionalEnv`), never raw
  `Deno.env.get` in business code.
- `deno.json` sets `singleQuote: true`, `lineWidth: 100` — match it (`deno fmt`).
- Privileged DB writes use the service-role client from `_shared/supabaseAdmin.ts`.
- Guest-facing cancellation rules must be enforced server-side in both the
  `reservation-cancel` Edge Function and the latest `cancel_reservation_by_token` RPC.
  Browser code may disable buttons and show policy copy, but must not be the only
  enforcement point. Staff Maib refunds remain Diana-only through `maib-refund` and do
  not reuse the public guest refund window.
- Secrets/signatures: hash tokens before storage; compare secrets/signatures with the
  constant-time helper; verify external callbacks (Maib) by signature + replay window.
- Declare each function's `verify_jwt` in `docs/supabase/config.toml`. Public/cron
  functions (`verify_jwt = false`) must enforce their own signature or shared-secret.
- **Lint debt:** the codebase has 87 `no-explicit-any` violations (mostly `client: any`).
  New code should prefer real types; do not add new `any`.

## SQL migrations
- One file per change under `docs/supabase/migrations/`, named
  `YYYYMMDDHHMMSS_snake_case_description.sql`, applied in filename order. Never edit a
  migration that has shipped — add a new one.
- RLS is enabled on all tables; access is by role (`anon` / `diana` / `angela`). Public
  reads of guest data must go through safe RPCs, not direct table selects.

## Tests
- **Frontend:** Node `node:test` files in `docs/tests/`, named `*.test.mjs`, run with
  `node --test 'docs/tests/**/*.test.mjs'`. They `require()` the UMD modules and also
  assert page/markup contracts.
- **Backend:** Deno tests in `docs/supabase/functions/tests/`, named `*.test.ts`, run
  from `docs/supabase/functions` with `deno task test` (or the equivalent
  `deno test --allow-env --allow-net tests`). Keep using `*.test.ts` so Deno's default
  directory discovery runs the tests.
- A change that alters markup, copy, or file layout will likely require updating the
  corresponding contract test in the same commit.

## Docs & process
- The Definition of Done in `docs/AGENTS.md` is mandatory: every step reviews/updates all
  doc files and commits docs + code together.
- Commit messages follow the existing style: `feat:` / `fix:` / `docs:` / `test:`
  prefixes for scoped changes, plain imperative sentences for larger ones.
