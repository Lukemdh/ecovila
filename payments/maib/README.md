# Maib ePay Integration Guide

This folder contains the EcoVila files you start with when integrating or maintaining Maib ePay card payments.

## What Maib ePay does in EcoVila

1. The guest completes the EcoVila checkout form and chooses **card payment**.
2. EcoVila creates pending reservation rows in Supabase.
3. The checkout flow calls the live browser hook in [`browser-adapter.js`](browser-adapter.js).
4. Maib should return a hosted payment URL from that hook so the browser can redirect the guest to Maib ePay.
5. After payment, Maib sends a server callback to EcoVila's Supabase webhook.
6. The webhook marks the reservation as `paid` for approved callbacks or `cancelled` for failed/cancelled callbacks.

## Files you may need

| File | Purpose | Type |
| --- | --- | --- |
| [`browser-adapter.js`](browser-adapter.js) | Live browser-side handoff from EcoVila checkout to Maib ePay | Live public JavaScript |
| [`examples/callback-approved.json`](examples/callback-approved.json) | Representative approved callback structure | Reference example |
| [`examples/callback-failed.json`](examples/callback-failed.json) | Representative failed callback structure | Reference example |
| [`../../docs/supabase/functions/maib-webhook/index.ts`](../../docs/supabase/functions/maib-webhook/index.ts) | Deployable server callback endpoint | Supabase Edge Function |
| [`../../docs/supabase/functions/_shared/maib.ts`](../../docs/supabase/functions/_shared/maib.ts) | Signature verification helper used by the webhook | Supabase shared module |

The full checkout and confirmation pages stay outside this folder because they also contain guest details, reservation summaries, shared UI, and cash-payment behavior that Maib does not own.

## Safe edit area

You may update:

- [`browser-adapter.js`](browser-adapter.js) when implementing or changing the browser redirect handoff
- Maib-specific callback assumptions only when coordinated with the EcoVila maintainer responsible for the Supabase webhook

Please do **not**:

- place `MAIB_SIGNATURE_KEY` or any other secret in browser JavaScript
- move shared booking logic into this folder
- edit unrelated booking, pricing, cash-payment, CRM, or translation logic unless the change was separately requested

## Browser contract

EcoVila checkout calls:

```js
window.EcoVilaPayments.startCardPayment({
  primaryReservationId,
  bookingGroupId,
  reservationIds,
  totalPrice,
  selection,
})
```

The adapter should return:

- a Maib-hosted payment URL when the redirect can begin, or
- an empty value when no Maib redirect URL is available yet

When the adapter returns an empty value, EcoVila keeps its existing safe fallback and opens:

```text
confirmare.html?id=<primaryReservationId>
```

`bookingGroupId` is the preferred order identifier for multi-room bookings. The webhook also accepts a single reservation ID as fallback.

## Server callback

### Deployable endpoint

The live webhook entrypoint is:

```text
docs/supabase/functions/maib-webhook/index.ts
```

This path remains in the Supabase function tree because Supabase deployment expects that layout.

### Required secret

```text
MAIB_SIGNATURE_KEY
```

This secret must be configured in the Supabase Edge Function environment

### Expected callback fields

The webhook currently reads:

```text
result.orderId
result.status
result.statusCode
signature
```

Use the files in [`examples/`](examples/) as reference structures only. Their signatures are placeholders, not valid production signatures.

### Outcome rules

- Approved callback: `result.status === "OK"` and `result.statusCode === "000"`  
  The webhook marks the matching reservation rows as `paid` and sends confirmation notifications.
- Failed or cancelled callback: any other status combination  
  The webhook marks the matching reservation rows as `cancelled`.

## End-to-end verification checklist

### Approved payment

1. Create a test booking with card payment.
2. Confirm `browser-adapter.js` receives `bookingGroupId`, reservation IDs, and total price.
3. Redirect the browser to the Maib-hosted payment page.
4. Complete an approved Maib payment.
5. Confirm the callback reaches the webhook with an `orderId` matching the booking group or reservation ID.
6. Confirm signature verification passes.
7. Confirm the reservation becomes `paid`.
8. Confirm the guest reaches the expected post-payment state and receives the confirmation notification.

### Failed or cancelled payment

1. Create another test booking with card payment.
2. Complete a failed or cancelled Maib payment.
3. Confirm the callback reaches the webhook with the expected order ID.
4. Confirm signature verification passes.
5. Confirm the reservation becomes `cancelled`.
6. Confirm no paid confirmation is sent.

## If something breaks later

Check in this order:

1. Does checkout still load [`browser-adapter.js`](browser-adapter.js)?
2. Does `startCardPayment()` return the expected Maib URL?
3. Does Maib send a callback that matches the expected example shape?
4. Does the callback use the same order ID EcoVila sent to Maib?
5. Does `MAIB_SIGNATURE_KEY` match the Maib environment?
6. Does the webhook response show `paid`, `cancelled`, or a signature/order-ID error?
