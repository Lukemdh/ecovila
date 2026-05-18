# Payments

This folder is the live home for EcoVila payment integrations.

Start here whenever:

- a payment provider is being connected or changed
- a card payment redirect stops working
- a future maintainer needs to understand what Maib owns versus what belongs to the wider booking system

## Current providers

| Provider | Purpose | Start here |
| --- | --- | --- |
| Maib ePay | Redirect-based card payments | [`maib/README.md`](maib/README.md) |

## What this folder owns

- provider-specific browser integration code
- provider-specific technician documentation
- sample callback payloads and integration examples

## What this folder does not own

- the full checkout page
- the full confirmation page
- cash-payment behavior
- reservation pricing, room selection, CRM, or shared public-site styling

Those remain part of the wider booking system because they are not owned by a payment provider.

## First inspection path for card-payment issues

1. Read [`maib/README.md`](maib/README.md).
2. Check the live browser adapter at [`maib/browser-adapter.js`](maib/browser-adapter.js).
3. Check the deployable webhook entrypoint linked from the Maib guide.
4. Compare the received callback with the example payloads in [`maib/examples/`](maib/examples/).

## File types in this folder

- **Live code:** JavaScript that the public site actually loads in production.
- **Documentation:** Markdown files written for maintainers and provider technicians.
- **Examples:** Non-secret reference payloads used to explain and test the integration contract.

There is currently no Maib-owned HTML or CSS file because the provider integration does not own a separate page layout or visual layer. If Maib later needs provider-specific UI, add only that provider-owned asset here instead of moving shared checkout files into this folder.
