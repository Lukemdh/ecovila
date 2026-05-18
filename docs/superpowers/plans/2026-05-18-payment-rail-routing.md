# Payment Rail Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route online checkout through MIA for normalized `+373` phone numbers and through standard card payments for other valid international phone numbers, while showing the chosen rail in checkout.

**Architecture:** EcoVila owns phone normalization, validation, and payment-rail selection in `js/checkout.js`. The checkout UI reflects the selected rail through translation-backed copy, and the Maib adapter receives `guestPhone` plus `paymentRail` so provider technicians can implement the correct redirect in `payments/maib/browser-adapter.js`.

**Tech Stack:** Vanilla HTML/CSS/JS, Node built-in test runner

---

## File Structure

- Modify `js/checkout.js` — support international phones, derive payment rail, pass rail context into the adapter, and update visible payment copy.
- Modify `checkout.html` — add hooks for dynamic online payment title/meta text if needed.
- Modify `js/translations.js` — add translated MIA/card online-payment strings and international-phone validation copy.
- Modify `payments/maib/README.md` — document the new `paymentRail` and `guestPhone` contract.
- Modify `js/anulare.js` — keep cancellation phone handling consistent with international checkout input.
- Modify `docs/supabase/functions/_shared/reservations.ts` — accept normalized international guest phones server-side.
- Create `docs/supabase/migrations/20260518130000_international_guest_phones.sql` — widen the persisted guest-phone constraint for deployed databases.
- Modify `docs/tests/checkout.test.mjs` — cover international phone handling, rail selection, and adapter context.
- Modify `docs/tests/anulare.test.mjs` — cover international cancellation-phone normalization.
- Modify `docs/tests/supabase-foundation.test.mjs` — protect the final international database constraint.
- Modify `docs/tests/edge-functions.test.mjs` — protect Maib README rail-contract documentation.
- Modify `docs/supabase/functions/tests/reservations-test.ts` — cover server-side acceptance of international phones.

### Task 1: Add failing tests for international phone support and rail selection

**Files:**
- Modify: `docs/tests/checkout.test.mjs`
- Modify: `docs/tests/edge-functions.test.mjs`

- [ ] **Step 1: Extend checkout translation assertions**

Require keys for:

```text
checkout.payMia
checkout.payMiaMeta
checkout.payCard
checkout.payCardMeta
checkout.errorPhone
```

- [ ] **Step 2: Extend guest validation tests**

Assert:

```js
checkout.normalizeInternationalPhone('  +40 721 234 567 ') === '+40721234567'
checkout.validateGuestDetails({ phone: '+40721234567', ... }).valid === true
checkout.validateGuestDetails({ phone: '0721234567', ... }).errors[0] === 'checkout.errorPhone'
```

- [ ] **Step 3: Add rail-selection tests**

Assert:

```js
checkout.getPaymentRail('+37360123456') === 'mia'
checkout.getPaymentRail('+40721234567') === 'card'
```

- [ ] **Step 4: Add adapter-context test**

Assert that `redirectAfterReservation()` calls `startCardPayment()` with:

```js
guestPhone: '+37360123456',
paymentRail: 'mia',
```

- [ ] **Step 5: Add documentation assertion**

Require the Maib README to mention `paymentRail`, `guestPhone`, `mia`, and `card`.

- [ ] **Step 6: Run focused tests and verify red**

Run:

```bash
node --test docs/tests/checkout.test.mjs docs/tests/edge-functions.test.mjs
```

Expected: FAIL because the new rail helpers, adapter context, and documentation are not implemented yet.

### Task 2: Implement rail-aware checkout behavior

**Files:**
- Modify: `js/checkout.js`
- Modify: `checkout.html`
- Modify: `js/translations.js`

- [ ] **Step 1: Replace Moldova-only phone handling**

Use:

```js
const INTERNATIONAL_PHONE_PATTERN = /^\+\d{8,15}$/;
```

and normalize by trimming spaces, dots, parentheses, and hyphens while preserving the leading `+`.

- [ ] **Step 2: Add rail helpers**

Implement:

```js
function getPaymentRail(phone) {
  return normalizeInternationalPhone(phone).startsWith('+373') ? 'mia' : 'card';
}
```

and a helper that returns the visible translation keys for the selected rail.

- [ ] **Step 3: Keep the UI visibly in sync**

Add dynamic title/meta hooks in `checkout.html` if needed and update them from `renderCheckout()` based on the current phone input.

- [ ] **Step 4: Pass rail context into Maib adapter**

Extend `redirectAfterReservation()` so the adapter receives:

```js
guestPhone,
paymentRail,
```

- [ ] **Step 5: Update translations**

Add Romanian, Russian, and English strings for:

```text
checkout.payMia
checkout.payMiaMeta
checkout.payCard
checkout.payCardMeta
checkout.errorPhone
```

with `checkout.errorPhone` describing a valid international format rather than only `+373XXXXXXXX`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test docs/tests/checkout.test.mjs
```

Expected: PASS.

### Task 3: Update Maib handoff documentation

**Files:**
- Modify: `payments/maib/README.md`

- [ ] **Step 1: Document the new rail contract**

Explain:

- EcoVila chooses the rail before calling Maib
- `paymentRail: "mia"` means MIA
- `paymentRail: "card"` means standard card
- `guestPhone` is normalized
- the current EcoVila rule is `+373 -> mia`, anything else valid -> `card`

- [ ] **Step 2: Run focused boundary tests**

Run:

```bash
node --test docs/tests/checkout.test.mjs docs/tests/edge-functions.test.mjs
```

Expected: PASS.

### Task 4: Keep reservation creation and cancellation lifecycle consistent

**Files:**
- Modify: `docs/supabase/functions/_shared/reservations.ts`
- Create: `docs/supabase/migrations/20260518130000_international_guest_phones.sql`
- Modify: `js/anulare.js`
- Modify: `docs/supabase/functions/tests/reservations-test.ts`
- Modify: `docs/tests/anulare.test.mjs`
- Modify: `docs/tests/supabase-foundation.test.mjs`

- [ ] **Step 1: Add failing server and cancellation tests**

Cover:

- server-side reservation rows preserve a normalized international phone number
- cancellation confirmation normalizes an international phone number
- final migration set allows `^\+[0-9]{8,15}$`

- [ ] **Step 2: Widen server-side reservation normalization**

Replace the Moldova-only public reservation validation with the same international format accepted by checkout.

- [ ] **Step 3: Widen the database constraint**

Add a migration that drops the old `reservations_guest_phone_check` and recreates it for `^\+[0-9]{8,15}$`.

- [ ] **Step 4: Widen cancellation normalization**

Normalize and validate the same international phone format on `anulare.html`.

- [ ] **Step 5: Run lifecycle-focused tests**

```bash
node --test docs/tests/anulare.test.mjs docs/tests/supabase-foundation.test.mjs
cd docs/supabase/functions && deno test --allow-env tests/reservations-test.ts
```

### Task 5: Verify the completed change

**Files:**
- Verify all files above

- [ ] **Step 1: Run focused tests**

```bash
node --test docs/tests/checkout.test.mjs docs/tests/edge-functions.test.mjs
```

- [ ] **Step 2: Run the full suite**

```bash
node --test docs/tests/*.test.mjs
```

- [ ] **Step 3: Inspect the targeted diff**

```bash
git diff -- js/checkout.js checkout.html js/translations.js payments/maib/README.md docs/tests/checkout.test.mjs docs/tests/edge-functions.test.mjs docs/superpowers/plans/2026-05-18-payment-rail-routing.md
```
