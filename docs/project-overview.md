# Project Overview — EcoVila

## What it is

EcoVila is a booking platform for a premium all-inclusive villa complex in Orheiul
Vechi, Moldova. Source of truth for the product spec is `docs/ECOVILA_PROJECT_BRIEF.md`
(read it for full detail); this document summarizes and cross-references the actual
code.

The product has two surfaces:

1. **Public website** (`ecovila.md`) — a forest/rustic-luxury landing page plus a
   guest-facing booking, checkout, confirmation, and self-service cancellation flow.
2. **Staff CRM** (`admin.ecovila.md`) — a desktop dashboard for staff (primarily
   "Diana") to manage reservations, pricing, holidays, photos, and daily reception
   operations.

## Target users

- **Guests** — book accommodation, pay by cash (hold) or card (Maib online), receive
  SMS/email confirmations, self-manage eligible online cancellations via a secure
  token + phone lookup, and pay standalone payment links (`plata.html?p=<uuid>`).
- **Diana** (role `diana`) — full CRUD staff operator: reservations, accommodation
  moves, pricing, holidays, photos, towels/daily counts, finance reporting, and
  minting/managing payment links.
- **Angela** (role `angela`) — read-only staff role (partly implemented; blocked from payment links).

## Core features and flows

- **Landing** (`/`, `/ru/`, `/en/`): static localized homepages with self canonicals,
  reciprocal hreflang, hero video, accommodation showcase, and conference-room CTA
  (conference room is **not** bookable online — contact only). Former PHP/DB content
  was inventoried for ranking protection, but dated hardcoded pricing/access blocks are
  intentionally not shown on the public homepage.
- **Booking** (`rezervari.html`): adults/kids selector with child ages 1–17, date-range
  calendar, availability per accommodation type, room-number selection, sold-out states.
- **Checkout** (`checkout.html`): reservation summary, guest form, GDPR consent,
  cash-vs-card choice, creates a pending reservation. Card path routes to Maib (MIA for
  `+373` phones, hosted card Checkout otherwise — *inferred from* `js/checkout.js:80`).
- **Confirmation / management** (`confirmare.html`): token-backed cash countdown timer
  (shown only while a cash hold is pending), one-time extension, pending-cash
  cancellation, online cancellation eligibility, and refund state for card bookings. The
  managed view renders only the panel matching the actual payment type/status; after a
  Maib card redirect it recovers `id`/`manage` from the pending-reservation localStorage
  record when the gateway drops those query params.
- **Cancellation** (`anulare.html`): token-based + phone-verified self-service
  cancellation only at least 7 calendar days before arrival or within 2 hours of
  creation; cash reimbursements are office-only.
- **Standalone payment links** (`plata.html`): single-use payment link (`plata.html?p=<uuid>`)
  for deposits, events, and off-platform payments, independent of reservations (no booking
  creation, no room inventory changes, no `Purchase` event). Provider sessions (MIA QR or
  hosted card checkout) are minted lazily on "Plătește"; status updates re-read MAIB authoritatively.
- **Accommodation moves + optional difference links** (CRM): Diana can drag a
  single-villa calendar card to a free accommodation of another type or choose the
  exact source/destination in the reservation dialog for multi-villa bookings. The
  move may carry an optional hand-typed MIA/card difference link and an opt-in guest
  SMS (off by default). Paid differences remain separate from the immutable booking
  base and are shown as an effective total in staff views.
- **Legal** (`politica-confidentialitate.html`, `termeni-conditii.html`): Moldova
  privacy/consumer content, Romanian-only body copy.
- **CRM** (`admin/dashboard.html`): tabbed dashboard — `dashboard` (reservation
  calendar + pending cash + add/search sidebar, double-confirm reservation deletion,
  MAIB refund-first cancellation for paid card groups, and scroll-preserving rolling
  month navigation), `finance` (revenue reporting, with a one-day `Încasări` view that
  also lists villas booked/created that day, plus payment-link income folded into Online
  and a separate "Plăți din linkuri" section), `payment-links` (Diana-only tab to mint
  MIA/card standalone links with amount in MDL, optional label, and optional 1h/3h/8h expiry,
  copy/open URLs, revoke active links, and record portal-executed refunds), `daily` (reception),
  `towels`, `photos` (draft/publish to the public galleries), `pricing` (tiers + holidays with
  effective dates, plus a read-only **Program** sub-view listing each price timeframe — `DD.MM.YYYY
  – DD.MM.YYYY` ranges derived from `effective_from` boundaries — so staff can see when a
  scheduled change overwrites the current tariff; ADR-040).

## Domain concepts / glossary

- **Accommodation types**: `small` (Căsuță Mică, rooms 1–8, min-bill 2 adults),
  `large` (Căsuță Mare, rooms 9–15, min-bill 3 adults), `hotel` (rooms 16–25, min-bill
  2 adults). 25 rooms total.
