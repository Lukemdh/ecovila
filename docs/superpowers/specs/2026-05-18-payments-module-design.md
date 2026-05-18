# Payments Module Design

## Purpose

Create a durable, human-readable `payments/` area that becomes the live source of truth for EcoVila's payment integration surface, beginning with Maib ePay. The folder should make it obvious where an external technician starts, what they may safely change, and which surrounding files remain part of the wider booking system.

This is not a cosmetic reorganization. The goal is to reduce long-term drift and make future payment failures easier to diagnose.

## Current Context

The project is a vanilla HTML/CSS/JS booking platform with Supabase Edge Functions for server-side behavior. Maib ePay is a redirect-based card payment integration that will be completed by Maib's own technicians.

Today, payment behavior is spread across:

- `checkout.html` and `js/checkout.js` for payment selection and redirect behavior
- `confirmare.html` and `js/confirmare.js` for post-payment reservation state
- `docs/supabase/functions/maib-webhook/index.ts` for the provider callback
- `docs/supabase/functions/_shared/maib.ts` for signature verification helpers
- `js/translations.js` for public payment copy

The existing checkout code already has a useful seam:

```js
window.EcoVilaPayments.startCardPayment(...)
```

That seam should become the stable browser-side contract between the booking flow and the payment module.

## Design Decision

`payments/` will be the canonical home for live payment integration code and technician-facing documentation, but it will not become a dumping ground for every file that mentions payment.

Recommended structure:

```text
payments/
  README.md
  maib/
    README.md
    browser-adapter.js
    examples/
      callback-approved.json
      callback-failed.json
```

The live checkout page will load `payments/maib/browser-adapter.js`, and the rest of the site will interact with Maib only through the narrow `window.EcoVilaPayments` browser contract.

## Ownership Boundary

### Owned by `payments/`

- Live Maib browser-side integration code
- Plain-English payment integration documentation
- Sample callback payloads and expected statuses
- Instructions for Maib technicians: what to edit, what not to edit, required configuration, and an end-to-end verification checklist
- A clear map to the server-side webhook and its required secrets

### Kept outside `payments/`

- Full checkout page layout and guest form behavior
- Full confirmation page layout and cash-payment behavior
- Shared booking summary UI
- Shared translations used across the public site
- Broader booking, pricing, CRM, and reservation lifecycle logic

Those files remain outside the module because they are not owned by Maib and would become harder to maintain if moved only because they contain payment-related branches.

## Browser Integration Contract

The first live module is `payments/maib/browser-adapter.js`.

It must expose:

```js
window.EcoVilaPayments.startCardPayment({
  primaryReservationId,
  bookingGroupId,
  reservationIds,
  totalPrice,
  selection,
})
```

Expected behavior:

1. The adapter receives reservation context after EcoVila creates pending reservation rows.
2. If Maib provides a payment URL, the adapter returns that URL.
3. If no URL is returned, existing checkout behavior falls back to `confirmare.html?id=<reservation-id>`.
4. Secrets must never be placed in browser code.

The adapter should be the only place a Maib technician needs to change browser-side payment launch logic.

## Server-Side Integration Boundary

The deployable Supabase entrypoint remains:

```text
docs/supabase/functions/maib-webhook/index.ts
```

This file stays in the Supabase function tree because deployment expects that layout. The `payments/maib/README.md` must link to it prominently and explain:

- callback URL configuration
- expected success/failure payload shape
- signature verification dependency
- required secret: `MAIB_SIGNATURE_KEY`
- result of approved callbacks: reservation status changes to `paid`
- result of failed/cancelled callbacks: reservation status changes to `cancelled`

If a later implementation safely extracts reusable Maib-specific server logic without weakening deployment clarity, the webhook entrypoint may become a thin wrapper. For this refactor, deployment safety takes priority over forcing every Maib line into the new folder.

## Technician Documentation

`payments/README.md` should answer:

- what this folder is for
- which provider is currently integrated
- where to start
- which files are live code versus references/examples

`payments/maib/README.md` should answer:

- what Maib ePay does in EcoVila
- the exact files Maib technicians may need
- the browser contract they receive from checkout
- the webhook callback path and required environment variable
- success and failure flow expectations
- a short verification checklist covering one approved and one failed/cancelled payment
- explicit guardrails, including not placing secrets in public JS and not editing unrelated booking logic

The documentation should be written for a competent IT technician who has not previously worked on this codebase.

## Example Payloads

`payments/maib/examples/` should contain representative approved and failed callback JSON files using the same field names consumed by the webhook:

- `result.orderId`
- `result.status`
- `result.statusCode`
- `signature`

The examples are reference fixtures for humans and tests; they do not contain real secrets.

## Error Handling and Maintenance

When card payments fail after future technician changes, the intended first inspection path is:

1. `payments/README.md`
2. `payments/maib/README.md`
3. `payments/maib/browser-adapter.js`
4. linked webhook entrypoint and callback examples

This path should let a maintainer answer quickly:

- did checkout call the provider adapter?
- did the provider return a redirect URL?
- did Maib send a callback with an expected order ID and status?
- did signature verification pass?
- did the webhook update the reservation state?

The folder is successful only if this path is clearer than searching the whole repository for `maib`, `payment`, and `checkout`.

## Testing Strategy

Add automated coverage for the boundary itself:

- `checkout.html` loads the live Maib adapter from `payments/`
- `browser-adapter.js` exposes `window.EcoVilaPayments.startCardPayment`
- documentation files exist and point technicians to the live files and webhook entrypoint
- callback example files use the same fields expected by the webhook
- browser-facing files still do not contain `MAIB_SIGNATURE_KEY` or other server secrets

Existing checkout and Edge Function tests continue to protect reservation creation and webhook behavior.

## Non-Goals

- Rewriting the whole checkout or confirmation page
- Moving every payment-adjacent file into `payments/`
- Implementing Maib's final production protocol before Maib supplies it
- Changing cash-payment behavior
- Changing Supabase deployment layout purely for folder aesthetics

## Expected Outcome

After the refactor:

- Maib technicians have one obvious folder to begin from
- the live browser-side integration no longer hides inside unrelated checkout code
- the payment module has a documented contract and examples
- future maintainers can trace payment failures through a short, explicit path
- deployment remains stable because Supabase-specific entrypoints stay where the platform expects them
