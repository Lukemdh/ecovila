# EcoVila — Developer README

EcoVila is a full-stack booking platform for a premium all-inclusive villa complex in
Orheiul Vechi, Moldova. It has two parts: a public website (`ecovila.md`) where guests
browse and book accommodation, and a staff CRM (`admin.ecovila.md`) where reservations,
pricing, photos, and daily operations are managed. The frontend is **vanilla
HTML/CSS/JS with no build step**; the backend is **Supabase** (Postgres + Auth +
Storage + RLS) with **Deno/TypeScript Edge Functions**.

> Note on layout: the deployable frontend (HTML/CSS/JS), the Supabase backend
> (`supabase/`), and the Node contract test suite (`tests/`) all live at the repository
> root. The `docs/` directory is documentation-only.

---

## Prerequisites

Verified versions present on the audit machine (2026-06-01):

| Tool | Version (verified) | Used for |
|------|--------------------|----------|
| Node.js | v24.14.1 | Running the frontend test suite (`node:test`, `.mjs`) |
| npm | 11.11.0 | Running root scripts |
| Deno | 2.6.5 | Edge Function runtime, typecheck, lint, and Deno tests |
| Supabase CLI | 2.101.0 | DB migrations and Edge Function deploy |

The root `package.json` is **scripts-only** (`npm test`, `npm run test:node`,
`npm run test:deno`) and has no dependencies, dev dependencies, build script, or npm
install step. The Supabase JS client is loaded in the browser from a CDN
(`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`). The Edge Functions resolve
`@supabase/supabase-js` via `npm:` through Deno's import map.

---

## Install

Nothing to install for the frontend — it is static files served directly. The root
`package.json` only documents test scripts; do not run `npm install` for normal local
work.

For the backend you need the Deno and Supabase CLI tools above. Edge Function
dependencies are resolved on demand by Deno (no vendoring committed).

---

## Environment setup

Frontend public config lives in `js/supabase-config.js` (committed): the Supabase
project URL and the **anon** JWT. The anon key is public by design (RLS enforces
access control) and is safe to commit.

The Edge Functions require server-side secrets, set as **Supabase Edge Function
secrets** (never committed, no `.env` in the repo). The committed root `.env.example`
lists the canonical names only, with blank values, so deployers can copy the shape
without exposing credentials. Canonical environment variable **names**:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (alias accepted: `SERVICE_ROLE_KEY`)
- `ECOVILA_CRON_SECRET` — shared secret for cron-triggered functions (`x-ecovila-secret` header or bearer)
- `ECOVILA_SITE_URL` (alias accepted: `SITE_URL`) — defaults to `https://ecovila.md`
- `ECOVILA_ALLOWED_ORIGINS` (optional, comma-separated) — CORS origin allowlist override; defaults to `https://ecovila.md`, `https://www.ecovila.md`, `https://admin.ecovila.md`, `null`, `http://localhost:3000`, `http://localhost:5173`, `http://127.0.0.1:3000`, and `http://127.0.0.1:5173`
- `SMSMD_API_TOKEN`, `SMSMD_FROM`, `SMSMD_API_URL` (URL optional; defaults to `https://api.sms.md/v1/send`)
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_API_URL` (URL optional; defaults to `https://api.resend.com/emails`)
- `MAIB_CLIENT_ID`, `MAIB_CLIENT_SECRET`, `MAIB_SIGNATURE_KEY`, `MAIB_BASE_URL`
- `MAIB_CALLBACK_URL` (optional; otherwise derived from `SUPABASE_URL` + `/functions/v1/maib-callback`)
- `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_GRAPH_API_VERSION` (optional; server-side Meta CAPI)
- `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_ACCESS_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`,
  `GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`,
  `GOOGLE_ADS_API_VERSION` (optional; server-side Google Ads conversion upload)

---

## Run / develop

The public site and CRM are plain static files. Serve the repository root with any
static file server and open the pages, e.g.:

```sh
# from the repository root — any static server works
python3 -m http.server 8080
# then open http://localhost:8080/          (Romanian landing page)
#            http://localhost:8080/ru/      (Russian landing page)
#            http://localhost:8080/en/      (English landing page)
#            http://localhost:8080/rezervari.html (booking)
#            http://localhost:8080/admin/      (CRM login)
```

Key pages: `index.html` (Romanian canonical homepage at `/`), `ru/index.html`,
`en/index.html`, `site.html` (legacy transition source redirected by `.htaccess`),
`rezervari.html` (booking), `checkout.html`, `confirmare.html`, `anulare.html`,
`politica-confidentialitate.html`, `termeni-conditii.html`, `admin/index.html`
(CRM login), `admin/dashboard.html` (CRM).

Local recovery material from the former PHP site is intentionally not committed:
`Archive.zip` and `docs/old php/` are ignored because the raw hosting backup contains
retired credentials and server artifacts. Committed old-content context lives in
`docs/old-content-inventory.md`.

---

## Build