- **Minimum-occupancy billing**: each unit bills a floor of adults regardless of actual
  party; kids can be promoted to adult rate to fill the floor. Implemented in
  `js/pricing.js` (`calculateBillableGuests`, `normalizeParty`).
- **Child age tiers** (internal, not shown to guests): 1–2 free, 3–11 kid price, 12–17
  adult price but still counts as a child for capacity. See `js/pricing.js`
  (`FREE_CHILD_MAX_AGE`, `CHILD_FEE_MAX_AGE`).
- **Night-based pricing**: tiers 1 / 2 / 3+ nights × `weekday` | `holiday` day type.
  The tier is set by total nights; each night is premium if the next morning is
  Sat/Sun or a marked holiday. See `js/pricing.js` (`getNightsTier`, `getDayType`,
  `enumerateNights`, `calculateStayPrice`).
- **Holidays**: stored in DB (`holidays`) as recurring month-day rules (the stored year
  is ignored); the night *before* a holiday is premium. Weekend nights are premium by
  hardcoded rule and are not listed as holidays. Holiday fetches must never be
  date-range-filtered.
- **Server-authoritative totals** (since 2026-06-11): the browser quote is advisory.
  `create-reservation` recomputes the booking total server-side
  (`supabase/functions/_shared/pricingGuard.ts`, using `_shared/pricing.js` — a
  byte-identical, test-enforced copy of `js/pricing.js`) and rejects mismatches with
  HTTP 409; direct anon inserts into `reservations` are revoked; the MAIB callback
  reconciles the captured amount before marking a booking paid.
- **Pricing effective dates**: `pricing_tiers` rows carry `effective_from`; a booking
  uses the newest row effective on/before its creation date. Existing reservations are
  never retro-repriced.
- **Cash hold**: cash reservations get `cash_expires_at`; expired holds are released by
  the `expire-cash-reservations` function. Guests may extend once (`cash_extended`).
- **Manage / cancellation tokens**: secure tokens (hashed in DB) let guests open or look
  up their own reservation without authentication. Confirmation links now require a
  short-lived manage token for pending status, cash extension, and cancellation actions.
  Paid cash reservations remain office-only for reimbursement; paid card cancellation is
  limited by the 7-day / 2-hour public window.
- **Standalone payment links** (`payment_links`, `payment_link_attempts`): single-use links
- **Payment links** (`payment_links`, `payment_link_attempts`): single-use links keyed
  by a plain UUID bearer ID in the URL (`?p=<uuid>`). `purpose = 'standalone'` covers
  arbitrary deposits/events/bills; `purpose = 'accommodation_difference'` binds a
  typed move difference to the destination room-type snapshot and reservation. The
  MAIB provider session is minted lazily on "Plătește". Money captured always wins
  (late capture after expiry/revoke settles as paid and flags `manual_review`).
  Offline/portal refunds are recorded (*Marchează ca restituit*) to keep Finance net
  figures accurate without moving funds.
- **Effective booking total:** `reservations.total_price` remains the original booking
  base. Staff money views add the net paid accommodation-difference links bound to the
  booking's live rows; unpaid links remain a separate warning. Guest-facing totals stay
  at the base, matching paid add-guests differences.

## External services / dependencies

| Service | Role | Where used |
|---------|------|------------|
| **Supabase** | Postgres DB, Auth, Storage, RLS, Edge Functions | everywhere |
| **@supabase/supabase-js@2** (CDN) | Browser DB/Auth client | every connected HTML page |
| **Maib** | Online payments (MIA for `+373`, hosted card Checkout otherwise; payment links) | `maib-*`, `payment-link-*` Edge Functions, `js/checkout.js`, `js/plata.js` |
| **SMS.md** | SMS notifications | `_shared/providers.ts`, `send-sms` |
| **Resend** | Email notifications | `_shared/providers.ts`, `send-email` |
| **Meta Pixel / CAPI** | Consent-gated browser + server conversion tracking | `js/tracking.js`, `track-event`, `_shared/tracking.ts` |
| **Google tag / Ads API** | Consent-gated analytics/conversion tracking | `js/tracking.js`, `_shared/tracking.ts` |
| **tophost.md** | Static hosting (cPanel, no Node) for the frontend | deployment target |
| **Google Fonts** | Cormorant Garamond + Montserrat | page `<head>`s |

## High-level architecture

