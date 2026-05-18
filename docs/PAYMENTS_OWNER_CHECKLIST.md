# Payments Owner Checklist

This document is for the EcoVila owner. It separates:

- what **you** own and must maintain
- what **Maib** must provide or configure
- what must be checked before payment launch

## The most important ownership rule

`maib-webhook` is **EcoVila-owned backend code**.

Even if Maib technicians help adapt it during integration, it lives in **your Supabase project**, uses **your secrets**, and updates **your reservation records**. Treat it as part of the EcoVila backend after launch.

Maib owns:

- their payment platform
- their exact payment-initiation requirements
- their callback payload requirements
- the values or credentials they issue to you

EcoVila owns:

- the website
- Supabase
- reservation creation
- the database
- the `maib-webhook` function
- long-term maintenance of the integration code inside this repository

## What you must implement or complete yourself

### 1. Deploy the updated public website to Tophost

Upload the current site files, including:

- `checkout.html`
- `js/checkout.js`
- `js/anulare.js`
- `js/translations.js`
- the full `payments/` folder

Why this matters:

- the checkout page now chooses the visible online payment rail from the phone number
- `+373...` shows MIA
- other valid international numbers show card payment
- `payments/maib/browser-adapter.js` is the live handoff point Maib technicians will work with

### 2. Redeploy the updated Supabase `create-reservation` Edge Function

The live database already accepts international phone numbers, but the Edge Function code must also be updated live.

Redeploy:

```text
create-reservation
```

Why this matters:

- without this redeploy, the website may accept foreign numbers visually
- but the old live function can still reject them server-side

### 3. Keep the EcoVila-owned webhook deployed and configured

The function:

```text
maib-webhook
```

must remain deployed in your Supabase project.

It is responsible for:

- receiving Maib payment callbacks
- checking the callback signature
- marking reservations as `paid` or `cancelled`
- sending payment confirmation notifications after approved payments

### 4. Add the Maib secret to Supabase when Maib provides it

Configure:

```text
MAIB_SIGNATURE_KEY
```

in Supabase Edge Function secrets.

Never place this secret in:

- browser JavaScript
- Tophost files
- screenshots
- shared documents
- this repository

### 5. Give Maib the files and contract they need

Send Maib technicians to:

```text
payments/maib/README.md
payments/maib/browser-adapter.js
```

The key contract they must honor:

```js
window.EcoVilaPayments.startCardPayment({
  primaryReservationId,
  bookingGroupId,
  reservationIds,
  totalPrice,
  selection,
  guestPhone,
  paymentRail,
})
```

Where:

- `paymentRail: "mia"` means MIA
- `paymentRail: "card"` means standard Visa/Mastercard
- `guestPhone` is already normalized
- EcoVila already decides the rail:
  - `+373...` → `mia`
  - anything else valid → `card`

### 6. Provide Maib with the webhook URL they must call

Maib must configure their callback to call the deployed Supabase function:

```text
maib-webhook
```

The exact production URL is the Supabase function URL for your project.

Maib must send callbacks matching the contract expected by the webhook:

```text
result.orderId
result.status
result.statusCode
signature
```

The reference examples are in:

```text
payments/maib/examples/
```

## What Maib must do from their side

Maib must:

1. complete the browser-side payment-start logic in `payments/maib/browser-adapter.js`
2. use the supplied `paymentRail` instead of guessing the payment method again
3. return the correct hosted payment URL:
   - MIA URL for `paymentRail: "mia"`
   - card URL for `paymentRail: "card"`
4. configure callbacks to your deployed `maib-webhook`
5. give you the real signature rules / secret material needed for production verification
6. test both approved and failed payment cases with you

## What is already done

As of 18 May 2026:

- checkout switches visibly between MIA and card based on guest phone number
- `+373` is prefilled in checkout and remains editable
- valid international phone numbers are supported in checkout
- cancellation flow supports international phone numbers
- the live database constraint has been widened to international phone numbers
- the `payments/` folder exists as the human-readable Maib integration area
- Maib handoff documentation exists in `payments/maib/README.md`

## Launch checklist

Before accepting live payments, confirm all of these:

- [ ] Updated frontend uploaded to Tophost
- [ ] `create-reservation` redeployed in Supabase
- [ ] `maib-webhook` deployed in Supabase
- [ ] `MAIB_SIGNATURE_KEY` configured in Supabase secrets
- [ ] Maib finished `payments/maib/browser-adapter.js`
- [ ] Maib callback URL points to your deployed `maib-webhook`
- [ ] `+373` test booking opens MIA
- [ ] foreign-number test booking opens card payment
- [ ] approved test payment marks reservation `paid`
- [ ] failed/cancelled test payment marks reservation `cancelled`
- [ ] approved test payment sends the expected confirmation notification

## If something breaks later

Check in this order:

1. Did the latest frontend files reach Tophost?
2. Is `create-reservation` running the current code?
3. Does checkout pass the expected `paymentRail`?
4. Does `browser-adapter.js` return a Maib-hosted URL?
5. Is Maib calling the correct webhook URL?
6. Does `MAIB_SIGNATURE_KEY` still match Maib's production setup?
7. Does the callback `orderId` match the booking group or reservation ID sent from EcoVila?

## Files worth remembering

### Public website / Tophost

- `checkout.html`
- `js/checkout.js`
- `js/anulare.js`
- `js/translations.js`
- `payments/maib/browser-adapter.js`

### Supabase / EcoVila backend

- `docs/supabase/functions/create-reservation/index.ts`
- `docs/supabase/functions/maib-webhook/index.ts`
- `docs/supabase/functions/_shared/reservations.ts`
- `docs/supabase/functions/_shared/maib.ts`
- `docs/supabase/migrations/20260518130000_international_guest_phones.sql`

### Human handoff docs

- `payments/README.md`
- `payments/maib/README.md`
- `payments/maib/examples/`

