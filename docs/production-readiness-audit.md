# Production Readiness Audit — 2026-06-01

Scope: repository-wide source, docs, migrations, Edge Functions, static pages, tests,
security-sensitive flows, unused assets, and deployment assumptions. This pass changed
documentation only; no application code was modified.

## Readiness verdict

**Not production-ready yet.** The automated suites are green, but the manual audit found
open High/Medium blockers that should be fixed before public launch:

| Area | Verdict | Evidence |
|------|---------|----------|
| Test suite | Green | `npm test` -> 171 Node + 36 Deno tests pass |
| Deno lint/type/format | Green | `deno lint`, `deno check`, `deno fmt --check` pass |
| Static local references | Green | 10 HTML files checked; all local `href`/`src`/`poster` targets exist |
| Local static serving | Green | `index.html`, `site.html`, `rezervari.html`, `admin/`, hero MP4 return HTTP 200 locally |
| Secret scan | Mostly clean | Regex scan found only the intended public Supabase anon JWT |
| Security hardening | Blocked | S-7, S-8, S-9, S-10 remain open |
| Deployment migrations | Blocked | B-11: Maib cron migration assumes `pg_cron`/`cron` exists |
| Production content/assets | Not ready | Placeholder SVG photos remain the fallback public imagery |
| Dependency audit | Incomplete | `npm audit` cannot run without a lockfile; Deno dependency is slightly behind latest |

## Commands run

```sh
npm test
# 171 Node tests + 36 Deno tests passed

cd supabase/functions && deno lint
# Checked 27 files

cd supabase/functions && deno check $(find . -name '*.ts' -not -path './tests/*')
# exit 0

cd supabase/functions && deno fmt --check
# Checked 29 files

cd supabase/functions && deno outdated
# npm:@supabase/supabase-js current 2.105.3, latest 2.106.2

npm audit --omit=dev --audit-level=moderate
# failed with ENOLOCK because the repo intentionally has no npm lockfile
```

Additional manual/static checks:

- Local HTML reference checker: all local links/assets in 10 HTML files exist.
- Local static server HEAD checks: `index.html`, `site.html`, `rezervari.html`,
  `admin/`, and `assets/videos/ecovila-hero.mp4` returned HTTP 200.
- Secret-pattern scan: no service-role/API-key pattern found outside expected code/env
  names; the committed anon JWT in `js/supabase-config.js` is intentional.
- Supabase docs/changelog spot-check: current docs still warn that exposed-schema RLS
  tables require RLS, views bypass RLS unless `security_invoker`, and
  security-definer functions should not be created in exposed schemas.

## Open production blockers

### 1. Legacy confirmation RPCs are UUID-only

`confirmare.html?id=<reservation_id>` still uses
`get_pending_reservation_status`, `extend_cash_reservation`, and
`cancel_pending_reservation` through `js/supabase.js`. The SQL functions are granted to
`anon`/`authenticated` and authorize only by reservation UUID. UUID guessing is unlikely,
but any leaked confirmation URL can extend or cancel a pending reservation without the
newer manage token.

Track as: B-8 / S-7. Next step: move these actions behind a manage token or signed
one-time token, then deprecate the UUID-only RPCs.

### 2. CRM renders guest-controlled fields through `innerHTML`

The CRM calendar, dashboard, sidebar search, and daily reception cards interpolate
reservation names/phones/labels into template strings. Guest names are not normalized or
escaped server-side, so a public booking can persist markup that executes when staff
views the CRM.

Track as: B-9 / S-8. Next step: add a shared escape/DOM-rendering pattern, use
`textContent` for guest fields, and add XSS regression tests.

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
- Guest cancellation/refund policy is enforced server-side in the newer Edge Function
  flow.

## Recommended next sequence

1. Fix B-9/S-8 first: CRM stored-XSS risk is the highest-impact staff-facing issue.
2. Fix B-8/S-7 and S-10 together: align all guest management around hashed/signed
   tokens, then remove or lock down legacy UUID-only RPCs.
3. Fix B-11/S-9 before applying migrations to production: confirm extension posture and
   reduce exposed security-definer surface.
4. Fix B-10 and add server-side contract tests for public booking payload constraints.
5. Pin/review Supabase JS, replace placeholder public imagery, and decide whether the
   maintenance `index.html` is still the desired launch homepage.
