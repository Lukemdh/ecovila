# Payment Rail Routing Design

## Purpose

Add automatic online-payment rail selection so EcoVila uses the cheaper MIA path for guests with Moldovan phone numbers and falls back to standard card payments for guests with other international phone numbers.

## Current Context

Checkout currently:

- pre-fills the phone field with `+373`
- validates only Moldovan phone numbers
- exposes one generic card-payment option
- passes reservation context to `window.EcoVilaPayments.startCardPayment(...)`

Maib now offers two relevant online-payment rails for EcoVila:

- **MIA** for Moldovan-number guests
- **card** for guests who should use Visa/Mastercard

The payment module created in `payments/maib/` is the correct provider boundary for the handoff, but EcoVila should decide the intended rail before calling Maib.

## Design Decision

EcoVila checkout will choose the online payment rail from the normalized guest phone number:

```text
+373...  -> mia
anything else valid internationally -> card
```

This is an EcoVila routing rule. Maib's implementation receives the chosen rail and should honor it rather than re-deriving the decision.

## Guest Experience

- The phone input remains pre-filled with `+373`.
- The prefix is editable and deletable.
- Checkout accepts international phone numbers in a practical E.164-style format: `+` followed by 8 to 15 digits.
- The visible online-payment option updates while the guest types:
  - Moldovan number: **Plată online prin MIA**
  - other valid international number: **Plată online cu cardul**
- Cash remains the second payment option and is unchanged.
- If the number is still incomplete while the guest is typing, the UI keeps the local/default assumption from the current field value until final validation.

## Reservation Lifecycle Consistency

International phone support must remain consistent after checkout:

- Supabase reservation creation must accept the same normalized international format.
- The database guest-phone constraint must allow the same format.
- Token-based cancellation must normalize and validate the same international format, so a foreign guest can still cancel a paid reservation using the phone number originally entered at checkout.

## Browser Contract

When checkout calls the live Maib adapter, it now provides:

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

- `guestPhone` is the normalized phone number
- `paymentRail` is exactly `'mia'` or `'card'`

## Ownership Boundary

### EcoVila owns

- phone normalization and validation
- the `+373` routing rule
- the visible checkout label that reflects the chosen rail

### Maib owns

- turning `paymentRail: 'mia'` into the correct MIA redirect
- turning `paymentRail: 'card'` into the correct Visa/Mastercard redirect
- the provider-specific redirect implementation inside `payments/maib/browser-adapter.js`

## Documentation

`payments/maib/README.md` should explain:

- EcoVila decides the rail before calling Maib
- `paymentRail: "mia"` means the adapter should initiate MIA
- `paymentRail: "card"` means the adapter should initiate the standard card flow
- `+373` is the current EcoVila routing rule

## Testing Strategy

Add coverage for:

- international phone normalization and validation
- `+373` resolving to `mia`
- a valid non-Moldovan number resolving to `card`
- checkout labels for both visible rails
- the adapter context receiving `guestPhone` and `paymentRail`
- Maib documentation describing the rail contract
- Supabase reservation creation accepting normalized international numbers
- database constraints allowing normalized international numbers
- cancellation confirmation accepting normalized international numbers

## Non-Goals

- Letting the guest manually choose between MIA and card
- Changing cash-payment behavior
- Implementing Maib's final MIA or Visa/Mastercard redirect details before Maib supplies them
- Inferring eligibility from anything beyond the phone-number rule chosen by EcoVila