There is **no build step** for the frontend. Files are deployed as-is to static
hosting (tophost.md, shared cPanel — no Node.js runtime). Edge Functions are deployed
through the Supabase CLI; they are not bundled locally.

---

## Test

One canonical command runs both suites from the repository root:

```sh
npm test
# → 205 Node + 48 Deno tests, all passing (2026-06-11)
```

The suites can also be run independently.

**Frontend / contract tests (Node):**
```sh
# from the repository root
npm run test:node
# equivalent: node --test 'tests/**/*.test.mjs'
# → 205 tests, 21 suites, all passing
```

**Edge Function tests (Deno):**
```sh
npm run test:deno
# equivalent: cd supabase/functions && deno task test
# → 48 tests, all passing
```

The task runs `deno test --allow-env --allow-net tests`; backend test files are named
`*.test.ts` so Deno discovers them from the `tests` directory.

**Typecheck (Deno):**
```sh
cd supabase/functions
deno check $(find . -name '*.ts' -not -path './tests/*')
# → passes, no type errors
```

**Lint (Deno):**
```sh
cd supabase/functions
deno lint
# → passes, no problems
```

**Format (Deno):**
```sh
cd supabase/functions
deno fmt --check
# -> passes
```

There is no linter or typechecker configured for the browser JS.

**Dependency/security audit notes:**
```sh
cd supabase/functions && deno outdated
# 2026-06-01: @supabase/supabase-js current 2.105.3, latest 2.106.2

npm audit --omit=dev --audit-level=moderate
# not available: npm returns ENOLOCK because the repo intentionally has no lockfile
```

See `docs/production-readiness-audit.md` for the full pre-production scan.

---

## Deployment

> 2026-06-11 production-readiness status: the Critical payment-flow findings
> (S-13/S-14/S-15, B-23..B-25) are fixed and **deployed to production** (migration +
> Edge Functions, verified live). The updated static site bundle in `dist/tophost/`
> still needs to be uploaded to TopHost. Remaining open items before/at launch:
> S-12 (High, SMS PII in URL), S-9/S-10 (Medium), B-10/B-11/B-12/B-13 — fix or get
> explicit owner acceptance. See the root `bugs.md` for the full 2026-06-11 fix log.

- **Frontend:** prepare the static upload folder with `npm run prepare:tophost`,
  then upload the contents of `dist/tophost/` to the tophost.md document root
  (usually `public_html`). This is a packaging step only: there is still no build
  and no server runtime. The script excludes project internals such as `docs/`,
  `tests/`, `supabase/`, and `.env`, removes stale files from `dist/tophost/`, and
  normalizes cPanel-safe permissions (`755` for directories, `644` for files).
  If files were already uploaded with restrictive permissions, fix them on the
  host with:
  ```sh
  find public_html -type d -exec chmod 755 {} \;
  find public_html -type f -exec chmod 644 {} \;
  ```
  (Brief Step 12 — not yet performed.)
  The upload includes `/`, `/ru/`, `/en/`, `robots.txt`, `sitemap.xml`, `llms.txt`,
  and `.htaccess`; `site.html` is not shipped as a duplicate production page and is
  redirected to `/` by the legacy map.
- **Database:** ⚠️ **never run a plain `supabase db push` against the production
  project** — the remote migration history uses different version IDs than the local
  files, so a push would re-run the foundation seed upserts and overwrite live
  `pricing_tiers` / reset `rooms.is_active` (ADR-023 in `docs/decisions.md`). Apply new
  migrations individually (management API query endpoint or psql) and record them in
  `supabase_migrations.schema_migrations`, or first reconcile history with
  `supabase migration repair`. B-11 also remains open: the Maib cleanup migrations call
  `cron.schedule`, but the migration set does not enable `pg_cron`.
- **Edge Functions:** deploy with the Supabase CLI from the repo root
  (`supabase functions deploy <name>`) per `supabase/config.toml` (which sets
  per-function `verify_jwt`). Set all Edge Function secrets listed above before invoking
  payment/notification/tracking functions. `create-reservation` enforces server-side
  price recomputation (`_shared/pricingGuard.ts`): after any change to `js/pricing.js`,
  copy it to `supabase/functions/_shared/pricing.js` (byte-identity is test-enforced),
  redeploy `create-reservation`, and promptly upload the static site so client quotes
  and the server guard stay in agreement.
- **Cron:** schedule `expire-cash-reservations` and `send-reminders` (and the Maib
  session-expiry cron added by migration) passing `ECOVILA_CRON_SECRET`. Both expect a
  frequent (~1-minute) cadence: the cash-expiry warning window is ~2 minutes wide, and
  `send-reminders` self-gates the daily arrival reminder to 10:00 Europe/Chisinau
  (`_shared/reminders.ts`) so guests are not messaged overnight.

See `docs/superpowers/plans/` and `docs/ECOVILA_PROJECT_BRIEF.md` for the
production rollout checklists (Steps 10–12).
