# Production Readiness Audit — 2026-06-01

Scope: repository-wide source, docs, migrations, Edge Functions, static pages, tests,
security-sensitive flows, unused assets, and deployment assumptions. Step 16 later
updated application code to close the legacy UUID-only confirmation-actions blocker.
The 2026-06-03 SEO/AEO + tracking pass replaced the root maintenance page with the full
Romanian homepage, added `/ru/` and `/en/`, and added consent-gated server-side
conversion tracking.

## Readiness verdict

**Not production-ready yet.** The automated suites are green, and Steps 15-16 fixed the
open High blockers, but Medium production blockers still need to be fixed or explicitly
accepted before public launch:

| Area | Verdict | Evidence |
|------|---------|----------|
| Test suite | Green | `npm test` -> 188 Node + 38 Deno tests pass on 2026-06-03 |
| Deno lint/type/format | Green | `deno lint`, `deno check`, `deno fmt --check` pass |
| Static local references | Green | Root, `/ru/`, `/en/`, booking, CRM, legal, and required assets are covered by tests |
| Local static serving | Green | `index.html`, `site.html`, `rezervari.html`, `admin/`, hero MP4 return HTTP 200 locally |
| Secret scan | Mostly clean | Regex scan found only the intended public Supabase anon JWT |
| Security hardening | Blocked | S-9 and S-10 remain open |
| Deployment migrations | Blocked | B-11: Maib cron migration assumes `pg_cron`/`cron` exists |
| CRM daily operations | Green | B-14 fixed: daily lists show only paid, non-cancelled reservations |
| Production content/assets | Partly ready | Root homepage is now live content; placeholder SVG photos remain fallback public imagery |
| Privacy/compliance | Blocked | S-12: SMS provider URL-query PII remains open and out of scope for SEO/tracking work |
| Dependency audit | Incomplete | `npm audit` cannot run without a lockfile; Deno dependency is slightly behind latest |

## Commands run

```sh
npm test
# 188 Node tests + 38 Deno tests passed after the 2026-06-03 SEO/tracking pass

cd supabase/functions && deno lint
# Checked 31 files after the 2026-06-03 SEO/tracking pass

cd supabase/functions && deno check $(find . -name '*.ts' -not -path './tests/*')
# exit 0

cd supabase/functions && deno fmt --check
# Checked 30 files after Step 16

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
- 2026-06-03 focused tracking scan: browser assets contain no Meta CAPI / Google Ads /
  service-role secrets; new tracking code does not place raw phone/email/message values
  into URLs.

## Production blocker tracking

### 1. Legacy confirmation RPCs were UUID-only — fixed 2026-06-01

Formerly, `confirmare.html?id=<reservation_id>` used
`get_pending_reservation_status`, `extend_cash_reservation`, and
`cancel_pending_reservation` through `js/supabase.js`. The SQL functions were granted to
`anon`/`authenticated` and authorized only by reservation UUID. UUID guessing was
unlikely, but any leaked confirmation URL could extend or cancel a pending reservation
without the newer manage token.

Status: fixed in Step 16. `create-reservation` now creates a hashed manage token,
confirmation links require `id` + `manage`, status/extension/cancellation use
token-backed Edge Functions, and
`20260601173901_require_manage_token_confirmation_actions.sql` drops the legacy RPC
signatures.

### 2. CRM renders guest-controlled fields through `innerHTML` — fixed 2026-06-01

Formerly, the CRM calendar, dashboard, sidebar search, and daily reception cards
interpolated reservation names/phones/labels into template strings. Guest names were not
normalized or escaped server-side, so a public booking could persist markup that
executed when staff viewed the CRM.

Status: fixed in Step 15. `EcoVilaCrmCalendar.escapeHtml` now guards the affected CRM
template renderers, public guest names with `<` or `>` are rejected server-side, and
Node/Deno regression tests cover the malicious payload.

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

### 7. Daily reception includes non-confirmed reservations — fixed 2026-06-02

`admin/js/crm-daily.js` formerly built the `Situația zilnică` check-in/check-out lists
from all reservation rows returned by `fetchAdminReservations` for the selected date
window. Because the daily view applied only date and search filters, pending holds and
cancelled rows could appear in the reception workflow. Confirmed means
`payment_status = 'paid'` with `cancelled_at is null` **(inferred)**; the database has
no literal `confirmed` status.

Status: fixed in the B-14 off-plan fix. Daily check-in/check-out derivation now filters
to paid, non-cancelled rows before fetching daily status records or rendering cards,
without globally tightening the shared staff reservation fetcher.

### 8. SMS provider URL-query PII remains open

The SMS.md provider call passes phone/message/token in a request URL query string. This
violates the no-PII-in-URLs constraint and Legea 195/2024. The owner explicitly kept it
out of scope for the SEO/tracking work, so it is tracked as S-12 and standalone Step 20.

Next step: confirm whether SMS.md supports POST request bodies. If yes, move the
payload out of the URL; if no, ensure the full provider URL is never written to logs.

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
- Confirmation-page status, cash extension, and guest cancellation now require a manage
  token; a bare reservation ID is no longer enough to act on a booking.
- Guest cancellation/refund policy is enforced server-side in the newer Edge Function
  flow.
- Root homepage decision is resolved: Romanian is canonical at `/`, with `/ru/` and
  `/en/`; no `/ro/` duplicate exists.
- Consent-gated conversion tracking stores server-side secrets only in Edge Function
  environment variables and hashes user match data before provider payloads.

## Recommended next sequence

1. Fix B-11/S-9 before applying migrations to production: confirm extension posture and
   reduce exposed security-definer surface.
2. Migrate S-10 legacy cancellation links to hashed token lookup.
3. Fix B-10 and add server-side contract tests for public booking payload constraints.
4. Fix S-12 SMS URL-query PII as a separate privacy/compliance task.
5. Pin/review Supabase JS and replace placeholder public imagery.
