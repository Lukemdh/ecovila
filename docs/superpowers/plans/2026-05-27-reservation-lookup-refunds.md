# Reservation Lookup And Refunds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let guests securely look up an existing reservation by phone, open the confirmation page, cancel the full booking group, and trigger MAIB refunds when the server-side refund window allows it.

**Architecture:** Add short-lived SMS lookup codes and manage tokens stored server-side. All private reservation lookup, cancellation, and refund decisions happen in Supabase Edge Functions using the service role; browser code only invokes functions and renders returned summaries.

**Tech Stack:** Static HTML/CSS/JS, Supabase Edge Functions on Deno, Postgres migrations, SMSMD provider, MAIB Checkout refund API.

---

### Task 1: Failing Contract Tests

**Files:**
- Create: `docs/tests/reservation-lookup-refunds.test.mjs`
- Create: `docs/supabase/functions/tests/reservation-manage-test.ts`

- [ ] Add Node tests that assert the booking page has an `Ai deja o rezervare?` lookup trigger, Supabase helper wrappers exist for reservation lookup/verification/manage/cancel functions, and the confirmation page exposes a manage/cancel/refund panel.
- [ ] Add Deno tests that assert refund eligibility is true when check-in is within seven days or the reservation was created less than two hours ago, false outside both windows, and token hashing is stable without storing plaintext codes.
- [ ] Run the new tests and verify they fail because the feature does not exist yet.

### Task 2: Database Migration

**Files:**
- Create: `docs/supabase/migrations/20260527182000_reservation_lookup_refunds.sql`

- [ ] Add `reservation_lookup_codes` for 4-digit SMS verification with code hash, attempts, expiry, phone, IP/user-agent metadata, and RLS enabled.
- [ ] Add `reservation_manage_tokens` for short-lived verified access by phone.
- [ ] Add `maib_refunds` as an idempotent refund audit table keyed by booking group/payment.
- [ ] Extend `notification_events.event_type` to include `reservation_lookup_code` if needed for audit-safe SMS tracking.

### Task 3: Shared Server Logic

**Files:**
- Create: `docs/supabase/functions/_shared/reservationManage.ts`

- [ ] Implement phone normalization, 4-digit code generation, SHA-256/HMAC-style code and token hashing using `ECOVILA_CRON_SECRET`, refund eligibility, reservation grouping, and guest-safe summary serialization.
- [ ] Export helpers used by all reservation management functions.

### Task 4: Edge Functions

**Files:**
- Create: `docs/supabase/functions/reservation-lookup-start/index.ts`
- Create: `docs/supabase/functions/reservation-lookup-verify/index.ts`
- Create: `docs/supabase/functions/reservation-manage-details/index.ts`
- Create: `docs/supabase/functions/reservation-cancel/index.ts`
- Modify: `docs/supabase/config.toml`

- [ ] `reservation-lookup-start`: accept phone, store a code, send SMS only when active reservations exist, and return generic success plus lookup id.
- [ ] `reservation-lookup-verify`: validate code, issue manage token, and return active reservation group summaries.
- [ ] `reservation-manage-details`: validate token and return full safe details for the chosen booking group.
- [ ] `reservation-cancel`: validate token, cancel the whole booking group, call MAIB refund for eligible paid card bookings, and record `maib_refunds` idempotently.
- [ ] Configure all four functions with `verify_jwt = true`.

### Task 5: Frontend

**Files:**
- Modify: `rezervari.html`
- Modify: `confirmare.html`
- Modify: `js/booking.js`
- Modify: `js/confirmare.js`
- Modify: `js/supabase.js`
- Modify: `js/translations.js`
- Modify: `css/booking.css`
- Modify: `css/confirmation.css`

- [ ] Replace the booking hero lead with a faint `Ai deja o rezervare?` trigger and modal.
- [ ] Add Supabase function wrappers for lookup start, verify, manage details, and cancel.
- [ ] On successful verification, route to `confirmare.html?id=<primaryReservationId>&manage=<token>`.
- [ ] On confirmation page manage mode, fetch server details, render summary, show refund eligibility copy, and allow group cancellation/refund.
- [ ] Keep existing cash timer/card polling behavior unchanged for normal checkout redirects.

### Task 6: Verification And Deploy

- [ ] Run focused Node and Deno tests.
- [ ] Run the full existing Node and Deno suites.
- [ ] Apply the migration to Supabase through MCP.
- [ ] Deploy all four new Edge Functions through MCP.
- [ ] Verify deployed functions are active and `verify_jwt = true`.
- [ ] Give TopHost upload instructions for changed static files.
