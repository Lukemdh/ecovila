# Coding Conventions — EcoVila

The standards the codebase actually follows (observed during the Phase 0 audit). Keep
cleanup consistent with these. Update this file if a convention is deliberately changed
(and log the change in `docs/decisions.md`).

## Language & locale
- UI copy is **Romanian-first**, with RU and EN provided via `js/translations.js` and
  `data-i18n` attributes. Legal pages are **Romanian-only** by design (test-enforced).
- Public homepages are served as static localized URLs: Romanian at `/`, Russian at
  `/ru/`, English at `/en/`. Do not add a served `/ro/` duplicate; Romanian switcher
  links go directly to `/`.
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
  `supabase.js` → optional `tracking-config.js` / `tracking.js` → translations and
  feature scripts. Preserve dependency order when editing `<script>` tags.
- All Supabase access from the browser goes through `js/supabase.js` helpers — do not
  call the raw client from feature scripts. Pure pricing/date math lives in
  `js/pricing.js`; keep it side-effect-free (it is unit-tested directly).
- A reservation-bound accommodation difference is a separate `payment_links` ledger
  entry, never an in-place mutation of `reservations.total_price`. Staff-facing totals
  use `base + Σ net(paid_amount - refunded_amount)` only for links bound to the supplied
  live reservation rows; unpaid links are shown separately. Never fall back from
  `paid_amount` to the requested `amount` (missing or invalid `paid_amount` must fail closed as
  UNVERIFIED), and never classify by nullable binding fields instead of `purpose`.
- Client-side refusal to reprice bookings with bound differences in Situația zilnică provides
  friendly feedback, but the authoritative enforcement point is the database trigger
  `prevent_repricing_with_accommodation_difference`.
- Money-critical link reads must distinguish a successful empty result from a failed
  read. On failure, show an unavailable/unverified state and block destructive
  repricing where the missing rows could change the decision; do not catch into `[]` or
  an empty `Map` that looks like verified zero.
- Guest-dossier notes (`guest_notes`, ADR-111) are keyed by phone AND/OR email and either match
  flags the guest; attention always outranks vip, and a tooltip preview must come from the newest
  note OF THE REPORTED SEVERITY, never the newest overall. The calendar flag may use neither a card
  background (already pending/paid-cash/paid-card/cancelled/hold plus five group accents) nor
  Situația zilnică's `border-left-color` (already check-in/check-out/complete): it composes an inset
  ring onto the card's existing `box-shadow` and adds a ringed badge. Client-side flag matching must
  stay semantically identical to `_shared/guestNotes.ts:matchGuestFlags`, or the calendar and the
  alert email will disagree about who is flagged.
- Any guest-controlled text rendered in the CRM must be assigned with `textContent` or a
  shared escaping helper before it reaches `innerHTML`. Treat reservation names, phones,
  notes, photo alt text, holiday labels, and any DB text field as untrusted. Shared CRM
  escaping currently lives at `EcoVilaCrmCalendar.escapeHtml`; use it for reservation
  card/search templates that still need string markup.
- Public guest actions that read or mutate private reservation state must be authorized
  by a scoped token or equivalent proof, not by reservation UUID alone. Confirmation
  links use `id` + `manage`; bare `confirmare.html?id=<uuid>` URLs must not expose
  status, extension, or cancellation actions.
- Browser code should have no `console.*` noise, no `debugger`, and no `TODO/FIXME`
  markers. Edge Functions may use concise operational `console.info` / `console.error`
  logging for provider callbacks and notification failures, but do not log secrets or
  full guest payloads. Default to no comments; comment only non-obvious *why*.
- Browser tracking code may load only public IDs/config. Meta CAPI, Google Ads API
  tokens, and any provider credentials stay in Supabase Edge Function env vars. Do not
  put raw phone/email/message values into URLs or logs for new tracking work.
- Do not commit raw hosting backups or old server dumps. Keep `Archive.zip` and
  `docs/old php/` local-only unless a separate sanitization pass removes credentials,
  cPanel/mail/SSL artifacts, and private data.

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
- Money amounts are never trusted from the client. Public reservation totals are
  recomputed server-side by `_shared/pricingGuard.ts` inside `create-reservation`
  (mismatch → HTTP 409), and the MAIB callback reconciles the captured amount before
  marking anything paid. `_shared/pricing.js` must stay byte-identical to
  `js/pricing.js` — re-copy after any pricing change (`tests/pricing-guard.test.mjs`
  enforces this).
- Refund amounts are integer MDL; `_shared/refundPolicy.ts` computes the quote once at intent, it is
  persisted, and executors send the stored net amount without recomputing it.
- Holidays are recurring month-day rules: fetch the whole `holidays` table; never
  filter it by a date range (client or server).
  Pending cash holds may be cancelled through the manage-token confirmation flow; paid
  cash reimbursements remain office-only. Browser code may disable buttons and show
  policy copy, but must not be the only enforcement point. Staff Maib refunds remain
  Diana-only through `maib-refund` and do not reuse the public guest refund window.
- Server-side public reservation creation must enforce the same domain constraints as
  the public UI. Guest first/last names cannot include raw `<` or `>` characters. Child
  ages are supposed to be 1-17; the current 0/18 server acceptance is tracked as B-10.
- Secrets/signatures: hash tokens before storage; compare secrets/signatures with the
  constant-time helper; verify external callbacks (Maib) by signature + replay window.
