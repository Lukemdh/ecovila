# Payments Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a live `payments/` module that gives Maib technicians a clear integration surface while preserving the existing booking and Supabase deployment boundaries.

**Architecture:** Keep the broad booking flow in its current files, add a focused browser-side Maib adapter under `payments/maib/`, and document the external integration contract from that folder. The Supabase webhook remains at its deployable path, but the new payment docs point to it explicitly and tests protect the boundary.

**Tech Stack:** Vanilla HTML/CSS/JS, Node built-in test runner, Supabase Edge Functions (Deno/TypeScript)

---

## File Structure

- Create `payments/README.md` — top-level human orientation for payment providers and maintainers.
- Create `payments/maib/README.md` — technician-facing Maib integration guide.
- Create `payments/maib/browser-adapter.js` — live browser-side Maib contract exposed as `window.EcoVilaPayments`.
- Create `payments/maib/examples/callback-approved.json` — representative approved callback example.
- Create `payments/maib/examples/callback-failed.json` — representative failed callback example.
- Modify `checkout.html` — load the live Maib adapter before `js/checkout.js`.
- Modify `tests/checkout.test.mjs` — assert checkout loads the live adapter.
- Modify `tests/edge-functions.test.mjs` — assert the payment module docs/examples/boundary exist and stay secret-safe.

### Task 1: Describe the live payment boundary with failing tests

**Files:**
- Modify: `tests/checkout.test.mjs`
- Modify: `tests/edge-functions.test.mjs`

- [ ] **Step 1: Write the failing checkout test**

Add `payments/maib/browser-adapter.js` to the list of scripts that `checkout.html` must load, before `js/checkout.js`.

- [ ] **Step 2: Write the failing payment-module boundary test**

Add assertions that:

```js
for (const file of [
  'payments/README.md',
  'payments/maib/README.md',
  'payments/maib/browser-adapter.js',
  'payments/maib/examples/callback-approved.json',
  'payments/maib/examples/callback-failed.json',
]) {
  assert.ok(exists(file), `${file} should exist`);
}
```

Also assert that:

- the adapter exposes `startCardPayment`
- the Maib README mentions `browser-adapter.js`
- the Maib README mentions `supabase/functions/maib-webhook/index.ts`
- both example payloads include `result.orderId`, `result.status`, `result.statusCode`, and `signature`

- [ ] **Step 3: Run the focused tests to verify they fail**

Run:

```bash
node --test tests/checkout.test.mjs tests/edge-functions.test.mjs
```

Expected: FAIL because the new `payments/` files do not exist yet and `checkout.html` does not yet load the adapter.

### Task 2: Add the live Maib module and technician docs

**Files:**
- Create: `payments/README.md`
- Create: `payments/maib/README.md`
- Create: `payments/maib/browser-adapter.js`
- Create: `payments/maib/examples/callback-approved.json`
- Create: `payments/maib/examples/callback-failed.json`

- [ ] **Step 1: Create the top-level payment README**

Document:

- what the folder owns
- which provider is currently present
- the intended first inspection path
- which files are live code vs examples/docs

- [ ] **Step 2: Create the Maib technician README**

Document:

- the EcoVila card-payment flow
- files Maib technicians may need
- what they may safely edit
- the browser contract
- the webhook path
- required environment variable `MAIB_SIGNATURE_KEY`
- approved/failed callback outcomes
- one approved and one failed end-to-end test checklist
- explicit guardrails against secrets in browser code and unrelated booking edits

- [ ] **Step 3: Create the minimal browser adapter**

Implement a UMD-style browser module that:

```js
root.EcoVilaPayments = {
  startCardPayment,
};
```

and whose initial `startCardPayment()` implementation returns an empty string so checkout preserves the existing fallback to `confirmare.html?id=<reservation-id>` until Maib provides the real redirect logic.

- [ ] **Step 4: Add representative callback examples**

Create:

```json
{
  "result": {
    "orderId": "11111111-1111-4111-8111-111111111111",
    "status": "OK",
    "statusCode": "000"
  },
  "signature": "example-signature-from-maib"
}
```

and:

```json
{
  "result": {
    "orderId": "11111111-1111-4111-8111-111111111111",
    "status": "FAILED",
    "statusCode": "100"
  },
  "signature": "example-signature-from-maib"
}
```

- [ ] **Step 5: Run the focused tests**

Run:

```bash
node --test tests/checkout.test.mjs tests/edge-functions.test.mjs
```

Expected: checkout test still fails until the HTML loads the adapter; payment-module existence assertions pass.

### Task 3: Wire checkout to the live adapter

**Files:**
- Modify: `checkout.html`

- [ ] **Step 1: Add the live adapter script**

Load:

```html
<script src="payments/maib/browser-adapter.js"></script>
```

after shared project dependencies and before:

```html
<script src="js/checkout.js"></script>
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
node --test tests/checkout.test.mjs tests/edge-functions.test.mjs
```

Expected: PASS.

### Task 4: Verify the completed refactor

**Files:**
- Verify all files above

- [ ] **Step 1: Run the payment-related test set**

Run:

```bash
node --test tests/checkout.test.mjs tests/edge-functions.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run the full browser-side repository test suite**

Run:

```bash
node --test tests/*.test.mjs
```

Expected: PASS, or record any unrelated pre-existing failures before completion.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff -- payments checkout.html tests/checkout.test.mjs tests/edge-functions.test.mjs docs/superpowers/plans/2026-05-18-payments-module.md
```

Expected: only the intended payment-module files and tests are included in the task diff.