```
                 Guest browser                         Staff browser
            (ecovila.md static pages)             (admin.ecovila.md static pages)
                     │                                      │
   loads supabase-js from CDN + js/supabase-config.js (anon key)
                     │                                      │
            js/*.js (booking, pricing,            admin/js/crm-*.js (calendar,
            calendar, checkout, plata, i18n)      sidebar, dashboard, finance,
                     │                            payment-links, …)
                     │                                      │
                     └──────────────┬───────────────────────┘
                                    ▼
                   ┌─────────────────────────────────────┐
                   │            SUPABASE                  │
                   │  Postgres + RLS (anon / diana /      │
                   │  angela roles)  •  Auth  •  Storage  │
                   │  Edge Functions (Deno/TS):           │
                   │   create-reservation, confirm-…,     │
                   │   reservation-lookup/-manage/-cancel,│
                   │   reservation-extend-cash,            │
                   │   maib-create-payment/-callback/     │
                   │   -refund, maib-mia-callback,        │
                   │   payment-link-admin,                │
                   │   payment-link-public,               │
                   │   reservation-accommodation-move,    │
                   │   send-sms/-email/-reminders,        │
                   │   track-event,                       │
                   │   expire-cash-reservations           │
                   └───────┬───────────┬───────────┬──────┘
                           ▼           ▼           ▼
                         Maib       SMS.md       Resend
                    (payments)      (SMS)        (email)
```

Data flows:
1. **Guest booking (simplified):** `rezervari.html` (availability via public RPC) → `checkout.html` →
`create-reservation` Edge Function inserts a pending reservation + cancellation token +
hashed manage token → cash path redirects to `confirmare.html?id=…&manage=…`; card path
passes the manage token to `maib-create-payment` so Maib success/failure URLs return to
the same token-backed confirmation page → `maib-callback` (HMAC-verified) confirms
payment → confirmation SMS/email via `send-sms` / `send-email`. Self-service management
goes through `reservation-lookup-start` / `reservation-lookup-verify` /
`reservation-manage-details` / `reservation-extend-cash` / `reservation-cancel` (token +
phone OTP where needed + cancellation policy, all server-side).
CRM cancellations of paid Maib bookings call the staff-only `maib-refund` function and
can refund independently of the public guest window. Consent-gated browser tracking
shares a generated `tracking_event_id` with reservation rows; payment confirmation
functions emit server-side `Purchase` with `value` and `currency: MDL`, deduped by that
event ID.

2. **Standalone payment link (ADR-106):** Diana creates link via `payment-link-admin` (Diana-only,
amount in MDL, MIA/card rail, optional label/expiry) → Diana copies and sends `plata.html?p=<uuid>` →
payer opens `plata.html` → `payment-link-public` action `status` loads public details (coarse status,
amount, rail, label, expiry) → payer clicks "Plătește" (`payment-link-public` action `start`) to lazily
mint a provider session (`claim_payment_link_attempt`) → card redirects to MAIB Checkout / MIA displays
live QR → MAIB callback (`maib-callback` or `maib-mia-callback`) or client polling triggers
`settle_payment_link_attempt` RPC → payment confirmed on `plata.html` and reflected in CRM / Finance.

3. **Accommodation move + difference (ADR-107):** Diana selects one reservation row
and a free target room in the calendar/dialog → `reservation-accommodation-move`
derives the booking group, validates the Diana token, and calls
`move_reservation_accommodation` → PostgreSQL locks the reservation, mutable target room,
and any prior link, rejects stale/pending-change states or live provider attempts, moves the
row and optionally inserts an `accommodation_difference` link atomically → Diana copies the
canonical `ECOVILA_SITE_URL` payment URL; an explicitly checked SMS is attempted after commit.
Settlement still uses ADR-106 unchanged. Finance treats the bound link like a paid
`reservation_changes` difference, while cancellation revokes open links by trigger and
flags settled money for a separate manual portal refund. Repricing while a bound difference exists
is strictly blocked by database trigger `prevent_repricing_with_accommodation_difference`.

## Status (as of 2026-08-27)

Brief Steps 1–11 are implemented in code (landing, Supabase foundation, booking core,
booking page, checkout, confirmation/cancellation, Edge Functions, legal pages, CRM,
production notifications, Maib checkout). Step 12 (tophost deployment) and the live
provider/secret wiring are operational tasks not verifiable from the repo. The public
homepage is now the full Romanian landing page at `/`; Russian and English are static
localized pages at `/ru/` and `/en/`; `site.html` is a local transition source covered
by a 301 rule. Staff-only Edge Functions now validate bearer tokens through
Supabase Auth inside `requireStaffRole` before trusting `app_metadata.role`, in addition
to their `verify_jwt = true` gateway configuration.

The 2026-06-01 production-readiness audit found the automated checks green but marked
the project **not ready for production** until the open Medium items in
`docs/production-readiness-audit.md`, `docs/security.md`, and `docs/bugs.md` are fixed
or explicitly accepted. CRM stored-XSS hardening and UUID-only confirmation actions are
fixed; the remaining main blockers are public security-definer RPC review, plaintext
legacy cancellation tokens, server-side child-age validation, the Maib `pg_cron`
migration assumption, dependency/version posture, and production content/asset readiness.

ADR-106 and ADR-107 are now built, reviewed, and green locally (`npm test`: 426 Node +
202 Deno; Deno lint/format clean). They remain entirely undeployed. The required order
is the ADR-106 migration, then the ADR-107 binding migration, then the seven affected
Edge Functions, then the `?v=2026082702` TopHost bundle; the final upload also carries
the pending ADR-105 frontend.
