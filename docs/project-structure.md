# Project Structure — EcoVila

Audit snapshot of the repository (excluding `node_modules`, build artifacts, large
binaries, and gitignored `.superpowers/` / `.claude/`). 169 files are tracked in git
after the 2026-05-31 CORS hardening cleanup.

## Annotated tree

```
ecovila/
├── index.html                  # CURRENT live homepage: maintenance "în curând" holding page
├── site.html                   # Full landing page (reachable directly; not linked from index.html)
├── rezervari.html              # Booking page (party + dates + accommodation + room selection)
├── checkout.html               # Checkout: summary, guest form, GDPR, cash/card
├── confirmare.html             # Confirmation + manage: cash countdown, extend, online cancel, refund
├── anulare.html                # Token + phone self-service cancellation policy
├── politica-confidentialitate.html  # Privacy policy (legal)
├── termeni-conditii.html       # Terms & conditions (legal)
├── design.md                   # Design language reference (palette, type, components)
├── package.json                # Dependency-free npm scripts for Node + Deno tests
├── favicon.ico
├── .env.example                # Blank Edge Function secret-name template (safe to commit)
├── ecovilavideo.mp4            # Unreferenced owner-retained video asset (~14MB; see bugs.md)
├── ecovilavideo-web.mp4        # Unreferenced owner-retained video asset (~21MB; see bugs.md)
├── .gitignore
│
├── assets/                     # Static media
│   ├── logo.png, logoNT.png    # logo.png = header, logoNT.png = footer
│   ├── logo_small.png          # Unreferenced owner-retained logo asset (see bugs.md)
│   ├── apple-touch-icon.png, favicon-16x16.png, favicon-32x32.png
│   ├── videos/ecovila-hero.mp4 # Hero video used by site.html (~3.8MB)
│   └── photos/                 # Placeholder SVGs + hero poster, grouped by area
│
├── css/
│   ├── main.css                # Landing + shared header/footer/language UI
│   ├── booking.css             # rezervari.html
│   ├── checkout.css            # checkout.html
│   ├── confirmation.css        # confirmare.html + anulare.html
│   ├── legal.css               # legal pages
│   └── crm.css                 # admin CRM
│
├── js/                         # Browser JS (UMD-style wrapper: window global + CommonJS for tests)
│   ├── supabase-config.js      # Frozen config: Supabase URL + PUBLIC anon key
│   ├── supabase.js             # Data layer: ~40 helpers wrapping supabase-js + Edge Functions
│   ├── pricing.js              # Pricing, billing floors, date/night/holiday logic (pure)
│   ├── calendar.js             # Calendar/date-range rendering (shared: booking + CRM)
│   ├── translations.js         # RO/RU/EN i18n strings
│   ├── main.js                 # Shared: header, language switcher, landing behaviors
│   ├── booking.js              # rezervari.html controller (largest frontend file, 1348 lines)
│   ├── checkout.js             # checkout.html controller (incl. Maib rail routing)
│   ├── confirmare.js           # confirmare.html controller
│   └── anulare.js              # anulare.html controller
│
├── admin/                      # Staff CRM (admin.ecovila.md)
│   ├── index.html              # CRM login (Supabase Auth)
│   ├── dashboard.html          # CRM shell; tabs: dashboard/finance/daily/towels/photos/pricing
│   └── js/
│       ├── crm-app.js          # Orchestrator: wires tabs, requires session, inits modules
│       ├── crm-auth.js         # Supabase Auth login + role/session gating
│       ├── crm-calendar.js     # Reservation calendar (rows 1–25)
│       ├── crm-sidebar.js      # Add/search reservation sidebar
│       ├── crm-dashboard.js    # Dashboard tab (calendar + pending cash)
│       ├── crm-finance.js      # Finance reporting tab
│       ├── crm-daily.js        # Daily reception/operations tab
│       ├── crm-towels.js       # Towel/daily guest counts tab
│       ├── crm-photos.js       # Photo draft/publish to public galleries
│       └── crm-pricing.js      # Pricing tiers + holidays editor
│
└── docs/                       # Documentation + (currently) backend code + tests
    ├── AGENTS.md               # Standing agent rules (this audit)
    ├── README.md, project-*.md, security.md, bugs.md, plan.md, decisions.md, conventions.md
    ├── ECOVILA_PROJECT_BRIEF.md# Authoritative product/business spec
    ├── politica-confidentialitate.md, termeni-conditii.md  # Legal source copy (RO)
    ├── superpowers/
    │   ├── plans/              # Per-step implementation plans (10 files)
    │   └── specs/             # Per-step design specs (9 files)
    ├── tests/                  # Node node:test contract/unit suites (15 *.test.mjs)
    └── supabase/
        ├── config.toml         # Per-function verify_jwt settings
        ├── migrations/         # 23 timestamped SQL migrations (20260506 → 20260531)
        └── functions/          # Deno/TypeScript Edge Functions
            ├── deno.json, import_map.json, deno.lock
            ├── _shared/        # cors, env, http, maib, notifications, providers,
            │                   #   reservationManage, reservations, supabaseAdmin
            ├── create-reservation/, confirm-reservation-payment/
            ├── expire-cash-reservations/, send-reminders/, send-sms/, send-email/
            ├── maib-create-payment/, maib-callback/, maib-refund/
            ├── reservation-lookup-start/, reservation-lookup-verify/
            ├── reservation-manage-details/, reservation-cancel/
            └── tests/          # Deno tests (cors.test.ts, maib.test.ts, reservation-manage.test.ts, reservations.test.ts)
```

