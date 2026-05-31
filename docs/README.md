# EcoVila — Developer README

EcoVila is a full-stack booking platform for a premium all-inclusive villa complex in
Orheiul Vechi, Moldova. It has two parts: a public website (`ecovila.md`) where guests
browse and book accommodation, and a staff CRM (`admin.ecovila.md`) where reservations,
pricing, photos, and daily operations are managed. The frontend is **vanilla
HTML/CSS/JS with no build step**; the backend is **Supabase** (Postgres + Auth +
Storage + RLS) with **Deno/TypeScript Edge Functions**.

> Note on layout: this is an audit snapshot. The deployable frontend (HTML/CSS/JS) lives
> at the repository root. The Supabase backend and the test suite currently live under
> `docs/` (`docs/supabase/`, `docs/tests/`). This co-location is a known wrinkle — see
> `docs/bugs.md` and `docs/plan.md`.

---

## Prerequisites

Verified versions present on the audit machine (2026-05-31):

| Tool | Version (verified) | Used for |
|------|--------------------|----------|
| Node.js | v24.14.1 | Running the frontend test suite (`node:test`, `.mjs`) |
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
- `SUPABASE_SERVICE_ROLE_KEY` (alias accepted: `SERVICE_ROLE_KEY`)
- `ECOVILA_CRON_SECRET` — shared secret for cron-triggered functions (`x-ecovila-secret` header or bearer)
- `ECOVILA_SITE_URL` (alias accepted: `SITE_URL`) — defaults to `https://ecovila.md`
- `SMSMD_API_TOKEN`, `SMSMD_FROM`, `SMSMD_API_URL` (URL optional; defaults to `https://api.sms.md/v1/send`)
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_API_URL` (URL optional; defaults to `https://api.resend.com/emails`)
- `MAIB_CLIENT_ID`, `MAIB_CLIENT_SECRET`, `MAIB_SIGNATURE_KEY`, `MAIB_BASE_URL`
- `MAIB_CALLBACK_URL` (optional; otherwise derived from `SUPABASE_URL` + `/functions/v1/maib-callback`)

---

## Run / develop

The public site and CRM are plain static files. Serve the repository root with any
static file server and open the pages, e.g.:

```sh
# from the repository root — any static server works
python3 -m http.server 8080
# then open http://localhost:8080/site.html  (full landing page)
#            http://localhost:8080/index.html (current maintenance holding page)
#            http://localhost:8080/rezervari.html (booking)
#            http://localhost:8080/admin/      (CRM login)
```

Key pages: `index.html` (maintenance holding page — current live homepage),
`site.html` (full landing page), `rezervari.html` (booking), `checkout.html`,
`confirmare.html`, `anulare.html`, `politica-confidentialitate.html`,
`termeni-conditii.html`, `admin/index.html` (CRM login), `admin/dashboard.html` (CRM).

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
# → 171 Node + 32 Deno tests, all passing
```

The suites can also be run independently.

**Frontend / contract tests (Node):**
```sh
# from the repository root
npm run test:node
# equivalent: node --test 'docs/tests/**/*.test.mjs'
# → 171 tests, 17 suites, all passing
```

**Edge Function tests (Deno):**
```sh
npm run test:deno
# equivalent: cd docs/supabase/functions && deno task test
# → 32 tests, all passing
```

The task runs `deno test --allow-env --allow-net tests`; backend test files are named
`*.test.ts` so Deno discovers them from the `tests` directory.

**Typecheck (Deno):**
```sh
cd docs/supabase/functions
deno check $(find . -name '*.ts' -not -path './tests/*')
# → passes, no type errors
```

**Lint (Deno):**
```sh
cd docs/supabase/functions
deno lint
# → passes, no problems
```

There is no linter or typechecker configured for the browser JS.

---

## Deployment

- **Frontend:** copy the static files to tophost.md (shared cPanel). No build, no
  server runtime. (Brief Step 12 — not yet performed.)
- **Database:** apply migrations with the Supabase CLI
  (`supabase db push` against `docs/supabase/migrations/`).
- **Edge Functions:** deploy with the Supabase CLI from `docs/supabase/` per
  `docs/supabase/config.toml` (which sets per-function `verify_jwt`). Set all Edge
  Function secrets listed above before invoking payment/notification functions.
- **Cron:** schedule `expire-cash-reservations` and `send-reminders` (and the Maib
  session-expiry cron added by migration) passing `ECOVILA_CRON_SECRET`.

See `docs/superpowers/plans/` and `docs/ECOVILA_PROJECT_BRIEF.md` for the
production rollout checklists (Steps 10–12).
