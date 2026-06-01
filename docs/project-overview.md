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
  SMS/email confirmations, and self-manage eligible online cancellations via a secure
  token + phone lookup.
- **Diana** (role `diana`) — full CRUD staff operator: reservations, pricing, holidays,
  photos, towels/daily counts, finance reporting.
- **Angela** (role `angela`) — read-only staff role (partly implemented).

## Core features and flows

- **Landing** (`site.html`): hero video, accommodation showcase, conference-room CTA
  (conference room is **not** bookable online — contact only), trilingual UI (RO/RU/EN).
- **Booking** (`rezervari.html`): adults/kids selector with child ages 1–17, date-range
  calendar, availability per accommodation type, room-number selection, sold-out states.
- **Checkout** (`checkout.html`): reservation summary, guest form, GDPR consent,
  cash-vs-card choice, creates a pending reservation. Card path routes to Maib (MIA for
  `+373` phones, hosted card Checkout otherwise — *inferred from* `js/checkout.js:80`).
- **Confirmation / management** (`confirmare.html`): cash countdown timer, one-time
  extension, online cancellation eligibility, and refund state for card bookings.
- **Cancellation** (`anulare.html`): token-based + phone-verified self-service
  cancellation only at least 7 calendar days before arrival or within 2 hours of
  creation; cash reimbursements are office-only.
- **Legal** (`politica-confidentialitate.html`, `termeni-conditii.html`): Moldova
  privacy/consumer content, Romanian-only body copy.
- **CRM** (`admin/dashboard.html`): tabbed dashboard — `dashboard` (reservation
  calendar + pending cash + add/search sidebar), `finance`, `daily` (reception),
  `towels`, `photos` (draft/publish to the public galleries), `pricing` (tiers +
  holidays with effective dates).

## Domain concepts / glossary

- **Accommodation types**: `small` (Căsuță Mică, rooms 1–8, min-bill 2 adults),
  `large` (Căsuță Mare, rooms 9–15, min-bill 3 adults), `hotel` (rooms 16–25, min-bill
  2 adults). 25 rooms total.
- **Minimum-occupancy billing**: each unit bills a floor of adults regardless of actual
  party; kids can be promoted to adult rate to fill the floor. Implemented in
  `js/pricing.js` (`calculateBillableGuests`, `normalizeParty`).
- **Child age tiers** (internal, not shown to guests): 1–3 free, 4–11 kid price, 12–17
  adult price but still counts as a child for capacity. See `js/pricing.js`
  (`FREE_CHILD_MAX_AGE`, `CHILD_FEE_MAX_AGE`).
- **Night-based pricing**: tiers 1 / 2 / 3+ nights × `weekday` | `holiday` day type.
  The tier is set by total nights; each night is premium if the next morning is
  Sat/Sun or a marked holiday. See `js/pricing.js` (`getNightsTier`, `getDayType`,
  `enumerateNights`, `calculateStayPrice`).
- **Holidays**: stored in DB (`holidays`); the night *before* a holiday is premium.
  Weekend nights are premium by hardcoded rule and are not listed as holidays.
- **Pricing effective dates**: `pricing_tiers` rows carry `effective_from`; a booking
  uses the newest row effective on/before its creation date. Existing reservations are
  never retro-repriced.
- **Cash hold**: cash reservations get `cash_expires_at`; expired holds are released by
  the `expire-cash-reservations` function. Guests may extend once (`cash_extended`).
- **Manage / cancellation tokens**: secure tokens (hashed in DB) let guests look up their
  own reservation without authentication. Online cancellation is blocked for cash
  reservations and for reservations outside the 7-day / 2-hour public window.

## External services / dependencies

| Service | Role | Where used |
|---------|------|------------|
| **Supabase** | Postgres DB, Auth, Storage, RLS, Edge Functions | everywhere |
| **@supabase/supabase-js@2** (CDN) | Browser DB/Auth client | every connected HTML page |
| **Maib** | Online payments (MIA for `+373`, hosted card Checkout otherwise) | `maib-*` Edge Functions, `js/checkout.js` |
| **SMS.md** | SMS notifications | `_shared/providers.ts`, `send-sms` |
| **Resend** | Email notifications | `_shared/providers.ts`, `send-email` |
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
            calendar, checkout, i18n)             sidebar, dashboard, finance, …)
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
                   │   maib-create-payment/-callback/     │
                   │   -refund, send-sms/-email/-reminders│
                   │   expire-cash-reservations           │
                   └───────┬───────────┬───────────┬──────┘
                           ▼           ▼           ▼
                         Maib       SMS.md       Resend
                    (payments)      (SMS)        (email)
```

Data flow (guest booking, simplified):
`rezervari.html` (availability via public RPC) → `checkout.html` →
`create-reservation` Edge Function inserts a pending reservation + cancellation token →
cash path waits on `cash_expires_at`; card path → `maib-create-payment` → Maib hosted
Checkout → `maib-callback` (HMAC-verified) confirms payment → confirmation SMS/email via
`send-sms` / `send-email`. Self-service management goes through
`reservation-lookup-start` / `reservation-lookup-verify` / `reservation-manage-details`
/ `reservation-cancel` (token + phone OTP + cancellation policy, all server-side).
CRM cancellations of paid Maib bookings call the staff-only `maib-refund` function and
can refund independently of the public guest window.

## Status (as of 2026-06-01)

Brief Steps 1–11 are implemented in code (landing, Supabase foundation, booking core,
booking page, checkout, confirmation/cancellation, Edge Functions, legal pages, CRM,
production notifications, Maib checkout). Step 12 (tophost deployment) and the live
provider/secret wiring are operational tasks not verifiable from the repo. The public
homepage is currently a **maintenance holding page** (`index.html`); the full landing
lives at `site.html`. Staff-only Edge Functions now validate bearer tokens through
Supabase Auth inside `requireStaffRole` before trusting `app_metadata.role`, in addition
to their `verify_jwt = true` gateway configuration.

The 2026-06-01 production-readiness audit found the automated checks green but marked
the project **not ready for production** until the open High/Medium items in
`docs/production-readiness-audit.md`, `docs/security.md`, and `docs/bugs.md` are fixed
or explicitly accepted. CRM stored-XSS hardening is fixed; the remaining main blockers
are legacy confirmation actions that authorize by reservation UUID only, public
security-definer RPC review, plaintext legacy cancellation tokens, server-side child-age
validation, and the Maib `pg_cron` migration assumption.