## Significant files / folders — responsibilities

| Path | Responsibility |
|------|----------------|
| `index.html` | Live homepage — maintenance holding page only (intentional; covered by a test). |
| `site.html` | Full marketing landing page; directly reachable, not linked from `index.html`. |
| `rezervari.html` + `js/booking.js` | Booking UI and controller; availability, party, room selection. |
| `checkout.html` + `js/checkout.js` | Checkout UI; builds reservation, picks Maib rail by phone country code. |
| `confirmare.html` + `js/confirmare.js` | Post-booking state: cash timer, extend, online cancellation eligibility, refund display. |
| `anulare.html` + `js/anulare.js` | Token + phone self-service cancellation with 7-day / 2-hour and cash-office rules. |
| `js/pricing.js` | Pure pricing/billing/date engine. Shared by frontend + CRM + Node tests. |
| `js/calendar.js` | Shared calendar/date logic (booking page + CRM calendar). |
| `js/supabase.js` | All DB reads/writes and Edge Function calls from the browser, including staff Maib refund calls. |
| `js/supabase-config.js` | Supabase URL + public anon key (frozen object). |
| `js/translations.js` | RO/RU/EN string tables consumed via `data-i18n`. |
| `js/main.js` | Shared header, sticky behavior, language switching. |
| `admin/js/crm-app.js` | CRM bootstrap: session gate, tab wiring, module init with shared context. |
| `admin/js/crm-*.js` | One module per CRM concern (calendar, sidebar, dashboard, finance, daily, towels, photos, pricing, auth). |
| `docs/supabase/functions/_shared/` | Cross-function helpers: CORS, env, HTTP/auth, Maib, notifications, providers, reservation logic, admin client. |
| `docs/supabase/functions/*/index.ts` | One HTTP entrypoint per Edge Function. |
| `docs/supabase/migrations/` | DB schema evolution; apply in filename order. |
| `docs/supabase/config.toml` | Declares which functions require a verified JWT. |
| `docs/tests/*.test.mjs` | Node contract/behavior tests (require browser JS via CommonJS shim). |
| `docs/supabase/functions/tests/*.ts` | Deno unit tests for shared backend logic. |
| `package.json` | Scripts-only test manifest (`npm test`, `test:node`, `test:deno`); no dependencies or build step. |
| `docs/ECOVILA_PROJECT_BRIEF.md` | Authoritative business/product spec. |
| `docs/superpowers/plans|specs/` | Historical per-step planning/design records. |

## Module loading model

Browser JS uses a UMD-style IIFE wrapper (e.g. `js/pricing.js:1`): it assigns a global
(`window.EcoVilaPricing`, `EcoVilaSupabase`, `EcoVilaCrmApp`, …) and, when `module.exports`
exists, also exports for CommonJS so `docs/tests/*.test.mjs` can `require()` the same
file. HTML pages load scripts in dependency order via `<script>` tags (supabase-js CDN →
`supabase-config.js` → `supabase.js` → feature scripts). No bundler, no ES modules.

## Main data flow (request → render)

1. A page loads supabase-js (CDN) + `supabase-config.js` + `supabase.js`, establishing
   a browser Supabase client with the anon key.
2. Read paths call public RPCs / RLS-guarded selects via `js/supabase.js`
   (`fetchRooms`, `fetchPricingTiers`, `fetchHolidays`, `fetchAvailabilityBlocks`, …).
3. `js/pricing.js` computes billable guests and stay price client-side for display.
4. Mutations (create reservation, cancel, refund, lookup) call Edge Functions through
   `js/supabase.js`, which enforce server-side rules, talk to Maib/SMS.md/Resend, and
   write with the service-role client (`_shared/supabaseAdmin.ts`). Guest cancellation is
   also enforced by the latest `cancel_reservation_by_token` RPC for legacy token links.
5. CRM pages additionally authenticate via Supabase Auth (`crm-auth.js`) and gate UI by
   role (`diana` full CRUD, `angela` read-only).

## Inferred / uncertain items

- The exact `js/checkout.js` Maib rail decision (`mia` vs `card`) is read from
  `js/checkout.js:80`; the downstream Maib behavior is **inferred** from function names
  and tests, not exhaustively traced.
- `assets/logo_small.png` and the two root `*.mp4` files appear unused (no references
  found) but are owner-retained per the 2026-05-31 Step 6 decision in `docs/bugs.md`.
- The placement of backend code and tests under `docs/` (rather than a top-level
  `supabase/` and `tests/`) is unusual; intent is **Unknown — needs owner input**.