- New bearer-style guest tokens should be stored hashed. The legacy plaintext
  `cancellation_tokens.token` column is an open exception tracked as S-10.
- Declare each function's `verify_jwt` in `supabase/config.toml`. Public/cron
  functions (`verify_jwt = false`) must enforce their own signature or shared-secret.
- A notification that must survive provider failures belongs in a cron-swept function, not inline in
  a request path: only a repeating caller can re-enter `dispatchScheduledNotificationOnce`, and
  `create-reservation` in particular commits reservations, cancellation tokens and the manage token
  as separate statements, so awaiting a provider after them can strand a booking behind a failed
  response. A cron sweep also catches staff-created bookings, which are a direct table insert and
  reach no Edge Function at all. Delivery through this path is at-least-once; do not document it as
  exactly-once. Any per-contact cooldown must count only `delivery_status = 'sent'` rows, or a
  failed attempt will suppress its own retry.
- Cron-triggered functions run on a frequent (~1-minute) external schedule and must be
  idempotent: rely on `notification_events` dedup and gate time-of-day behaviour in code,
  not on the cron cadence. Business-hour logic uses the `Europe/Chisinau` zone
  (`_shared/reminders.ts`), so it stays DST-correct without changing the schedule. Arrival
  reminders are held until `ARRIVAL_REMINDER_LOCAL_HOUR` (10:00) local — see ADR-019.
- Staff-only functions must `await requireStaffRole(request, [...])`; the helper validates
  the bearer token through Supabase Auth and reads `app_metadata.role` only from the
  verified user object. Do not parse JWT payloads by hand for authorization decisions.
- Reservation accommodation moves use a Diana-only Edge Function and a service-role-only
  database RPC. Derive mutable room number/type/active state and booking binding on the
  server under row locks; browser source/target data is advisory and the SMS remains an
  opt-in, post-commit best-effort side effect.
- Shared helpers that accept a service-role Supabase client import the shared
  `SupabaseClient` / `SupabaseQueryResult` types from `_shared/supabaseAdmin.ts` and add
  local row/builder payload types where needed. Do not reintroduce `client: any` in
  `_shared/`.
- Reservation management entrypoints (`reservation-lookup-*`,
  `reservation-manage-details`, `reservation-extend-cash`, `reservation-cancel`) follow the same typed-client
  pattern with local row and query-builder shapes instead of `client: any`.
- `deno lint` is expected to pass cleanly for all Edge Function source and tests. New
  server code should use real types (`SupabaseClient`, `SupabaseQueryResult`, local
  row/query-builder shapes, or `unknown` + narrowing) and must not add explicit `any`.

## SQL migrations
- One file per change under `supabase/migrations/`, named
  `YYYYMMDDHHMMSS_snake_case_description.sql`, applied in filename order. Never edit a
  migration that has shipped — add a new one.
- RLS is enabled on all tables; access is by role (`anon` / `diana` / `angela`). Public
  reads of guest data must go through safe RPCs, not direct table selects. Sensitive tables
  such as `payment_links` and `payment_link_attempts` grant SELECT only to `diana` with no
  client write policies; all mutations execute through service-role Edge Functions.
- Migrations that use extensions must create/enable those extensions explicitly before
  first use. The current Maib `cron.schedule` migrations assume `pg_cron` exists and are
  tracked as B-11.
- A nullable FK declared `ON DELETE SET NULL` performs an UPDATE on the referencing row, so a
  column-immutability trigger must exempt it or the parent row can never be deleted. Grant the
  exemption only when the nulled column is the ONLY one that changed — a referential action changes
  exactly one, so a client UPDATE cannot launder a wipe through it. For the same reason, a
  both-or-neither CHECK across a value and its nullable FK author column will abort that deletion;
  make the invariant one-directional instead.
- A view over an RLS-protected table must be declared `set (security_invoker = true)`, otherwise it
  runs with the view owner's rights and bypasses the policies of the table beneath it.
- Before recreating an enumerated CHECK constraint, read the LIVE definition. `review_request` was
  missing from BOTH the repo's and production's copy of `notification_events_event_type_check`, so
  ADR-082's review email silently failed for ten weeks (B-39).
- A cron's `net.http_post` reporting "succeeded" says only that the HTTP call worked. When a function
  catches per-item failures so one bad row cannot abort a batch — the right shape — the batch result
  must still be observable somewhere above `console.error`, or a total failure looks identical to a
  quiet day. B-39 ran 8,160 successful cron invocations while sending nothing.
- Avoid `security definer` functions in exposed schemas. If a public RPC truly needs
  elevated privileges, keep its return shape minimal, set an explicit `search_path`, use
  fully qualified table names, grant only required roles, and document the reason in
  `docs/security.md`. Service-role-only internal RPCs (such as payment-link attempt claiming
  and settlement) use `security invoker` with `set search_path = ''` and are granted exclusively
  to `service_role`.
- Cumulative manual-refund records are monotonic: a stale write may repeat the current
  amount to correct metadata, but must never lower the recorded amount. Cancellation
  cleanup that must cover direct staff writes and every server path belongs in a
  narrowly scoped row trigger so it runs inside the same reservation transaction.
- Repricing bans on bookings with accommodation differences are enforced at the DB level
  via `prevent_repricing_with_accommodation_difference` (BEFORE UPDATE OF `total_price`
  ON `reservations`). Replacement billing operations in RPCs must lock previous active
  link rows and assert no attempts are `creating` or `pending` (or settled) before
  issuing a replacement.

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
